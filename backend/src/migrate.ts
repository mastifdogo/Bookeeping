// Migrating from other bookkeeping software (QuickBooks, Xero, Wave, Sage,
// FreshBooks, spreadsheets, ...): the user uploads an export, Ledger works
// out what it is (an LLM through Settings → LLM API, or header rules when
// none is set up) and how its columns map to Ledger's, shows a preview the
// user can correct, and imports only when the user says so, all or nothing.
//
//   accounts        a chart of accounts            → accounts
//   general_ledger  transactions / journal lines   → accounts it needs + journal entries
//   trial_balance   balances per account           → accounts it needs + one opening entry
//   customers       a customer list                → handed to a module that accepts "customer" files
//   vendors         a vendor / supplier list       → handed to a module that accepts "vendor" files
//
// Uploads are kept in memory for a couple of hours, per organization and user.

import { createHash, randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { queryRow, queryRows, withTx } from "./db.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { MAX_FILE_BYTES, decodeUTF8, stripBOM } from "./files.ts";
import { checkLinesPostable, insertJournalEntries, lockAccounts, lineCodes, validateEntry, type FieldNames } from "./ledger.ts";
import { llmComplete, pickConnection, readLlmConfig } from "./llm.ts";
import { log } from "./log.ts";
import { MAX_CENTS } from "./money.ts";
import { fileTargets, filesFor } from "./module-files.ts";
import { currentOrg } from "./orgs.ts";
import { ACCOUNT_CODE_RE, ACCOUNT_TYPES, isAccountType, isCurrency, type AccountType, type Currency, type JournalEntryCreate } from "./types.ts";

export const MIGRATION_KINDS = ["accounts", "general_ledger", "trial_balance", "customers", "vendors"] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

/** The columns each kind uses; the first group of each is required. */
export const KIND_FIELDS: Record<MigrationKind, readonly string[]> = {
	accounts: ["name", "code", "type", "description", "currency"],
	general_ledger: ["date", "account", "debit", "credit", "amount", "entry_id", "description", "reference", "memo", "currency"],
	trial_balance: ["account", "debit", "credit", "balance"],
	customers: ["name", "email", "phone"],
	vendors: ["name", "email", "phone"],
};
const ALL_FIELDS = [...new Set(Object.values(KIND_FIELDS).flat())];
const DATE_FORMATS = ["ymd", "mdy", "dmy"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

const MAX_ROWS = 50_000;
const MAX_UPLOADS = 20;
const UPLOAD_TTL_MS = 2 * 3600_000;
const OPENING_EQUITY = { code: "3900", name: "Opening balance equity" };

export interface AccountChoice {
	/** create: a new account; map: post to an existing one (code); skip: leave the row out (accounts files only). */
	action: "create" | "map" | "skip";
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
}

export interface Mapping {
	kind: MigrationKind;
	/** Ledger field → the file's column name (null: not in the file). */
	columns: Record<string, string | null>;
	/** Which of the first rows holds the column names (0-based); reports often start with a title. */
	header_row: number;
	/** "General ledger" reports that list each account as a heading row, its lines below. */
	account_from_sections: boolean;
	date_format: DateFormat;
	decimal_comma: boolean;
	/** For new accounts and files without currencies. */
	currency: Currency;
	/** trial_balance: the date of the opening entry. */
	as_of: string;
	/** Per account name in the file: what to do with it (missing ones use the suggestion). */
	accounts: Record<string, Partial<AccountChoice>>;
}

export interface Detection {
	kind: MigrationKind;
	confidence: number;
	summary: string;
	software: string;
	/** "ai" or "rules". */
	source: "ai" | "rules";
	/** Why the AI wasn't used (not set up, failed). */
	note: string;
}

interface Upload {
	id: string;
	org: number;
	user: number;
	filename: string;
	sha256: string;
	data: Buffer;
	/** Every row of the file, cells trimmed. */
	rows: string[][];
	detection: Detection;
	mapping: Mapping;
	/** Account types the AI suggested, by label or type value (lowercase). */
	aiTypes: Map<string, { type: AccountType; code: string | null }>;
	created: number;
}

const uploads = new Map<string, Upload>();

function bad(field: string, message: string): never {
	const v = new ValidationError();
	v.add(field, message);
	throw v;
}

function sweep(): void {
	const now = Date.now();
	for (const [id, u] of uploads) if (now - u.created > UPLOAD_TTL_MS) uploads.delete(id);
	while (uploads.size > MAX_UPLOADS) uploads.delete(uploads.keys().next().value!);
}

export function getUpload(id: string, user: number): Upload {
	sweep();
	const u = uploads.get(id);
	if (!u || u.user !== user || u.org !== currentOrg().id) throw new NotFoundError();
	return u;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** Text from UTF-8, or Windows-1252 (what older Windows software exports). */
export function decodeText(raw: Buffer): string {
	const body = stripBOM(raw);
	const utf8 = decodeUTF8(body);
	if (utf8 !== null) return utf8;
	return new TextDecoder("windows-1252").decode(body);
}

/** The delimiter the first lines use most: comma, semicolon, tab or bar. */
function detectDelimiter(text: string): string {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 20);
	let best = ",";
	let bestScore = -1;
	for (const d of [",", ";", "\t", "|"]) {
		const counts = lines.map((l) => l.replace(/"[^"]*"/g, "").split(d).length - 1);
		const score = counts.reduce((a, b) => a + b, 0) + (counts.every((c) => c === counts[0] && c > 0) ? 50 : 0);
		if (score > bestScore) [best, bestScore] = [d, score];
	}
	return best;
}

/** A forgiving delimited-text reader: quoted fields, doubled quotes, ragged rows. */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endField = () => {
		row.push(field.trim());
		field = "";
	};
	const endRow = () => {
		endField();
		if (row.some((c) => c !== "")) rows.push(row);
		row = [];
		if (rows.length > MAX_ROWS + 50) bad("file", `has more than ${MAX_ROWS} rows; split it`);
	};
	while (i < text.length) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field.trim() === "") {
			quoted = true;
			field = "";
		} else if (ch === delimiter) endField();
		else if (ch === "\n") endRow();
		else if (ch !== "\r") field += ch;
		i++;
	}
	if (field !== "" || row.length > 0) endRow();
	return rows;
}

/** The likeliest header row among the first ones: the first that is (nearly) as wide as the widest. */
export function guessHeaderRow(rows: string[][]): number {
	const head = rows.slice(0, 15);
	const filled = head.map((r) => r.filter((c) => c !== "").length);
	const max = Math.max(0, ...filled);
	const i = filled.findIndex((n) => n >= Math.max(2, Math.ceil(max * 0.8)));
	return i < 0 ? 0 : i;
}

function headersOf(u: Pick<Upload, "rows">, m: Pick<Mapping, "header_row">): string[] {
	const raw = u.rows[m.header_row] ?? [];
	const seen = new Map<string, number>();
	return raw.map((h, i) => {
		const name = h || `Column ${i + 1}`;
		const n = (seen.get(name) ?? 0) + 1;
		seen.set(name, n);
		return n > 1 ? `${name} (${n})` : name;
	});
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function ymd(y: number, m: number, d: number): string | null {
	if (y < 100) y += y < 70 ? 2000 : 1900;
	if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
	const dt = new Date(Date.UTC(y, m - 1, d));
	if (dt.getUTCMonth() !== m - 1) return null;
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A date in the file's format (or ISO, or with a month name) as YYYY-MM-DD; null if it isn't one. */
export function parseLooseDate(s: string, fmt: DateFormat): string | null {
	const v = s.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, "");
	let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
	if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
	m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(v);
	if (m) return fmt === "dmy" ? ymd(+m[3]!, +m[2]!, +m[1]!) : ymd(+m[3]!, +m[1]!, +m[2]!);
	m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(v); // Jan 5, 2026
	if (m && MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) >= 0) return ymd(+m[3]!, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, +m[2]!);
	m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{2}|\d{4})$/.exec(v); // 5 Jan 2026, 05-Jan-26
	if (m && MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) >= 0) return ymd(+m[3]!, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, +m[1]!);
	return null;
}

/** An amount like "1,234.56", "$(12.00)", "-45", "45-", "1.234,56" (decimal comma) as signed cents; null if empty. */
export function parseMoney(s: string, decimalComma: boolean): bigint | null {
	let v = s.trim();
	if (v === "" || v === "-" || v === "—") return null;
	let neg = false;
	if (/^\(.*\)$/.test(v)) {
		neg = true;
		v = v.slice(1, -1);
	}
	v = v.replace(/\b(CAD|USD|CA|US|C|EUR|GBP)\b|[$€£¥\s]/gi, "");
	if (v.startsWith("-")) {
		neg = !neg;
		v = v.slice(1);
	} else if (v.endsWith("-")) {
		neg = !neg;
		v = v.slice(0, -1);
	} else if (v.startsWith("+")) v = v.slice(1);
	if (/\s?(CR)$/i.test(v)) {
		neg = !neg;
		v = v.replace(/CR$/i, "");
	}
	v = v.replace(/DR$/i, "");
	if (decimalComma) v = v.replace(/\./g, "").replace(",", ".");
	else v = v.replace(/,/g, "");
	const m = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(v);
	if (!m) throw new Error(`"${s}" is not an amount`);
	const cents = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
	if (cents > MAX_CENTS) throw new Error(`"${s}" is too large`);
	return neg ? -cents : cents;
}

/** An account type from words other software uses ("Bank", "Other Current Liability", "Cost of Goods Sold", "Income"…). */
export function inferType(s: string): AccountType | null {
	const v = s.toLowerCase();
	if (!v.trim()) return null;
	if (isAccountType(v.trim())) return v.trim() as AccountType;
	// Whole words only ("current" is not "rent").
	const any = (words: string) => new RegExp(`\\b(${words})`).test(v);
	if (any("payable|liabilit|credit card|loan|mortgage|line of credit|accrued|deferred revenue|unearned|gst|hst|pst|vat|sales tax|payroll liab|withholding")) return "liability";
	if (any("equity|capital|retained|drawing|owner|shareholder|dividend|opening bal")) return "equity";
	if (any("cost of (goods|sales)|cogs|expense|overhead|depreciation|amortization|fees\\b|rent\\b|wages|salar|utilities|insurance|supplies|advertising|travel|meals|bank charge|interest exp|office|repairs|telephone|software|subscription|direct cost")) return "expense";
	if (any("income|revenue|sales|fees earned|interest earned|discounts received")) return "revenue";
	if (any("bank|cash|chequing|checking|savings|receivable|inventory|prepaid|asset|equipment|vehicle|furniture|building|land\\b|deposit|undeposited|petty|investment|computer")) return "asset";
	return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// Detecting what the file is
// ---------------------------------------------------------------------------

/** Header words per field, for the rules (and to check the AI). */
const SYNONYMS: Record<string, string[]> = {
	date: ["date", "transaction date", "txn date", "posting date", "entry date", "trans date", "posted"],
	account: ["account", "account name", "account full name", "gl account", "ledger account", "account title", "category", "distribution account"],
	debit: ["debit", "debits", "dr", "debit amount", "debit cad", "debit usd"],
	credit: ["credit", "credits", "cr", "credit amount", "credit cad", "credit usd"],
	amount: ["amount", "net amount", "value", "total", "net"],
	entry_id: ["transaction id", "trans id", "txn id", "entry id", "journal no", "journal number", "journal id", "num", "no", "number", "entry no", "transaction no", "batch", "voucher"],
	description: ["description", "memo description", "transaction description", "details", "particulars", "narration", "payee", "name"],
	reference: ["reference", "ref", "ref no", "check no", "cheque no", "document", "doc no", "invoice"],
	memo: ["memo", "line memo", "notes", "note", "line description", "comment"],
	currency: ["currency", "curr", "ccy", "currency code"],
	code: ["code", "account code", "account number", "account no", "number", "no", "acct", "acct no", "gl code"],
	name: ["name", "account name", "account", "customer", "customer name", "vendor", "vendor name", "supplier", "supplier name", "display name", "company", "company name", "full name"],
	type: ["type", "account type", "class", "category", "classification", "detail type"],
	balance: ["balance", "ending balance", "closing balance", "net balance", "amount"],
	email: ["email", "e mail", "email address"],
	phone: ["phone", "telephone", "phone number", "mobile"],
};

function findColumn(headers: string[], field: string, taken: Set<string>): string | null {
	const syn = SYNONYMS[field] ?? [field];
	// Exact names first, in the order of preference; then names that contain one.
	for (const sname of syn) for (const h of headers) if (!taken.has(h) && norm(h) === sname) return h;
	for (const sname of syn) for (const h of headers) if (!taken.has(h) && sname.length > 3 && norm(h).includes(sname)) return h;
	return null;
}

function mapColumns(headers: string[], kind: MigrationKind): Record<string, string | null> {
	const taken = new Set<string>();
	const out: Record<string, string | null> = {};
	for (const f of KIND_FIELDS[kind]) {
		const h = findColumn(headers, f, taken);
		out[f] = h;
		if (h) taken.add(h);
	}
	return out;
}

/** What the header row says the file is, without AI. */
function detectByRules(filename: string, headers: string[], rows: string[][]): { kind: MigrationKind; confidence: number; summary: string } {
	const h = headers.map(norm);
	const has = (...words: string[]) => words.some((w) => h.some((x) => x === w || x.includes(w)));
	const f = norm(filename);
	const sectioned = rows.filter((r) => r.filter((c) => c !== "").length === 1).length > rows.length * 0.05;
	if (/vendor|supplier/.test(f) || has("vendor", "supplier")) return { kind: "vendors", confidence: 0.6, summary: "A list of vendors (judged from the column names)." };
	if (/customer|client/.test(f) || (has("customer", "client") && !has("debit", "credit", "account"))) return { kind: "customers", confidence: 0.6, summary: "A list of customers (judged from the column names)." };
	if (has("date") && (has("debit", "credit") || has("amount")) && (has("account") || sectioned)) {
		return { kind: "general_ledger", confidence: 0.65, summary: "Transactions with dates, accounts and amounts (judged from the column names)." };
	}
	if (/trial balance/.test(f) || (has("account") && has("debit", "credit", "balance") && !has("date"))) {
		return { kind: "trial_balance", confidence: 0.55, summary: "Balances per account (judged from the column names)." };
	}
	if (/chart|accounts|coa/.test(f) || (has("account", "name") && has("type", "class"))) return { kind: "accounts", confidence: 0.55, summary: "A chart of accounts (judged from the column names)." };
	return { kind: "general_ledger", confidence: 0.2, summary: "Couldn't tell what this file is from its columns; choose the kind below." };
}

function defaultMapping(u: Pick<Upload, "rows" | "filename">, headerRow: number): Mapping {
	const m: Mapping = {
		kind: "general_ledger",
		columns: {},
		header_row: headerRow,
		account_from_sections: false,
		date_format: "mdy",
		decimal_comma: false,
		currency: "CAD",
		as_of: new Date().toISOString().slice(0, 10),
		accounts: {},
	};
	const headers = headersOf(u, m);
	const data = u.rows.slice(headerRow + 1);
	const d = detectByRules(u.filename, headers, data);
	m.kind = d.kind;
	m.columns = mapColumns(headers, d.kind);
	// Reports grouped by account: the account is a heading row, and its column (if any) is empty on the lines.
	if (d.kind === "general_ledger" && data.some((r) => r.filter((c) => c !== "").length === 1)) {
		const acc = m.columns.account ? headers.indexOf(m.columns.account) : -1;
		const amountCols = ["debit", "credit", "amount"].map((f) => (m.columns[f] ? headers.indexOf(m.columns[f]!) : -1)).filter((i) => i >= 0);
		const isTotal = (r: string[]) => /^(total|grand total)\b/i.test(r.find((c) => c !== "") ?? "");
		const lines = data.filter((r) => !isTotal(r) && r.filter((c) => c !== "").length > 1 && amountCols.some((i) => (r[i] ?? "") !== ""));
		if (acc < 0 || lines.filter((r) => (r[acc] ?? "") === "").length > lines.length * 0.8) {
			m.account_from_sections = true;
			m.columns.account = null;
		}
	}
	// Day first if any date's first number can't be a month.
	const dateCol = m.columns.date ? headers.indexOf(m.columns.date) : -1;
	if (dateCol >= 0 && data.some((r) => /^(1[3-9]|2\d|3[01])[/.-]\d{1,2}[/.-]\d{2,4}$/.test(r[dateCol] ?? ""))) m.date_format = "dmy";
	if (dateCol >= 0 && data.some((r) => /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(r[dateCol] ?? ""))) m.date_format = "dmy"; // 05.03.2026 is European
	if (dateCol >= 0 && data.some((r) => /^\d{4}-/.test(r[dateCol] ?? ""))) m.date_format = "ymd";
	m.decimal_comma = data.slice(0, 200).some((r) => r.some((c) => /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(c))) && !data.slice(0, 200).some((r) => r.some((c) => /^-?\d{1,3}(,\d{3})*\.\d{2}$/.test(c)));
	return m;
}

const AI_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["kind", "confidence", "summary", "software", "header_row", "account_from_sections", "date_format", "decimal_comma", "currency", "columns", "accounts"],
	properties: {
		kind: { type: "string", enum: [...MIGRATION_KINDS] },
		confidence: { type: "number" },
		summary: { type: "string" },
		software: { type: "string" },
		header_row: { type: "integer" },
		account_from_sections: { type: "boolean" },
		date_format: { type: "string", enum: [...DATE_FORMATS] },
		decimal_comma: { type: "boolean" },
		currency: { type: "string", enum: ["CAD", "USD"] },
		columns: {
			type: "object",
			additionalProperties: false,
			required: ALL_FIELDS,
			properties: Object.fromEntries(ALL_FIELDS.map((f) => [f, { type: ["string", "null"] }])),
		},
		accounts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "type", "existing_code"],
				properties: { label: { type: "string" }, type: { type: "string", enum: [...ACCOUNT_TYPES] }, existing_code: { type: ["string", "null"] } },
			},
		},
	},
} as const;

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

async function detectWithAi(app: App, u: Upload, ledgerAccounts: { code: string; name: string; type: string }[]): Promise<Partial<Mapping> & { detection: Omit<Detection, "source" | "note">; types: Upload["aiTypes"] }> {
	const head = u.rows.slice(0, 40).map((r, i) => `${i}: ${r.map((c) => clip(c)).join(" | ")}`);
	const width = Math.max(0, ...u.rows.slice(0, 50).map((r) => r.length));
	// Distinct values per column (from the guessed header on), so it can type every account it sees.
	const hr = guessHeaderRow(u.rows);
	const distinct: string[] = [];
	for (let c = 0; c < width; c++) {
		const vals = [...new Set(u.rows.slice(hr + 1).map((r) => r[c] ?? "").filter((v) => v !== "" && !/^[-$()\d.,\s]+$/.test(v)))];
		if (vals.length > 0 && vals.length <= 400) distinct.push(`column ${c} (${clip(u.rows[hr]?.[c] ?? "", 40)}): ${vals.slice(0, 150).map((v) => clip(v, 50)).join(" ; ")}`);
	}
	const lonely = [...new Set(u.rows.slice(hr + 1).filter((r) => r.filter((x) => x !== "").length === 1).map((r) => r.find((x) => x !== "")!))].slice(0, 150);
	const prompt = [
		`File name: ${u.filename}`,
		`Rows: ${u.rows.length}`,
		"",
		"First rows (row index: cells separated by |):",
		...head,
		"",
		"Distinct text values per column:",
		...distinct,
		...(lonely.length ? ["", "Rows with a single filled cell (section headings?):", lonely.map((v) => clip(v, 50)).join(" ; ")] : []),
		"",
		"Accounts already in Ledger (code, name, type):",
		...(ledgerAccounts.length ? ledgerAccounts.slice(0, 300).map((a) => `${a.code}, ${a.name}, ${a.type}`) : ["(none yet)"]),
	].join("\n");
	const system = `You help migrate a small business's books from other accounting software into Ledger, a double-entry bookkeeping app with accounts of type asset, liability, equity, revenue or expense, and journal entries.
Identify what the export file is:
- accounts: a chart of accounts (account names, maybe numbers and types).
- general_ledger: transactions or journal lines (dates, accounts, debit/credit or amounts). Reports grouped by account, where each account appears as a heading row with its lines below and "Total for ..." rows, set account_from_sections true and columns.account null.
- trial_balance: one balance (or debit/credit) per account, no dates per row.
- customers / vendors: contact lists.
header_row is the index of the row with column names. For columns, give the exact column name from the header row for each Ledger field that is present, else null: date, account, debit, credit, amount (one signed amount instead of debit/credit), entry_id (what groups lines into one transaction: transaction id, journal number, Num), description, reference, memo, currency, code (account number), name (account or contact name), type (account type), balance, email, phone.
date_format: ymd, mdy or dmy as the dates are written. decimal_comma: true if amounts use a comma for decimals.
accounts: for every account name you can see (in an account/name column, or section headings, or type values of a chart of accounts), its Ledger type, and existing_code if it is clearly the same as an account already in Ledger, else null.
summary: one or two plain sentences for the user saying what the file holds. software: the program that likely produced it, or "".`;
	const r = await llmComplete(app, "ledger", { system, prompt, schema: AI_SCHEMA, maxTokens: 8000 });
	const a = r.data as {
		kind: MigrationKind;
		confidence: number;
		summary: string;
		software: string;
		header_row: number;
		account_from_sections: boolean;
		date_format: DateFormat;
		decimal_comma: boolean;
		currency: Currency;
		columns: Record<string, string | null>;
		accounts: { label: string; type: AccountType; existing_code: string | null }[];
	};
	const headerRow = Number.isInteger(a.header_row) && a.header_row >= 0 && a.header_row < Math.min(40, u.rows.length) ? a.header_row : hr;
	const headers = headersOf(u, { header_row: headerRow });
	const kind = MIGRATION_KINDS.includes(a.kind) ? a.kind : "general_ledger";
	const columns: Record<string, string | null> = {};
	for (const f of KIND_FIELDS[kind]) {
		const v = a.columns?.[f];
		columns[f] = typeof v === "string" && headers.includes(v) ? v : null;
	}
	const types: Upload["aiTypes"] = new Map();
	const codes = new Set(ledgerAccounts.map((x) => x.code));
	for (const x of Array.isArray(a.accounts) ? a.accounts : []) {
		if (typeof x?.label === "string" && isAccountType(x.type)) types.set(x.label.trim().toLowerCase(), { type: x.type, code: x.existing_code && codes.has(x.existing_code) ? x.existing_code : null });
	}
	return {
		kind,
		columns,
		header_row: headerRow,
		account_from_sections: a.account_from_sections === true && !columns.account,
		date_format: DATE_FORMATS.includes(a.date_format) ? a.date_format : "mdy",
		decimal_comma: a.decimal_comma === true,
		currency: isCurrency(a.currency) ? a.currency : "CAD",
		detection: {
			kind,
			confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
			summary: String(a.summary ?? "").slice(0, 600),
			software: String(a.software ?? "").slice(0, 80),
		},
		types,
	};
}

/** Reads an upload and works out what it is. */
export async function analyzeUpload(app: App, user: number, filename: string, data: Buffer, useAi: boolean): Promise<Upload> {
	if (data.length === 0) bad("file", "is empty");
	if (data.length > MAX_FILE_BYTES) bad("file", `is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
	// Excel's "Unicode text" is UTF-16 with a byte order mark.
	const utf16 = data[0] === 0xff && data[1] === 0xfe;
	if (!utf16 && data.includes(0)) bad("file", "must be a text export (CSV or tab-separated); save spreadsheets as CSV first");
	const rows = parseDelimited(utf16 ? new TextDecoder("utf-16le").decode(data.subarray(2)) : decodeText(data));
	if (rows.length < 2) bad("file", "has no rows to import");
	if (rows.length > MAX_ROWS) bad("file", `has more than ${MAX_ROWS} rows; split it`);
	const base = { rows, filename };
	const u: Upload = {
		id: randomBytes(12).toString("base64url"),
		org: currentOrg().id,
		user,
		filename: filename.slice(0, 200) || "import.csv",
		sha256: createHash("sha256").update(data).digest("hex"),
		data,
		rows,
		mapping: defaultMapping(base, guessHeaderRow(rows)),
		detection: { kind: "general_ledger", confidence: 0, summary: "", software: "", source: "rules", note: "" },
		aiTypes: new Map(),
		created: Date.now(),
	};
	const rules = detectByRules(u.filename, headersOf(u, u.mapping), rows.slice(u.mapping.header_row + 1));
	u.detection = { ...rules, software: "", source: "rules", note: "" };

	const cfg = await readLlmConfig(app.integrations.dir);
	if (!useAi) u.detection.note = "AI detection was turned off.";
	else if (!pickConnection(cfg, "text")) u.detection.note = "No LLM connection is set up (Settings → LLM API), so the columns were matched by name.";
	else {
		try {
			const ledgerAccounts = await queryRows<{ code: string; name: string; type: string }>(app.db, `SELECT code, name, type FROM accounts ORDER BY code`);
			const ai = await detectWithAi(app, u, ledgerAccounts);
			const { detection, types, ...mapping } = ai;
			u.mapping = { ...u.mapping, ...mapping };
			u.aiTypes = types;
			u.detection = { ...detection, source: "ai", note: "" };
		} catch (err) {
			log.warn("migration: AI detection failed", { err: (err as Error).message });
			u.detection.note = `The AI couldn't read it (${(err as Error).message}); the columns were matched by name.`;
		}
	}
	sweep();
	uploads.set(u.id, u);
	return u;
}

// ---------------------------------------------------------------------------
// Turning rows into a plan
// ---------------------------------------------------------------------------

export interface PlanAccount extends AccountChoice {
	/** The account's name in the file. */
	label: string;
	/** Rows that use it. */
	rows: number;
	/** The account already exists in Ledger (map) or would be new (create). */
	exists: boolean;
	/** Where the suggestion came from: the file, Ledger, the AI or a guess from the name. */
	from: "file" | "ledger" | "ai" | "guess" | "you";
}

export interface Plan {
	id: string;
	filename: string;
	detection: Detection;
	mapping: Mapping;
	headers: string[];
	/** The first rows of the file, to show next to the mapping. */
	sample: string[][];
	row_count: number;
	fields: string[];
	required: string[];
	accounts: PlanAccount[];
	entries: { count: number; lines: number; from: string | null; to: string | null; preview: { date: string; description: string; reference: string; lines: { account_code: string; debit_cents: bigint; credit_cents: bigint; memo: string }[] }[] };
	contacts: { count: number; recipients: { id: string; name: string }[] };
	issues: { level: "error" | "warning"; message: string }[];
	ai_available: boolean;
}

interface Built {
	plan: Plan;
	entries: JournalEntryCreate[];
	newAccounts: AccountChoice[];
}

const REQUIRED: Record<MigrationKind, string[][]> = {
	// Each inner list: one of these columns is needed.
	accounts: [["name"]],
	general_ledger: [["date"], ["account"], ["debit", "credit", "amount"]],
	trial_balance: [["account"], ["debit", "credit", "balance"]],
	customers: [["name"]],
	vendors: [["name"]],
};

/** Checks a mapping sent back from the page; unknown or wrong values become errors. */
export function cleanMapping(u: Upload, v: unknown): Mapping {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	const m: Mapping = structuredClone(u.mapping);
	if (o.kind !== undefined) {
		if (!MIGRATION_KINDS.includes(o.kind as MigrationKind)) err.add("kind", `must be one of ${MIGRATION_KINDS.join(", ")}`);
		else m.kind = o.kind as MigrationKind;
	}
	if (o.header_row !== undefined) {
		if (!Number.isInteger(o.header_row) || (o.header_row as number) < 0 || (o.header_row as number) >= Math.min(40, u.rows.length - 1)) err.add("header_row", "must be one of the first rows");
		else m.header_row = o.header_row as number;
	}
	const headers = headersOf(u, m);
	if (o.columns !== undefined) {
		const c = (o.columns && typeof o.columns === "object" && !Array.isArray(o.columns) ? o.columns : null) as Record<string, unknown> | null;
		if (!c) err.add("columns", "must be an object");
		else {
			m.columns = {};
			for (const f of KIND_FIELDS[m.kind]) {
				const h = c[f];
				if (h === undefined || h === null || h === "") m.columns[f] = null;
				else if (typeof h !== "string" || !headers.includes(h)) err.add(`columns.${f}`, "must be one of the file's columns");
				else m.columns[f] = h;
			}
		}
	} else if (o.kind !== undefined || o.header_row !== undefined) {
		// A different kind or header row: match the columns again.
		m.columns = mapColumns(headers, m.kind);
	}
	for (const f of KIND_FIELDS[m.kind]) if (m.columns[f] && !headers.includes(m.columns[f]!)) m.columns[f] = null;
	if (o.account_from_sections !== undefined) m.account_from_sections = o.account_from_sections === true;
	if (o.date_format !== undefined) {
		if (!DATE_FORMATS.includes(o.date_format as DateFormat)) err.add("date_format", "must be ymd, mdy or dmy");
		else m.date_format = o.date_format as DateFormat;
	}
	if (o.decimal_comma !== undefined) m.decimal_comma = o.decimal_comma === true;
	if (o.currency !== undefined) {
		if (!isCurrency(o.currency as string)) err.add("currency", "must be CAD or USD");
		else m.currency = o.currency as Currency;
	}
	if (o.as_of !== undefined) {
		if (typeof o.as_of !== "string" || parseLooseDate(o.as_of, "ymd") === null) err.add("as_of", "must be a date (YYYY-MM-DD)");
		else m.as_of = parseLooseDate(o.as_of, "ymd")!;
	}
	if (o.accounts !== undefined) {
		const a = (o.accounts && typeof o.accounts === "object" && !Array.isArray(o.accounts) ? o.accounts : null) as Record<string, unknown> | null;
		if (!a || Object.keys(a).length > 5000) err.add("accounts", "must be an object");
		else {
			m.accounts = {};
			for (const [label, raw] of Object.entries(a)) {
				const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
				const choice: Partial<AccountChoice> = {};
				if (x.action !== undefined) {
					if (!["create", "map", "skip"].includes(x.action as string)) err.add(`accounts.${label}.action`, "must be create, map or skip");
					else choice.action = x.action as AccountChoice["action"];
				}
				if (typeof x.code === "string") choice.code = x.code.trim();
				if (typeof x.name === "string") choice.name = x.name.trim();
				if (x.type !== undefined) {
					if (!isAccountType(x.type as string)) err.add(`accounts.${label}.type`, "must be asset, liability, equity, revenue or expense");
					else choice.type = x.type as AccountType;
				}
				if (x.currency !== undefined) {
					if (!isCurrency(x.currency as string)) err.add(`accounts.${label}.currency`, "must be CAD or USD");
					else choice.currency = x.currency as Currency;
				}
				m.accounts[label] = choice;
			}
		}
	}
	err.throwIfAny();
	return m;
}

interface LedgerAccount {
	id: bigint;
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
}

/** Splits "6100 Office Expense", "6100 · Office", "Expenses:Office" into the parts to match on. */
function labelParts(label: string): { code: string | null; name: string } {
	const m = /^([A-Za-z]?\d[\w.-]*)\s*[-–·:]?\s+(.+)$/.exec(label.trim());
	if (m) return { code: m[1]!, name: m[2]!.trim() };
	return { code: null, name: label.includes(":") ? label.split(":").at(-1)!.trim() : label.trim() };
}

/** Builds what an import would do, with every problem found. Nothing is written. */
export async function buildPlan(app: App, u: Upload, m: Mapping): Promise<Built> {
	const issues: Plan["issues"] = [];
	const error = (message: string) => issues.length < 200 && issues.push({ level: "error", message });
	const warn = (message: string) => issues.length < 200 && issues.push({ level: "warning", message });
	const headers = headersOf(u, m);
	const col = (f: string) => (m.columns[f] ? headers.indexOf(m.columns[f]!) : -1);
	const dataRows = u.rows.slice(m.header_row + 1).map((cells, i) => ({ cells, line: m.header_row + i + 2 }));
	const ledger = await queryRows<LedgerAccount>(app.db, `SELECT id, code, name, type, currency FROM accounts ORDER BY code`);
	const byCode = new Map(ledger.map((a) => [a.code.toLowerCase(), a]));
	const byName = new Map(ledger.map((a) => [norm(a.name), a]));

	for (const group of REQUIRED[m.kind]) {
		if (m.kind === "general_ledger" && group[0] === "account" && m.account_from_sections) continue;
		if (!group.some((f) => col(f) >= 0)) error(`Choose the column for ${group.join(" / ").replaceAll("_", " ")}.`);
	}

	// Account suggestions, by label, with choices the user made on top.
	const used = new Set([...ledger.map((a) => a.code)]);
	const nextCode = (type: AccountType): string => {
		const start = { asset: 1000, liability: 2000, equity: 3000, revenue: 4000, expense: 5000 }[type];
		const nums = [...used].map(Number).filter((n) => Number.isInteger(n) && n >= start && n < start + 1000);
		let n = nums.length ? Math.floor(Math.max(...nums) / 10) * 10 + 10 : start;
		while (used.has(String(n)) && n < start + 1000) n++;
		if (n >= start + 1000) for (n = start; used.has(String(n)); n++);
		used.add(String(n));
		return String(n);
	};
	const accounts = new Map<string, PlanAccount>();
	const resolve = (label: string, hint: { code?: string; type?: string; currency?: string } = {}): PlanAccount => {
		const key = label.trim();
		let a = accounts.get(key);
		if (a) {
			a.rows++;
			return a;
		}
		const parts = labelParts(key);
		const ai = u.aiTypes.get(key.toLowerCase()) ?? u.aiTypes.get((hint.type ?? "").toLowerCase());
		const fileCode = hint.code?.trim() || parts.code || "";
		const existing =
			(fileCode && byCode.get(fileCode.toLowerCase())) || byCode.get(key.toLowerCase()) || byName.get(norm(key)) || byName.get(norm(parts.name)) || (ai?.code ? byCode.get(ai.code.toLowerCase()) : undefined);
		const want = m.accounts[key] ?? {};
		if (existing && want.action !== "create") {
			a = { label: key, rows: 1, exists: true, from: "ledger", action: "map", code: existing.code, name: existing.name, type: existing.type, currency: existing.currency };
		} else {
			const fromFile = hint.type ? inferType(hint.type) : null;
			const type = want.type ?? fromFile ?? ai?.type ?? inferType(parts.name) ?? "expense";
			const from: PlanAccount["from"] = want.type ? "you" : fromFile ? "file" : ai ? "ai" : "guess";
			const code = want.code || (fileCode && ACCOUNT_CODE_RE.test(fileCode) && !used.has(fileCode) ? (used.add(fileCode), fileCode) : nextCode(type));
			const currency = want.currency ?? (hint.currency && isCurrency(hint.currency.toUpperCase()) ? (hint.currency.toUpperCase() as Currency) : m.currency);
			a = { label: key, rows: 1, exists: false, from, action: "create", code, name: want.name || parts.name || key, type, currency };
		}
		if (want.action === "map" && want.code) {
			const target = byCode.get(want.code.toLowerCase());
			if (target) Object.assign(a, { action: "map", exists: true, code: target.code, name: target.name, type: target.type, currency: target.currency, from: "you" });
			else error(`"${key}": there is no account ${want.code} in Ledger to use.`);
		}
		if (want.action === "skip") a.action = "skip";
		accounts.set(key, a);
		return a;
	};

	const entries: JournalEntryCreate[] = [];
	let contacts = 0;
	const blocked = issues.some((i) => i.level === "error");

	if (!blocked && m.kind === "accounts") {
		const [cName, cCode, cType, cDesc, cCur] = ["name", "code", "type", "description", "currency"].map(col);
		for (const { cells, line } of dataRows) {
			const name = cells[cName!] ?? "";
			if (!name || /^total\b/i.test(name)) continue;
			const a = resolve(name, { code: cCode! >= 0 ? cells[cCode!] : undefined, type: cType! >= 0 ? cells[cType!] : undefined, currency: cCur! >= 0 ? cells[cCur!] : undefined });
			if (a.rows > 1) warn(`Row ${line}: "${name}" appears more than once; it's imported once.`);
			if (cDesc! >= 0 && a.action === "create" && !a.exists) (a as PlanAccount & { description?: string }).description = (cells[cDesc!] ?? "").slice(0, 1000);
		}
		const existing = [...accounts.values()].filter((a) => a.exists).length;
		if (existing) warn(`${existing} of these accounts are already in Ledger and will be left as they are.`);
	}

	if (!blocked && (m.kind === "general_ledger" || m.kind === "trial_balance")) {
		const [cDate, cAcc, cDeb, cCred, cAmt, cId, cDesc, cRef, cMemo, cBal, cCur] = ["date", "account", "debit", "credit", "amount", "entry_id", "description", "reference", "memo", "balance", "currency"].map(col);
		const money = (cells: string[], c: number, line: number, what: string): bigint | null => {
			if (c < 0) return null;
			try {
				return parseMoney(cells[c] ?? "", m.decimal_comma);
			} catch (e) {
				error(`Row ${line}: the ${what} ${(e as Error).message.replace(/^"(.*)" is/, '"$1" is')}.`);
				return null;
			}
		};
		let section: string | null = null;
		type Line = { line: number; date: string; key: string; account: PlanAccount; amount: bigint; memo: string; description: string; reference: string };
		const lines: Line[] = [];
		let badDates = 0;
		for (const { cells, line } of dataRows) {
			const filled = cells.filter((c) => c !== "");
			if (filled.length === 0) continue;
			if (m.account_from_sections && filled.length === 1 && !/^(total|net|grand total)\b/i.test(filled[0]!)) {
				section = filled[0]!;
				continue;
			}
			const first = filled[0] ?? "";
			if (/^(total|grand total|net income|ending balance|beginning balance|opening balance|balance forward)\b/i.test(first)) continue;
			const label = cAcc! >= 0 ? (cells[cAcc!] ?? "") : (section ?? "");
			if (!label) continue;
			let amount: bigint | null;
			if (m.kind === "trial_balance" && cDeb! < 0 && cCred! < 0) amount = money(cells, cBal! >= 0 ? cBal! : cAmt!, line, "balance");
			else if (cDeb! >= 0 || cCred! >= 0) {
				const d = money(cells, cDeb!, line, "debit") ?? 0n;
				const c = money(cells, cCred!, line, "credit") ?? 0n;
				amount = d - c;
			} else amount = money(cells, cAmt!, line, "amount");
			if (amount === null || amount === 0n) continue;
			let date = m.as_of;
			if (m.kind === "general_ledger") {
				const raw = cells[cDate!] ?? "";
				const d = parseLooseDate(raw, m.date_format);
				if (!d) {
					if (raw && ++badDates <= 5) error(`Row ${line}: "${raw}" is not a date in the chosen format.`);
					else if (!raw && ++badDates <= 5) error(`Row ${line}: no date.`);
					continue;
				}
				date = d;
			}
			const account = resolve(label, { currency: cCur! >= 0 ? cells[cCur!] : undefined });
			const description = (cDesc! >= 0 ? cells[cDesc!] : "") || (cMemo! >= 0 ? cells[cMemo!] : "") || "";
			const reference = cRef! >= 0 ? (cells[cRef!] ?? "") : "";
			const key = cId! >= 0 && cells[cId!] ? `id:${cells[cId!]}` : `${date}|${reference}|${description}`;
			lines.push({ line, date, key, account, amount, memo: cMemo! >= 0 && cMemo !== cDesc ? (cells[cMemo!] ?? "") : "", description, reference });
		}
		if (badDates > 5) error(`…and ${badDates - 5} more rows with dates that couldn't be read. Check the date format.`);

		if (m.kind === "trial_balance") {
			// One opening entry; the difference per currency goes to Opening balance equity.
			const byCur = new Map<Currency, Line[]>();
			for (const l of lines) byCur.set(l.account.currency, [...(byCur.get(l.account.currency) ?? []), l]);
			for (const [cur, ls] of byCur) {
				const diff = ls.reduce((s, l) => s + l.amount, 0n);
				const eLines = ls.map((l) => ({ l, a: l.account }));
				if (diff !== 0n) {
					const eq = resolve(`${OPENING_EQUITY.name}${byCur.size > 1 ? ` (${cur})` : ""}`, { code: byCur.size > 1 ? `${OPENING_EQUITY.code}-${cur}` : OPENING_EQUITY.code, type: "equity", currency: cur });
					eLines.push({ l: { ...ls[0]!, amount: -diff, memo: "Balancing amount" }, a: eq });
					warn(`The ${cur} balances don't add up to zero; the difference (${(Number(diff) / 100).toFixed(2)}) goes to ${eq.code} ${eq.name}.`);
				}
				entries.push({
					entry_date: m.as_of,
					description: `Opening balances from ${u.filename}`.slice(0, 500),
					reference: "",
					lines: eLines.map(({ l, a }) => ({ account_code: a.code, debit_cents: l.amount > 0n ? l.amount : 0n, credit_cents: l.amount < 0n ? -l.amount : 0n, memo: l.memo.slice(0, 500) })),
				});
			}
		} else {
			// Group lines into entries: by transaction id, else by date, reference and description in a row.
			const groups: Line[][] = [];
			const byKey = new Map<string, Line[]>();
			let prev: string | null = null;
			for (const l of lines) {
				if (l.key.startsWith("id:")) {
					const g = byKey.get(l.key);
					if (g) g.push(l);
					else {
						const n = [l];
						byKey.set(l.key, n);
						groups.push(n);
					}
				} else if (prev === l.key) groups.at(-1)!.push(l);
				else groups.push([l]);
				prev = l.key;
			}
			let unbalanced = 0;
			for (const g of groups) {
				const sums = new Map<Currency, bigint>();
				for (const l of g) sums.set(l.account.currency, (sums.get(l.account.currency) ?? 0n) + l.amount);
				const off = [...sums.entries()].filter(([, s]) => s !== 0n);
				if (off.length > 0 || g.length < 2) {
					if (++unbalanced <= 5) {
						error(`Rows ${g.map((l) => l.line).slice(0, 6).join(", ")}${g.length > 6 ? "…" : ""} (${g[0]!.date}${g[0]!.description ? `, ${clip(g[0]!.description, 40)}` : ""}): ${g.length < 2 ? "only one line" : `debits and credits differ by ${off.map(([c, s]) => `${(Number(s) / 100).toFixed(2)} ${c}`).join(", ")}`}.`);
					}
					continue;
				}
				const first = g[0]!;
				entries.push({
					entry_date: first.date,
					description: (first.description || `Imported from ${u.filename}`).slice(0, 500),
					reference: first.reference.slice(0, 100),
					lines: g.map((l) => ({ account_code: l.account.code, debit_cents: l.amount > 0n ? l.amount : 0n, credit_cents: l.amount < 0n ? -l.amount : 0n, memo: (l.memo || (l.description !== first.description ? l.description : "")).slice(0, 500) })),
				});
			}
			if (unbalanced > 5) error(`…and ${unbalanced - 5} more transactions that don't balance. Check the transaction id column and the debit/credit columns.`);
			if (unbalanced > 0 && !m.columns.entry_id) warn("Without a transaction id column, lines are grouped by date, reference and description in a row; choose the id column if the file has one.");
		}
		if (lines.length === 0 && issues.length === 0) error("No rows with amounts were found. Check the header row and the amount columns.");
	}

	if (!blocked && (m.kind === "customers" || m.kind === "vendors")) {
		const c = col("name");
		contacts = dataRows.filter((r) => (r.cells[c] ?? "") !== "" && !/^total\b/i.test(r.cells[c] ?? "")).length;
		if (contacts === 0) error("No names were found in the chosen column.");
	}

	const newAccounts = [...accounts.values()].filter((a) => a.action === "create" && !a.exists);
	for (const a of newAccounts) {
		if (!ACCOUNT_CODE_RE.test(a.code)) error(`"${a.label}": the code "${a.code}" isn't valid (letters, digits, . _ -).`);
		else if (byCode.has(a.code.toLowerCase())) error(`"${a.label}": an account with code ${a.code} already exists; choose "use existing" or another code.`);
		if (!a.name || a.name.length > 200) error(`"${a.label}": the name must be 1-200 characters.`);
	}
	const dupCodes = newAccounts.map((a) => a.code).filter((c, i, all) => all.indexOf(c) !== i);
	for (const c of new Set(dupCodes)) error(`More than one new account would get the code ${c}.`);
	if (m.kind !== "accounts" && [...accounts.values()].some((a) => a.action === "skip")) error("Accounts in transactions can't be skipped; create them or use existing ones.");

	const dates = entries.map((e) => e.entry_date).sort();
	const recipients = m.kind === "customers" || m.kind === "vendors" ? fileTargets(app, m.kind === "customers" ? "customer" : "vendor").map((t) => ({ id: t.id, name: t.name })) : [];
	if ((m.kind === "customers" || m.kind === "vendors") && recipients.length === 0) {
		error(`Ledger keeps accounts and entries, not ${m.kind}. No installed module accepts ${m.kind === "customers" ? "customer" : "vendor"} lists yet (a sales or bills module can, when it supports it).`);
	}
	const plan: Plan = {
		id: u.id,
		filename: u.filename,
		detection: u.detection,
		mapping: m,
		headers,
		sample: u.rows.slice(0, m.header_row + 12),
		row_count: dataRows.length,
		fields: [...KIND_FIELDS[m.kind]],
		required: REQUIRED[m.kind].flat(),
		accounts: [...accounts.values()],
		entries: {
			count: entries.length,
			lines: entries.reduce((n, e) => n + e.lines.length, 0),
			from: dates[0] ?? null,
			to: dates.at(-1) ?? null,
			preview: entries.slice(0, 5).map((e) => ({ date: e.entry_date, description: e.description, reference: e.reference, lines: e.lines })),
		},
		contacts: { count: contacts, recipients },
		issues,
		ai_available: false,
	};
	return { plan, entries, newAccounts };
}

export async function planFor(app: App, u: Upload, m: Mapping): Promise<Plan> {
	u.mapping = m;
	const { plan } = await buildPlan(app, u, m);
	plan.ai_available = pickConnection(await readLlmConfig(app.integrations.dir), "text") !== null;
	return plan;
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

export interface MigrationResult {
	kind: MigrationKind;
	accounts_created: number;
	entries_created: number;
	import_id: number | null;
	sent_to: string | null;
	file_id: number | null;
}

/** Imports the plan in one transaction (or hands a contact list to a module). */
export async function runMigration(app: App, u: Upload, m: Mapping, actorId: number, recipient: string | null): Promise<MigrationResult> {
	const { plan, entries, newAccounts } = await buildPlan(app, u, m);
	const errors = plan.issues.filter((i) => i.level === "error");
	if (errors.length > 0) throw new HttpError(422, `fix these first: ${errors.slice(0, 3).map((e) => e.message).join(" ")}`, "validation_failed");

	if (m.kind === "customers" || m.kind === "vendors") {
		const to = recipient ?? plan.contacts.recipients[0]?.id;
		if (!to || !plan.contacts.recipients.some((r) => r.id === to)) throw new HttpError(422, "choose a module to send the list to", "validation_failed");
		const headers = plan.headers;
		const f = await filesFor(app, "ledger", () => actorId).send({
			to,
			kind: m.kind === "customers" ? "customer" : "vendor",
			filename: u.filename,
			contentType: "text/csv",
			data: u.data,
			meta: { header_row: m.header_row, columns: Object.fromEntries(Object.entries(m.columns).filter(([, v]) => v !== null)), headers: headers.slice(0, 100), rows: plan.contacts.count, source: plan.detection.software || null },
			note: `${plan.contacts.count} ${m.kind} from ${u.filename}`,
		});
		uploads.delete(u.id);
		return { kind: m.kind, accounts_created: 0, entries_created: 0, import_id: null, sent_to: to, file_id: f.id };
	}

	const result = await withTx(app.db, {}, async (tx) => {
		for (const a of newAccounts) {
			const desc = (a as PlanAccount & { description?: string }).description ?? "";
			await tx.query(`INSERT INTO accounts (code, name, type, currency, description) VALUES ($1, $2, $3, $4, $5)`, [a.code, a.name.trim(), a.type, a.currency, desc]);
		}
		if (entries.length === 0) return { importId: null as bigint | null };
		const prev = await queryRow<{ filename: string }>(tx, `SELECT filename FROM csv_imports WHERE sha256 = $1`, [u.sha256]);
		if (prev) throw new ConflictError(`this file's content was already imported (as ${prev.filename})`);
		const accounts = await lockAccounts(tx, entries.flatMap((e) => lineCodes(e.lines)));
		const v = new ValidationError();
		for (const [i, e] of entries.entries()) {
			const fn: FieldNames = { entry: (f) => `entry ${i + 1} (${e.entry_date}).${f}`, line: (j, f) => `entry ${i + 1} (${e.entry_date}) line ${j + 1}${f ? "." + f : ""}` };
			validateEntry(v, e, fn);
			checkLinesPostable(v, e, accounts, fn);
		}
		v.throwIfAny();
		const name = `migration-${u.filename}`.replace(/[^\w.() -]/g, "_").slice(0, 200);
		const row = await queryRow<{ id: bigint }>(
			tx,
			`INSERT INTO csv_imports (filename, sha256, entry_count, line_count, imported_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[name, u.sha256, entries.length, entries.reduce((n, e) => n + e.lines.length, 0), actorId],
		);
		await insertJournalEntries(tx, entries, accounts, row!.id, actorId);
		return { importId: row!.id };
	});
	uploads.delete(u.id);
	return { kind: m.kind, accounts_created: newAccounts.length, entries_created: entries.length, import_id: result.importId === null ? null : Number(result.importId), sent_to: null, file_id: null };
}

export function publicPlan(p: Plan) {
	return p;
}
