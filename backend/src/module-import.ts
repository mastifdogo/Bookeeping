// "Import from CSV" on a module's Settings tab (ctx.imports.provide). The
// module declares the fields it can import and a handler; Ledger reads the
// uploaded CSV, works out which column is which field (the LLM under
// Settings → LLM API, or column names), converts the values (dates, amounts,
// numbers, yes/no), shows a preview the module checks (a dry run), and hands
// the rows over only when the user presses Import.

import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { llmComplete, pickConnection, readLlmConfig } from "./llm.ts";
import { log } from "./log.ts";
import { decodeText, guessHeaderRow, parseDelimited, parseLooseDate, parseMoney } from "./migrate.ts";
import { MAX_FILE_BYTES } from "./files.ts";
import { currentOrg } from "./orgs.ts";

export const IMPORT_TYPES = ["text", "number", "money", "date", "boolean"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export interface ImportField {
	key: string;
	label: string;
	type: ImportType;
	required: boolean;
	help: string;
}

/** Converted rows: field key → value (text, number, integer cents, "YYYY-MM-DD", boolean or null), plus _row (the file's line). */
export type ImportRow = Record<string, string | number | boolean | null> & { _row: number };

export interface ImportResult {
	/** One line for the user: "Would add 12 customers, 2 already exist." / "Added 12 customers." */
	summary?: string;
	/** Problems with particular rows (dry run: these block the import). */
	errors?: { row: number; message: string }[];
}

export interface ImportSpec {
	/** What the import brings in, e.g. "Customers". */
	label: string;
	description: string;
	fields: ImportField[];
	/** Called with the rows; dryRun true for the preview (change nothing), false to import. */
	handler: (rows: ImportRow[], opts: { dryRun: boolean; user: unknown }) => ImportResult | Promise<ImportResult>;
}

/** Validates what a module passes to ctx.imports.provide. */
export function checkImportSpec(v: unknown): ImportSpec {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const fail = (msg: string): never => {
		throw new Error(`imports.provide: ${msg}`);
	};
	if (typeof o.handler !== "function") fail("handler must be a function (rows, { dryRun, user }) => { summary?, errors? }");
	if (!Array.isArray(o.fields) || o.fields.length === 0 || o.fields.length > 60) fail("fields must be a list of 1-60 fields");
	const keys = new Set<string>();
	const fields = (o.fields as unknown[]).map((f, i) => {
		const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
		if (typeof x.key !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(x.key) || keys.has(x.key)) fail(`fields[${i}].key must be a unique lowercase key such as "email"`);
		keys.add(x.key as string);
		const type = x.type ?? "text";
		if (!IMPORT_TYPES.includes(type as ImportType)) fail(`fields[${i}].type must be one of ${IMPORT_TYPES.join(", ")}`);
		return {
			key: x.key as string,
			label: typeof x.label === "string" && x.label.trim() ? x.label.trim().slice(0, 80) : (x.key as string),
			type: type as ImportType,
			required: x.required === true,
			help: typeof x.help === "string" ? x.help.slice(0, 300) : "",
		};
	});
	return {
		label: typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : "Data",
		description: typeof o.description === "string" ? o.description.slice(0, 500) : "",
		fields,
		handler: o.handler as ImportSpec["handler"],
	};
}

export interface ImportMapping {
	/** Field key → the file's column (null: not in the file). */
	columns: Record<string, string | null>;
	header_row: number;
	date_format: "ymd" | "mdy" | "dmy";
	decimal_comma: boolean;
}

interface Upload {
	id: string;
	module: string;
	org: number;
	user: number;
	filename: string;
	rows: string[][];
	mapping: ImportMapping;
	detection: { source: "ai" | "rules"; note: string };
	created: number;
}

const uploads = new Map<string, Upload>();
const TTL = 2 * 3600_000;

function sweep(): void {
	for (const [id, u] of uploads) if (Date.now() - u.created > TTL) uploads.delete(id);
	while (uploads.size > 20) uploads.delete(uploads.keys().next().value!);
}

export function getImportUpload(module: string, id: string, user: number): Upload {
	sweep();
	const u = uploads.get(id);
	if (!u || u.module !== module || u.user !== user || u.org !== currentOrg().id) throw new NotFoundError();
	return u;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function headersOf(rows: string[][], headerRow: number): string[] {
	const seen = new Map<string, number>();
	return (rows[headerRow] ?? []).map((h, i) => {
		const name = h || `Column ${i + 1}`;
		const n = (seen.get(name) ?? 0) + 1;
		seen.set(name, n);
		return n > 1 ? `${name} (${n})` : name;
	});
}

/** Column names that match a field's key or label. */
function matchByName(headers: string[], fields: ImportField[]): Record<string, string | null> {
	const taken = new Set<string>();
	const out: Record<string, string | null> = {};
	for (const f of fields) {
		// Compared without spaces or punctuation, so "E-mail" is "email".
		const flat = (x: string) => norm(x).replaceAll(" ", "");
		const wanted = [flat(f.key), flat(f.label)];
		let hit = headers.find((h) => !taken.has(h) && wanted.includes(flat(h)));
		hit ??= headers.find((h) => !taken.has(h) && flat(h).length > 2 && wanted.some((w) => w.length > 2 && (flat(h).includes(w) || w.includes(flat(h)))));
		out[f.key] = hit ?? null;
		if (hit) taken.add(hit);
	}
	return out;
}

function guessFormats(rows: string[][]): Pick<ImportMapping, "date_format" | "decimal_comma"> {
	const cells = rows.slice(0, 300).flat();
	let date_format: ImportMapping["date_format"] = "mdy";
	if (cells.some((c) => /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(c) || /^(1[3-9]|2\d|3[01])[/-]\d{1,2}[/-]\d{2,4}$/.test(c))) date_format = "dmy";
	if (cells.some((c) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(c)) && !cells.some((c) => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(c))) date_format = "ymd";
	const decimal_comma = cells.some((c) => /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(c)) && !cells.some((c) => /^-?\d{1,3}(,\d{3})*\.\d{2}$/.test(c));
	return { date_format, decimal_comma };
}

/** Asks the LLM which column holds which field. */
async function mapWithAi(app: App, moduleName: string, spec: ImportSpec, filename: string, rows: string[][]): Promise<Partial<ImportMapping>> {
	const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["header_row", "date_format", "decimal_comma", "columns"],
		properties: {
			header_row: { type: "integer" },
			date_format: { type: "string", enum: ["ymd", "mdy", "dmy"] },
			decimal_comma: { type: "boolean" },
			columns: {
				type: "object",
				additionalProperties: false,
				required: spec.fields.map((f) => f.key),
				properties: Object.fromEntries(spec.fields.map((f) => [f.key, { type: ["string", "null"] }])),
			},
		},
	};
	const prompt = [
		`Module: ${moduleName} — import of ${spec.label}${spec.description ? ` (${spec.description})` : ""}`,
		`File: ${filename}, ${rows.length} rows`,
		"",
		"Fields the module takes (key: label, type, required, help):",
		...spec.fields.map((f) => `${f.key}: ${f.label}, ${f.type}${f.required ? ", required" : ""}${f.help ? ` — ${f.help}` : ""}`),
		"",
		"First rows of the file (row index: cells separated by |):",
		...rows.slice(0, 25).map((r, i) => `${i}: ${r.map(clip).join(" | ")}`),
	].join("\n");
	const system = `You map the columns of a CSV file to the fields a bookkeeping module imports.
header_row: index of the row holding the column names (files often start with title rows).
columns: for each field key, the exact column name from the header row that holds it, or null if no column fits. Use each column at most once.
date_format: how dates are written (ymd, mdy or dmy). decimal_comma: true if amounts use a comma for decimals.`;
	const r = await llmComplete(app, "ledger", { system, prompt, schema, maxTokens: 2000 });
	return r.data as Partial<ImportMapping>;
}

/** Reads an uploaded CSV and proposes a mapping. */
export async function analyzeImport(app: App, moduleId: string, moduleName: string, spec: ImportSpec, user: number, filename: string, data: Buffer, useAi: boolean): Promise<Upload> {
	const bad = (msg: string): never => {
		const v = new ValidationError();
		v.add("file", msg);
		throw v;
	};
	if (data.length === 0) bad("is empty");
	if (data.length > MAX_FILE_BYTES) bad(`is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
	const utf16 = data[0] === 0xff && data[1] === 0xfe;
	if (!utf16 && data.includes(0)) bad("must be a CSV or tab-separated text file; save spreadsheets as CSV first");
	const rows = parseDelimited(utf16 ? new TextDecoder("utf-16le").decode(data.subarray(2)) : decodeText(data));
	if (rows.length < 2) bad("has no rows to import");
	if (rows.length > 50_000) bad("has more than 50,000 rows; split it");
	let header_row = guessHeaderRow(rows);
	let mapping: ImportMapping = { columns: matchByName(headersOf(rows, header_row), spec.fields), header_row, ...guessFormats(rows.slice(header_row + 1)) };
	let detection: Upload["detection"] = { source: "rules", note: "" };
	const cfg = await readLlmConfig(app.integrations.dir);
	if (!useAi) detection.note = "AI matching was turned off; columns were matched by name.";
	else if (!pickConnection(cfg, "text")) detection.note = "No LLM connection is set up (Settings → LLM API), so columns were matched by name.";
	else {
		try {
			const ai = await mapWithAi(app, moduleName, spec, filename, rows);
			if (Number.isInteger(ai.header_row) && ai.header_row! >= 0 && ai.header_row! < Math.min(25, rows.length - 1)) header_row = ai.header_row!;
			const headers = headersOf(rows, header_row);
			const columns: Record<string, string | null> = {};
			for (const f of spec.fields) {
				const c = ai.columns?.[f.key];
				columns[f.key] = typeof c === "string" && headers.includes(c) ? c : null;
			}
			mapping = {
				columns,
				header_row,
				date_format: ["ymd", "mdy", "dmy"].includes(ai.date_format as string) ? (ai.date_format as ImportMapping["date_format"]) : mapping.date_format,
				decimal_comma: ai.decimal_comma === true,
			};
			detection = { source: "ai", note: "" };
		} catch (err) {
			log.warn("module import: AI mapping failed", { module: moduleId, err: (err as Error).message });
			detection.note = `The AI couldn't map it (${(err as Error).message}); columns were matched by name.`;
		}
	}
	const u: Upload = { id: randomBytes(12).toString("base64url"), module: moduleId, org: currentOrg().id, user, filename: filename.slice(0, 200), rows, mapping, detection, created: Date.now() };
	sweep();
	uploads.set(u.id, u);
	return u;
}

/** Checks a mapping sent back from the page. */
export function cleanImportMapping(u: Upload, spec: ImportSpec, v: unknown): ImportMapping {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	const m: ImportMapping = structuredClone(u.mapping);
	if (o.header_row !== undefined) {
		if (!Number.isInteger(o.header_row) || (o.header_row as number) < 0 || (o.header_row as number) >= Math.min(25, u.rows.length - 1)) err.add("header_row", "must be one of the first rows");
		else if (o.header_row !== m.header_row) {
			m.header_row = o.header_row as number;
			m.columns = matchByName(headersOf(u.rows, m.header_row), spec.fields);
		}
	}
	const headers = headersOf(u.rows, m.header_row);
	if (o.columns !== undefined) {
		const c = (o.columns && typeof o.columns === "object" ? o.columns : {}) as Record<string, unknown>;
		for (const f of spec.fields) {
			const h = c[f.key];
			if (h === undefined) continue;
			if (h === null || h === "") m.columns[f.key] = null;
			else if (typeof h !== "string" || !headers.includes(h)) err.add(`columns.${f.key}`, "must be one of the file's columns");
			else m.columns[f.key] = h;
		}
	}
	if (o.date_format !== undefined) {
		if (!["ymd", "mdy", "dmy"].includes(o.date_format as string)) err.add("date_format", "must be ymd, mdy or dmy");
		else m.date_format = o.date_format as ImportMapping["date_format"];
	}
	if (o.decimal_comma !== undefined) m.decimal_comma = o.decimal_comma === true;
	err.throwIfAny();
	u.mapping = m;
	return m;
}

const YES = /^(y|yes|true|1|x|✓|oui|si|ja)$/i;
const NO = /^(n|no|false|0|non|nein)?$/i;

/** Turns the file's rows into the module's fields; problems are listed by row. */
export function convertRows(u: Upload, spec: ImportSpec, m: ImportMapping): { rows: ImportRow[]; problems: { row: number; message: string }[] } {
	const headers = headersOf(u.rows, m.header_row);
	const rows: ImportRow[] = [];
	const problems: { row: number; message: string }[] = [];
	for (const [k, cells] of u.rows.slice(m.header_row + 1).entries()) {
		const line = m.header_row + k + 2;
		if (cells.every((c) => c === "")) continue;
		const row = { _row: line } as ImportRow;
		let ok = true;
		for (const f of spec.fields) {
			const col = m.columns[f.key] ? headers.indexOf(m.columns[f.key]!) : -1;
			const raw = col >= 0 ? (cells[col] ?? "").trim() : "";
			let value: string | number | boolean | null = raw === "" ? null : raw;
			try {
				if (raw !== "") {
					if (f.type === "number") {
						const n = Number((m.decimal_comma ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "")).replace(/\s/g, ""));
						if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number`);
						value = n;
					} else if (f.type === "money") value = Number(parseMoney(raw, m.decimal_comma));
					else if (f.type === "date") {
						const d = parseLooseDate(raw, m.date_format);
						if (!d) throw new Error(`"${raw}" is not a date in the chosen format`);
						value = d;
					} else if (f.type === "boolean") {
						if (YES.test(raw)) value = true;
						else if (NO.test(raw)) value = false;
						else throw new Error(`"${raw}" is not yes or no`);
					}
				}
			} catch (e) {
				if (problems.length < 200) problems.push({ row: line, message: `${f.label}: ${(e as Error).message.replace(/^"(.*)" is not an amount$/, '"$1" is not an amount')}` });
				ok = false;
			}
			if (value === null && f.required && ok) {
				if (problems.length < 200) problems.push({ row: line, message: `${f.label} is empty` });
				ok = false;
			}
			row[f.key] = value;
		}
		if (ok) rows.push(row);
	}
	return { rows, problems };
}

export function publicPlan(u: Upload, spec: ImportSpec, m: ImportMapping) {
	const { rows, problems } = convertRows(u, spec, m);
	const missing = spec.fields.filter((f) => f.required && !m.columns[f.key]).map((f) => f.label);
	return {
		id: u.id,
		filename: u.filename,
		detection: u.detection,
		mapping: m,
		headers: headersOf(u.rows, m.header_row),
		sample: u.rows.slice(0, Math.min(u.rows.length, m.header_row + 8)),
		row_count: u.rows.length - m.header_row - 1,
		ready_rows: rows.length,
		preview: rows.slice(0, 10),
		problems,
		missing,
		rows,
	};
}

/** Calls the module's handler; its own errors come back as a 422 with its message. */
export async function callImport(spec: ImportSpec, rows: ImportRow[], dryRun: boolean, user: unknown): Promise<Required<ImportResult>> {
	let r: ImportResult;
	try {
		r = (await spec.handler(rows.map((x) => ({ ...x })), { dryRun, user })) ?? {};
	} catch (e) {
		if (e instanceof HttpError) throw e;
		throw new HttpError(422, `the module couldn't ${dryRun ? "check" : "import"} the rows: ${(e as Error).message}`, "validation_failed");
	}
	const errors = Array.isArray(r.errors) ? r.errors.filter((x) => x && Number.isInteger(x.row) && typeof x.message === "string").slice(0, 200) : [];
	return { summary: typeof r.summary === "string" ? r.summary.slice(0, 500) : "", errors };
}
