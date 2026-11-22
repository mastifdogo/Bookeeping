// Reading a bank or card statement with the AI (Settings → LLM API) and
// lining it up with the books, for the Reconcile page.
//
// The AI only reads: the statement's dates, balances and lines. Matching
// those lines to journal lines is plain arithmetic done here (same amount,
// nearest date). The matches are ticked in the open reconciliation as a
// first pass; a person checks them against the statement shown beside them
// and presses Finish.
//
// A statement is read once (Ledger 0.27.0): when its transactions were
// already read out (a module parsed its CSV or OFX file, or a person approved
// what the AI found), that extraction is used and the AI isn't asked. And
// when a reconciliation read with the AI is finished, a person has checked
// the reading against the statement, so it is kept as the document's
// extraction for every module.

import type { App } from "./app.ts";
import { ConflictError, HttpError } from "./errors.ts";
import { getDocument, readDocument } from "./documents.ts";
import { getExtraction, setExtraction } from "./document-tags.ts";
import { log } from "./log.ts";
import { llmComplete, LlmError, pickConnection, PROVIDER_INFO, readLlmConfig } from "./llm.ts";
import { listAccounts } from "./accounts.ts";
import { changeCleared, createReconciliation, getReconciliation, listReconciliations, saveReading, type ReconciliationDetail, type ReconciliationLine, type StatementLine, type StatementReading } from "./reconcile.ts";

const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
const MAX_LINES = 2000;
/** How much of a statement kept as text (CSV, OFX, …) is put before the AI. */
const MAX_STATEMENT_TEXT = 400_000;

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		period_start: { type: ["string", "null"], description: "First day the statement covers, YYYY-MM-DD" },
		end_date: { type: ["string", "null"], description: "Statement closing date, YYYY-MM-DD" },
		opening_balance: { type: ["string", "null"], description: 'Balance at the start, e.g. "1234.56"' },
		closing_balance: { type: ["string", "null"], description: 'Balance at the end, e.g. "1250.00"' },
		lines: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					date: { type: "string", description: "YYYY-MM-DD" },
					description: { type: "string" },
					amount: { type: "string", description: 'Signed decimal, e.g. "-45.10"' },
				},
				required: ["date", "description", "amount"],
			},
		},
	},
	required: ["period_start", "end_date", "opening_balance", "closing_balance", "lines"],
};

const SYSTEM = `You read a bank, credit card or loan statement and copy out exactly what it says. Never invent, guess or correct a figure; use null for anything the statement does not show.

- Dates are YYYY-MM-DD. When lines show only day and month, take the year from the statement period.
- Amounts are plain decimals with a dot, without currency symbols or thousands separators.
- Balances are as printed. For a credit card or loan, the amount owed is a positive number.
- A line's amount is positive when it makes the statement's balance go up and negative when it makes it go down. On a bank account, deposits are positive and withdrawals, fees and cheques are negative. On a credit card or loan, purchases, fees and interest are positive and payments and refunds are negative.
- Copy every transaction line, in the statement's order, one entry per line. Do not include opening or closing balance rows, subtotals or summaries.`;

/** "1,234.56" → 123456; null when it isn't an amount. */
function toCents(v: unknown): number | null {
	if (typeof v !== "string" && typeof v !== "number") return null;
	const s = String(v).replace(/[\s,$€£]/g, "").replace(/^\((.*)\)$/, "-$1");
	const m = /^([+-]?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
	if (!m) return null;
	const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
	return m[1] === "-" ? -cents : cents;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const dayOf = (iso: string) => Math.round(new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000);

export type Reading = Omit<StatementReading, "matched" | "unmatched">;

const TEXT_TYPES = /^(text\/|application\/(x-ofx|x-qif|json|xml)$)/;
const wholeCents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** Opening balance plus the lines should give the closing balance; when only the signs are the wrong way round, they are turned. */
function addUp(lines: StatementLine[], opening: number | null, closing: number | null): boolean | null {
	if (opening === null || closing === null) return null;
	const sum = lines.reduce((n, l) => n + l.amount_cents, 0);
	if (opening + sum === closing) return true;
	// The signs came out the other way round (it happens with card statements): the balances say which way is right.
	if (sum !== 0 && opening - sum === closing) {
		for (const l of lines) l.amount_cents = -l.amount_cents;
		return true;
	}
	return false;
}

/**
 * The reading from what was already read out of the document (the shared keys
 * transactions, period, opening_balance_cents, closing_balance_cents), or
 * null when its transactions haven't been. There, money out is negative; on
 * a statement of a card or loan a purchase makes the balance owed go up.
 */
async function readingFromExtraction(app: App, documentId: unknown, account: { type: string }): Promise<Reading | null> {
	const x = await getExtraction(app, documentId);
	const list = x?.data.transactions;
	if (!x || !Array.isArray(list) || list.length === 0) return null;
	const flip = account.type === "liability" ? -1 : 1;
	const lines: StatementLine[] = [];
	for (const t of list.slice(0, MAX_LINES) as Record<string, unknown>[]) {
		const cents = wholeCents(t?.amount_cents);
		if (!isDate(t?.date) || cents === null || cents === 0) continue;
		lines.push({ date: t.date, description: String(t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300), amount_cents: cents * flip });
	}
	if (lines.length === 0) return null;
	const period = (x.data.period && typeof x.data.period === "object" ? x.data.period : {}) as Record<string, unknown>;
	const opening = wholeCents(x.data.opening_balance_cents);
	const closing = wholeCents(x.data.closing_balance_cents);
	return {
		read_at: new Date(x.updated_at).toISOString(),
		model: "",
		period_start: isDate(period.from) ? period.from : null,
		end_date: isDate(period.to) ? period.to : null,
		opening_balance_cents: opening,
		closing_balance_cents: closing,
		adds_up: addUp(lines, opening, closing),
		lines,
	};
}

/** What the statement says: from what was already read out of it, else by asking the AI. Nothing is saved or changed. */
export async function readStatement(app: App, documentId: unknown, account: { name: string; type: string; currency: string; entity_role?: "customer" | "vendor" | null }): Promise<Reading> {
	const doc = await getDocument(app, documentId);
	// What a module read out of a bank or card statement; a vendor's or customer's statement is read for what it is.
	const known = account.entity_role ? null : await readingFromExtraction(app, doc.id, account);
	if (known) return known;
	if (doc.size_bytes > MAX_STATEMENT_BYTES) throw new HttpError(413, `the statement is too large for the AI to read (${MAX_STATEMENT_BYTES / 1024 / 1024} MB at most)`, "payload_too_large");
	const pdf = doc.content_type === "application/pdf";
	const picture = /^image\/(png|jpeg|gif|webp)$/.test(doc.content_type);
	const text = TEXT_TYPES.test(doc.content_type);
	if (!pdf && !picture && !text) throw new HttpError(422, `the AI can't read this kind of file (${doc.filename}); attach the statement as a PDF, a picture, or a CSV or OFX file`, "validation_failed");
	const about =
		account.entity_role === "vendor"
			? `This is a statement of account from the vendor "${account.name}" (${account.currency}): what we owe them. Its balance is the amount owed, a positive number. Invoices, charges and interest make it go up (positive); our payments, credit notes and refunds make it go down (negative). Copy out its period, balances and every line.`
			: account.entity_role === "customer"
				? `This is a statement of account sent to the customer "${account.name}" (${account.currency}): what they owe. Its balance is the amount owed, a positive number. Invoices and charges make it go up (positive); payments and credit notes make it go down (negative). Copy out its period, balances and every line.`
				: `This is a statement for the account "${account.name}" (${account.type === "liability" ? "a credit card or loan: the balance is the amount owed" : "a bank account"}, ${account.currency}). Copy out its period, balances and every transaction line.`;
	let r;
	if (text) {
		// A statement kept as text (CSV, OFX, QFX) goes in the prompt, to the connection for text.
		const body = (await readDocument(app, doc.id)).toString("utf8");
		if (body.length > MAX_STATEMENT_TEXT) throw new HttpError(413, "the statement is too long for the AI to read in one go", "payload_too_large");
		r = await llmComplete(app, "ledger", { system: SYSTEM, prompt: `${about}\n\nThe statement file (${doc.filename}):\n\n${body}`, schema: SCHEMA });
	} else {
		const cfg = await readLlmConfig(app.integrations.dir);
		const conn = pickConnection(cfg, "images");
		if (!conn) throw new LlmError("no LLM connection for images and documents is set up; an admin can add one under Settings → LLM API", 409);
		if (pdf && !PROVIDER_INFO[conn.provider].pdf) {
			throw new LlmError(`the connection for images and documents (${conn.name}) can't read PDFs; under Settings → LLM API use a provider that does, or import the statement as a picture`, 409);
		}
		const data = (await readDocument(app, doc.id)).toString("base64");
		r = await llmComplete(app, "ledger", {
			system: SYSTEM,
			prompt: about,
			schema: SCHEMA,
			...(pdf ? { documents: [{ media_type: doc.content_type, data, name: doc.filename }] } : { images: [{ media_type: doc.content_type, data }] }),
		});
	}
	const o = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
	const lines: StatementLine[] = [];
	for (const l of Array.isArray(o.lines) ? o.lines.slice(0, MAX_LINES) : []) {
		const cents = toCents(l?.amount);
		// A line the AI couldn't give a date and an amount for is left out rather than guessed at.
		if (!isDate(l?.date) || cents === null || cents === 0) continue;
		lines.push({ date: l.date, description: String(l.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300), amount_cents: cents });
	}
	const opening = toCents(o.opening_balance);
	const closing = toCents(o.closing_balance);
	const addsUp = addUp(lines, opening, closing);
	if (lines.length === 0 && closing === null) throw new LlmError("the AI found no balance and no transactions in that document; is it a statement?", 422);
	return {
		read_at: new Date().toISOString(),
		model: r.model,
		period_start: isDate(o.period_start) ? o.period_start : null,
		end_date: isDate(o.end_date) ? o.end_date : null,
		opening_balance_cents: opening,
		closing_balance_cents: closing,
		adds_up: addsUp,
		lines,
	};
}

/**
 * Pairs statement lines with journal lines: the same amount, and the journal
 * line dated up to 60 days before the statement line (a cheque clears late)
 * or up to 5 days after it. The closest dates pair first; each line pairs once.
 */
export function matchLines(statement: StatementLine[], book: Pick<ReconciliationLine, "transaction_id" | "entry_date" | "amount_cents">[]): { matched: [number, number][]; unmatched: number[] } {
	const pairs: { s: number; b: number; gap: number }[] = [];
	statement.forEach((s, i) => {
		const day = dayOf(s.date);
		book.forEach((b, j) => {
			if (Number(b.amount_cents) !== s.amount_cents) return;
			const diff = day - dayOf(b.entry_date); // positive: the journal line is earlier
			if (diff < -5 || diff > 60) return;
			pairs.push({ s: i, b: j, gap: Math.abs(diff) });
		});
	});
	pairs.sort((x, y) => x.gap - y.gap || x.s - y.s || x.b - y.b);
	const usedS = new Set<number>();
	const usedB = new Set<number>();
	const matched: [number, number][] = [];
	for (const p of pairs) {
		if (usedS.has(p.s) || usedB.has(p.b)) continue;
		usedS.add(p.s);
		usedB.add(p.b);
		matched.push([book[p.b]!.transaction_id, p.s]);
	}
	matched.sort((a, b) => a[1] - b[1]);
	return { matched, unmatched: statement.map((_, i) => i).filter((i) => !usedS.has(i)) };
}

/** Ticks the journal lines the reading matches and records the reading. */
async function apply(app: App, id: bigint, reading: Reading): Promise<ReconciliationDetail> {
	const d = await getReconciliation(app, id);
	// Lines ticked already keep their statement line; only unticked ones are offered.
	const cleared = new Map(d.lines.filter((l) => l.cleared).map((l) => [l.transaction_id, l]));
	const kept: [number, number][] = (d.reading?.matched ?? []).filter(([t, i]) => cleared.has(t) && reading.lines[i]?.amount_cents === Number(cleared.get(t)!.amount_cents));
	const keptLines = new Set(kept.map(([, i]) => i));
	const rest = reading.lines.map((l, i) => ({ l, i })).filter((x) => !keptLines.has(x.i));
	const m = matchLines(rest.map((x) => x.l), d.lines.filter((l) => !l.cleared));
	const matched = [...kept, ...m.matched.map(([t, i]): [number, number] => [t, rest[i]!.i])].sort((a, b) => a[1] - b[1]);
	const unmatched = m.unmatched.map((i) => rest[i]!.i);
	if (m.matched.length > 0) await changeCleared(app, id, { clear: m.matched.map(([t]) => BigInt(t)), unclear: [] });
	await saveReading(app, id, { ...reading, matched, unmatched });
	return getReconciliation(app, id);
}

/** Reads the statement attached to an open reconciliation and ticks what matches. Its date and balance stay as entered. */
export async function preReconcile(app: App, id: bigint): Promise<ReconciliationDetail> {
	const d = await getReconciliation(app, id);
	const rec = d.reconciliation;
	if (rec.status !== "open") throw new ConflictError("this reconciliation is finished; undo it to make changes");
	if (rec.document_id === null) throw new ConflictError("attach the statement first");
	return apply(app, id, await readStatement(app, rec.document_id, { name: rec.account_name, type: rec.account_type, currency: rec.currency, entity_role: rec.entity_role }));
}

/** Starts a reconciliation from a statement: the AI reads its closing date and balance, then the matches are ticked. */
export async function reconcileFromStatement(app: App, input: { account_code: string; document_id: bigint }, account: { name: string; type: string; currency: string; entity_role?: "customer" | "vendor" | null }, userId: number | null): Promise<ReconciliationDetail> {
	// Checked before the AI is asked: a statement that belongs to another account isn't read for this one.
	const doc = await getDocument(app, input.document_id);
	if (doc.account_code !== null && doc.account_code !== input.account_code) {
		throw new HttpError(422, `that statement belongs to ${doc.account_code} ${doc.account_name}; change its account under Documents if that is wrong`, "validation_failed");
	}
	const reading = await readStatement(app, input.document_id, account);
	if (reading.end_date === null || reading.closing_balance_cents === null) {
		throw new LlmError("the AI couldn't find the statement's closing date and balance; enter them yourself and press Start, then use \"Read statement\" for the lines", 422);
	}
	const d = await createReconciliation(app, { account_code: input.account_code, statement_date: reading.end_date, statement_balance_cents: BigInt(reading.closing_balance_cents), document_id: input.document_id }, userId);
	return apply(app, BigInt(d.reconciliation.id), reading);
}

/**
 * A finished reconciliation's reading has been checked against the statement
 * by a person: it is kept as the statement's extraction (unless its
 * transactions were read out already), so no module reads the file again.
 * Best effort: never in the way of finishing.
 */
export async function keepReading(app: App, d: ReconciliationDetail, userId: number | null): Promise<void> {
	const rec = d.reconciliation;
	const reading = d.reading;
	if (rec.document_id === null || !reading || reading.lines.length === 0) return;
	try {
		const have = await getExtraction(app, rec.document_id);
		if (Array.isArray(have?.data.transactions) && have.data.transactions.length > 0) return;
		// The shared keys: money out negative, whatever the kind of account.
		const flip = rec.account_type === "liability" ? -1 : 1;
		await setExtraction(
			app,
			rec.document_id,
			{
				data: {
					type: "statement",
					currency: rec.currency,
					account: { name: rec.account_name, account_code: rec.account_code },
					period: { from: reading.period_start, to: reading.end_date ?? rec.statement_date },
					opening_balance_cents: reading.opening_balance_cents,
					closing_balance_cents: reading.closing_balance_cents ?? Number(rec.statement_balance_cents),
					transactions: reading.lines.map((l) => ({ date: l.date, description: l.description, amount_cents: l.amount_cents * flip })),
				},
			},
			{ moduleId: null, userId },
		);
	} catch (err) {
		log.warn("could not keep a statement's reading with its document", { document: rec.document_id, err: (err as Error).message });
	}
}

export interface ReconciliationStart {
	account_code: string;
	/** The statement, a document: shown beside the lines, and read when `lines` isn't given. */
	document_id?: number | bigint | string | null;
	/** Needed with `lines`, or when there is no document to read them from. */
	statement_date?: string;
	statement_balance_cents?: number | bigint | string;
	/** The statement's lines when the caller has read them itself, in the account's natural sign (what makes the balance go up is positive). */
	lines?: { date: string; description?: string; amount_cents: number }[];
	opening_balance_cents?: number | null;
	period_start?: string | null;
}

/**
 * For modules (ctx.reconcile.start): opens a reconciliation of an account
 * against a statement and ticks the journal lines that match its lines, so
 * a person only checks what is left. With `lines` the caller has read the
 * statement; with only a document Ledger reads it (the AI, or what was read
 * out of it before); with neither, the date and balance start an empty one.
 * An account has one open reconciliation at a time: that one is returned.
 */
export async function startReconciliation(app: App, input: ReconciliationStart, userId: number | null): Promise<ReconciliationDetail> {
	const o = (input && typeof input === "object" ? input : {}) as ReconciliationStart;
	const bad = (m: string): never => {
		throw new HttpError(422, m, "validation_failed");
	};
	if (typeof o.account_code !== "string" || o.account_code === "") bad("account_code is required");
	const acc = (await listAccounts(app, true)).find((a) => a.code === o.account_code);
	if (!acc) bad(`account ${JSON.stringify(o.account_code)} does not exist`);
	const open = (await listReconciliations(app, acc!.code)).find((r) => r.status === "open");
	if (open) return getReconciliation(app, BigInt(open.id));
	const account = { name: acc!.name, type: acc!.type, currency: acc!.currency, entity_role: acc!.entity?.role ?? null };
	const documentId = o.document_id === undefined || o.document_id === null || o.document_id === "" ? null : /^[1-9]\d{0,17}$/.test(String(o.document_id)) ? BigInt(String(o.document_id)) : bad("document_id must be a document's number");
	const cents = (x: unknown, what: string): bigint => (typeof x === "bigint" ? x : typeof x === "number" && Number.isSafeInteger(x) ? BigInt(x) : typeof x === "string" && /^-?\d{1,15}$/.test(x) ? BigInt(x) : bad(`${what} must be a whole number of cents`));
	if (o.lines === undefined && documentId !== null && (o.statement_date === undefined || o.statement_balance_cents === undefined)) {
		return reconcileFromStatement(app, { account_code: acc!.code, document_id: documentId }, account, userId);
	}
	if (!isDate(o.statement_date)) bad("statement_date must be a date (YYYY-MM-DD)");
	if (o.statement_balance_cents === undefined) bad("statement_balance_cents is required");
	const closing = cents(o.statement_balance_cents, "statement_balance_cents");
	const d = await createReconciliation(app, { account_code: acc!.code, statement_date: o.statement_date!, statement_balance_cents: closing, document_id: documentId }, userId);
	if (o.lines === undefined) return documentId === null ? d : preReconcile(app, BigInt(d.reconciliation.id)).catch(() => d);
	if (!Array.isArray(o.lines) || o.lines.length > MAX_LINES) bad(`lines must be a list of at most ${MAX_LINES}`);
	const lines: StatementLine[] = [];
	o.lines.forEach((l, i) => {
		if (!isDate(l?.date) || !Number.isSafeInteger(l?.amount_cents) || l.amount_cents === 0) bad(`lines[${i}] needs a date (YYYY-MM-DD) and amount_cents (whole cents, not 0)`);
		lines.push({ date: l.date, description: String(l.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300), amount_cents: l.amount_cents });
	});
	const opening = o.opening_balance_cents === undefined || o.opening_balance_cents === null ? null : Number(cents(o.opening_balance_cents, "opening_balance_cents"));
	return apply(app, BigInt(d.reconciliation.id), {
		read_at: new Date().toISOString(),
		model: "",
		period_start: isDate(o.period_start) ? o.period_start : null,
		end_date: o.statement_date!,
		opening_balance_cents: opening,
		closing_balance_cents: Number(closing),
		adds_up: addUp(lines, opening, Number(closing)),
		lines,
	});
}
