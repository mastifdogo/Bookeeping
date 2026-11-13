import type { App } from "./app.ts";
import { withTx, queryRow, queryRows, toNumber, type Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { MAX_CENTS, formatCents, splitAmount } from "./money.ts";
import { checkText, quote, trimSpace } from "./text.ts";
import { dateYear, today } from "./date.ts";
import {
	ACCOUNT_CODE_RE,
	type Currency,
	type CurrencyTotal,
	type EntryLink,
	type EntryLinkInput,
	type JournalEntry,
	type JournalEntryCreate,
	type JournalLine,
	type JournalLineCreate,
	type ReverseRequest,
} from "./types.ts";

const MIN_LINES_PER_ENTRY = 2;
const MAX_LINES_PER_ENTRY = 1000;

/**
 * How validators name fields in error messages, so the same checks can report
 * "lines[1].account_code" for the JSON API and "row 7.account_code" for CSV
 * imports.
 */
export interface FieldNames {
	entry(field: string): string;
	line(i: number, field: string): string;
}

export const jsonFieldNames: FieldNames = {
	entry: (f) => f,
	line: (i, f) => (f === "" ? `lines[${i}]` : `lines[${i}].${f}`),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks the double-entry rules that need no database access, so callers get
 * precise, per-field errors. Per-currency balance is checked once account
 * currencies are known (checkLinesPostable), and the database re-checks the
 * critical invariants with constraints and triggers.
 */
export function validateJournalEntry(e: JournalEntryCreate): void {
	const v = new ValidationError();
	validateEntry(v, e, jsonFieldNames);
	v.throwIfAny();
}

export function validateEntry(v: ValidationError, e: JournalEntryCreate, fn: FieldNames): void {
	const start = v.size;

	if (e.entry_date === "") {
		v.add(fn.entry("entry_date"), "is required");
	} else {
		const y = dateYear(e.entry_date);
		if (y < 1900 || y > 9999) v.add(fn.entry("entry_date"), "year must be between 1900 and 9999");
	}
	checkText(v, fn.entry("description"), e.description, 1, 500);
	checkText(v, fn.entry("reference"), e.reference, 0, 100);

	const n = e.lines.length;
	if (n < MIN_LINES_PER_ENTRY) {
		v.add(fn.entry("lines"), `a journal entry needs at least ${MIN_LINES_PER_ENTRY} lines, got ${n}`);
	} else if (n > MAX_LINES_PER_ENTRY) {
		v.add(fn.entry("lines"), `a journal entry may have at most ${MAX_LINES_PER_ENTRY} lines, got ${n}`);
		return; // don't produce thousands of per-line errors
	}

	let totalDebit = 0n;
	let totalCredit = 0n;
	let overflow = false;
	for (const [i, l] of e.lines.entries()) {
		if (!ACCOUNT_CODE_RE.test(l.account_code)) {
			if (l.account_code === "") v.add(fn.line(i, "account_code"), "is required");
			else v.add(fn.line(i, "account_code"), `${quote(l.account_code)} is not a valid account code`);
		}
		checkText(v, fn.line(i, "memo"), l.memo, 0, 500);

		if (l.debit_cents < 0n || l.credit_cents < 0n) {
			v.add(fn.line(i, ""), "debit and credit must not be negative");
			continue;
		}
		if (l.debit_cents > MAX_CENTS || l.credit_cents > MAX_CENTS) {
			v.add(fn.line(i, ""), `amount exceeds the maximum of ${MAX_CENTS} cents`);
			continue;
		}
		if (l.debit_cents > 0n && l.credit_cents > 0n) {
			v.add(fn.line(i, ""), "a line must be either a debit or a credit, not both");
			continue;
		}
		if (l.debit_cents === 0n && l.credit_cents === 0n) {
			v.add(fn.line(i, ""), "a line must have a non-zero debit or credit");
			continue;
		}
		totalDebit += l.debit_cents;
		totalCredit += l.credit_cents;
		if (totalDebit > MAX_CENTS || totalCredit > MAX_CENTS) {
			overflow = true;
			break;
		}
	}

	// Balancing per currency implies balancing overall, so an overall
	// mismatch can be reported before account currencies are known.
	if (overflow) {
		v.add(fn.entry("lines"), `entry total exceeds the maximum of ${MAX_CENTS} cents`);
	} else if (v.size === start && totalDebit !== totalCredit) {
		v.add(
			fn.entry("lines"),
			`entry is unbalanced: debits ${formatCents(totalDebit)}, credits ${formatCents(totalCredit)} (difference ${formatCents(totalDebit - totalCredit)})`,
		);
	}
}

// ---------------------------------------------------------------------------
// Account resolution (codes -> ids, inside the posting transaction)
// ---------------------------------------------------------------------------

export interface PostingAccount {
	id: bigint;
	currency: Currency;
	active: boolean;
}

/**
 * Loads the given account codes and takes a share lock on them, so an account
 * cannot be deactivated by a concurrent request before the posting
 * transaction commits.
 */
export async function lockAccounts(tx: Queryable, codes: string[]): Promise<Map<string, PostingAccount>> {
	const rows = await queryRows<{ code: string; id: bigint; currency: Currency; is_active: boolean }>(
		tx,
		`SELECT code, id, currency, is_active
		   FROM accounts WHERE code = ANY($1)
		  ORDER BY id FOR SHARE`,
		[codes],
	);
	return new Map(rows.map((r) => [r.code, { id: r.id, currency: r.currency, active: r.is_active }]));
}

export function lineCodes(lines: JournalLineCreate[]): string[] {
	return lines.map((l) => l.account_code);
}

export function sortedKeys<V>(m: Map<Currency, V>): Currency[] {
	return [...m.keys()].sort();
}

/**
 * Verifies every line's account exists and is active, and that the entry
 * balances within each currency.
 */
export function checkLinesPostable(
	v: ValidationError,
	e: JournalEntryCreate,
	accounts: Map<string, PostingAccount>,
	fn: FieldNames,
): void {
	const start = v.size;
	const sums = new Map<Currency, bigint>();
	for (const [i, l] of e.lines.entries()) {
		const acc = accounts.get(l.account_code);
		if (!acc) {
			v.add(fn.line(i, "account_code"), `account ${quote(l.account_code)} does not exist`);
		} else if (!acc.active) {
			v.add(fn.line(i, "account_code"), `account ${quote(l.account_code)} is inactive`);
		} else {
			sums.set(acc.currency, (sums.get(acc.currency) ?? 0n) + l.debit_cents - l.credit_cents);
		}
	}
	if (v.size > start) return;
	for (const c of sortedKeys(sums)) {
		const d = sums.get(c)!;
		if (d !== 0n) {
			v.add(
				fn.entry("lines"),
				`entry is unbalanced in ${c}: debits minus credits = ${formatCents(d)}; ` +
					"post cross-currency amounts through an FX clearing account in each currency",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Writing journal entries
// ---------------------------------------------------------------------------

/**
 * Validates a journal entry and writes the header and all of its lines
 * atomically:
 *
 *   BEGIN
 *     lock referenced accounts (FOR SHARE); check existence, activity and
 *     per-currency balance
 *     INSERT journal_entries ...
 *     INSERT transactions ... (all lines, one statement)
 *   COMMIT  <- deferred triggers verify >= 2 lines and per-currency zero sum
 *
 * Any failure, including the COMMIT-time balance check, rolls everything back.
 */
export async function createJournalEntry(
	app: App,
	e: JournalEntryCreate,
	actorId: number | null,
	links?: { moduleId: string; links: EntryLinkInput[] },
): Promise<JournalEntry> {
	validateJournalEntry(e);
	if (links) for (const l of links.links) validateLink(l);
	const id = await withTx(app.db, {}, async (tx) => {
		const accounts = await lockAccounts(tx, lineCodes(e.lines));
		const v = new ValidationError();
		checkLinesPostable(v, e, accounts, jsonFieldNames);
		if (e.entity_id !== null && e.entity_id !== undefined) {
			const ent = Number.isSafeInteger(e.entity_id) && e.entity_id > 0 ? await queryRow<{ is_active: boolean }>(tx, `SELECT is_active FROM entities WHERE id = $1`, [e.entity_id]) : null;
			if (!ent) v.add("entity_id", "there is no such customer or vendor");
			else if (!ent.is_active) v.add("entity_id", "that customer or vendor is inactive");
		}
		v.throwIfAny();
		const id = await insertJournalEntry(tx, e, accounts, null, null, actorId);
		// Posted and linked together, or neither.
		if (links) for (const l of links.links) await insertLink(tx, id, links.moduleId, l, actorId);
		return id;
	});
	return getJournalEntry(app, id);
}

// ---------------------------------------------------------------------------
// Links from entries to module records
// ---------------------------------------------------------------------------

/** Checks a link from a module; throws a 422 naming the problem. */
export function validateLink(l: EntryLinkInput): void {
	const v = new ValidationError();
	const o = (l ?? {}) as unknown as Record<string, unknown>;
	if (typeof o.ref !== "string" || o.ref.length < 1 || o.ref.length > 200) v.add("link.ref", "must be 1-200 characters");
	if (typeof o.label !== "string" || o.label.trim().length < 1 || o.label.length > 200) v.add("link.label", "must be 1-200 characters");
	if (o.href !== undefined && o.href !== "" && (typeof o.href !== "string" || !/^\/[^/\\]/.test(o.href) || o.href.length > 500)) {
		v.add("link.href", "must be a path inside Ledger, like /apps/<module>?id=31");
	}
	v.throwIfAny();
}

async function insertLink(db: Queryable, entryId: bigint, moduleId: string, l: EntryLinkInput, actorId: number | null): Promise<void> {
	await db.query(
		`INSERT INTO journal_entry_links (entry_id, module_id, ref, label, href, created_by) VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (entry_id, module_id, ref) DO UPDATE SET label = EXCLUDED.label, href = EXCLUDED.href`,
		[entryId, moduleId, l.ref, l.label.trim(), l.href ?? "", actorId],
	);
}

/** Links an existing entry to a module's record (or updates that link's label and href). */
export async function linkJournalEntry(app: App, entryId: bigint, moduleId: string, l: EntryLinkInput, actorId: number | null): Promise<JournalEntry> {
	validateLink(l);
	const exists = await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]);
	if (!exists) throw new NotFoundError();
	await insertLink(app.db, entryId, moduleId, l, actorId);
	return getJournalEntry(app, entryId);
}

/** Removes a module's link from an entry; false if there was none. */
export async function unlinkJournalEntry(app: App, entryId: bigint, moduleId: string, ref: string): Promise<boolean> {
	const r = await app.db.query(`DELETE FROM journal_entry_links WHERE entry_id = $1 AND module_id = $2 AND ref = $3`, [entryId, moduleId, String(ref)]);
	return (r.rowCount ?? 0) > 0;
}

/** The entries a module linked to one of its records (or all of its links without ref). */
export async function linkedEntries(app: App, moduleId: string, ref?: string): Promise<{ entry_id: number; ref: string; label: string; href: string; reversed: boolean }[]> {
	const rows = await queryRows<{ entry_id: bigint; ref: string; label: string; href: string; reversed: boolean }>(
		app.db,
		`SELECT l.entry_id, l.ref, l.label, l.href,
		        (e.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id)) AS reversed
		   FROM journal_entry_links l JOIN journal_entries e ON e.id = l.entry_id
		  WHERE l.module_id = $1 AND ($2::text IS NULL OR l.ref = $2)
		  ORDER BY l.entry_id DESC LIMIT 1000`,
		[moduleId, ref ?? null],
	);
	return rows.map((r) => ({ ...r, entry_id: Number(r.entry_id) }));
}

/**
 * Writes the header and its lines inside tx and returns the new entry id.
 * Must only be called inside a transaction, with every line's account present
 * in accounts.
 */
export async function insertJournalEntry(
	tx: Queryable,
	e: JournalEntryCreate,
	accounts: Map<string, PostingAccount>,
	reversesId: bigint | null,
	importId: bigint | null,
	actorId: number | null,
): Promise<bigint> {
	const row = await queryRow<{ id: bigint }>(
		tx,
		`INSERT INTO journal_entries (entry_date, description, reference, reverses_id, import_id, created_by, entity_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[e.entry_date, trimSpace(e.description), trimSpace(e.reference), reversesId, importId, actorId, e.entity_id ?? null],
	);
	const id = row!.id;

	const n = e.lines.length;
	const accountIds: bigint[] = [];
	const currencies: string[] = [];
	const lineNumbers: number[] = [];
	const amounts: bigint[] = [];
	const memos: string[] = [];
	for (const [i, l] of e.lines.entries()) {
		const acc = accounts.get(l.account_code);
		if (!acc) throw new Error(`insert transaction lines: account ${quote(l.account_code)} was not resolved`);
		accountIds.push(acc.id);
		currencies.push(acc.currency);
		lineNumbers.push(i + 1);
		amounts.push(l.debit_cents - l.credit_cents); // debit > 0, credit < 0
		memos.push(trimSpace(l.memo));
	}

	const r = await tx.query(
		`INSERT INTO transactions (journal_entry_id, account_id, currency, line_number, amount, memo)
		 SELECT $1, l.account_id, l.currency, l.line_number, l.amount, l.memo
		   FROM unnest($2::bigint[], $3::text[], $4::int[], $5::bigint[], $6::text[])
		        AS l(account_id, currency, line_number, amount, memo)`,
		[id, accountIds, currencies, lineNumbers, amounts, memos],
	);
	if (r.rowCount !== n) throw new Error(`insert transaction lines: wrote ${r.rowCount} of ${n} lines`);
	return id;
}

/**
 * Writes many journal entries inside tx with three statements in total (one
 * to reserve ids, one for the headers, one for all lines), and returns their
 * ids in order. Ids ascend in the order given, exactly as one-by-one inserts
 * would assign them. Used by CSV imports, where tens of thousands of
 * single-entry round trips would be slow. The deferred triggers still check
 * every entry at COMMIT.
 */
export async function insertJournalEntries(
	tx: Queryable,
	entries: JournalEntryCreate[],
	accounts: Map<string, PostingAccount>,
	importId: bigint | null,
	actorId: number | null,
): Promise<bigint[]> {
	if (entries.length === 0) return [];
	const ids = (
		await queryRows<{ id: bigint }>(
			tx,
			`SELECT nextval(pg_get_serial_sequence('journal_entries', 'id')) AS id
			   FROM generate_series(1, $1) ORDER BY id`,
			[entries.length],
		)
	).map((r) => r.id);

	await tx.query(
		`INSERT INTO journal_entries (id, entry_date, description, reference, import_id, created_by)
		 OVERRIDING SYSTEM VALUE
		 SELECT h.id, h.entry_date, h.description, h.reference, $5, $6
		   FROM unnest($1::bigint[], $2::date[], $3::text[], $4::text[]) AS h(id, entry_date, description, reference)`,
		[ids, entries.map((e) => e.entry_date), entries.map((e) => trimSpace(e.description)), entries.map((e) => trimSpace(e.reference)), importId, actorId],
	);

	const entryIds: bigint[] = [];
	const accountIds: bigint[] = [];
	const currencies: string[] = [];
	const lineNumbers: number[] = [];
	const amounts: bigint[] = [];
	const memos: string[] = [];
	for (const [n, e] of entries.entries()) {
		for (const [i, l] of e.lines.entries()) {
			const acc = accounts.get(l.account_code);
			if (!acc) throw new Error(`insert transaction lines: account ${quote(l.account_code)} was not resolved`);
			entryIds.push(ids[n]!);
			accountIds.push(acc.id);
			currencies.push(acc.currency);
			lineNumbers.push(i + 1);
			amounts.push(l.debit_cents - l.credit_cents); // debit > 0, credit < 0
			memos.push(trimSpace(l.memo));
		}
	}
	const r = await tx.query(
		`INSERT INTO transactions (journal_entry_id, account_id, currency, line_number, amount, memo)
		 SELECT l.journal_entry_id, l.account_id, l.currency, l.line_number, l.amount, l.memo
		   FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[], $5::bigint[], $6::text[])
		        AS l(journal_entry_id, account_id, currency, line_number, amount, memo)`,
		[entryIds, accountIds, currencies, lineNumbers, amounts, memos],
	);
	if (r.rowCount !== entryIds.length) throw new Error(`insert transaction lines: wrote ${r.rowCount} of ${entryIds.length} lines`);
	return ids;
}

/**
 * Posts a new entry that swaps every debit and credit of the original, in one
 * transaction. Reversals cannot themselves be reversed, and an entry can be
 * reversed only once (also enforced by a UNIQUE index).
 */
export async function reverseJournalEntry(app: App, id: bigint, req: ReverseRequest, actorId: number | null): Promise<JournalEntry> {
	const orig = await getJournalEntry(app, id);
	if (orig.reverses_id !== null) {
		throw new ConflictError(`entry ${id} is itself a reversal and cannot be reversed`);
	}
	if (orig.reversed_by_id !== null) {
		throw new ConflictError(`entry ${id} was already reversed by entry ${orig.reversed_by_id}`);
	}

	const e: JournalEntryCreate = {
		entry_date: req.entry_date ?? today(),
		description: trimSpace(req.description ?? "") !== "" ? req.description! : `Reversal of entry #${id}`,
		reference: orig.reference,
		lines: orig.lines.map((l) => ({
			account_code: l.account_code,
			debit_cents: l.credit_cents,
			credit_cents: l.debit_cents,
			memo: l.memo,
		})),
	};
	validateJournalEntry(e);

	const newId = await withTx(app.db, {}, async (tx) => {
		const accounts = await lockAccounts(tx, lineCodes(e.lines));
		const v = new ValidationError();
		checkLinesPostable(v, e, accounts, jsonFieldNames);
		v.throwIfAny();
		return insertJournalEntry(tx, e, accounts, id, null, actorId);
	});
	return getJournalEntry(app, newId);
}

// ---------------------------------------------------------------------------
// Reading journal entries
// ---------------------------------------------------------------------------

const ENTRY_SELECT = `
	SELECT e.id, e.entry_date, e.description, e.reference, e.reverses_id,
	       r.id AS reversed_by_id, e.import_id, u.username, e.posted_at, e.entity_id, en.name AS entity_name
	  FROM journal_entries e
	  LEFT JOIN journal_entries r ON r.reverses_id = e.id
	  LEFT JOIN users u ON u.id = e.created_by
	  LEFT JOIN entities en ON en.id = e.entity_id`;

interface EntryRow {
	id: bigint;
	entry_date: string;
	description: string;
	reference: string;
	reverses_id: bigint | null;
	reversed_by_id: bigint | null;
	import_id: bigint | null;
	username: string | null;
	posted_at: Date;
	entity_id: bigint | null;
	entity_name: string | null;
}

function toEntry(r: EntryRow): JournalEntry {
	return {
		id: Number(r.id),
		entry_date: r.entry_date,
		description: r.description,
		reference: r.reference,
		reverses_id: toNumber(r.reverses_id),
		reversed_by_id: toNumber(r.reversed_by_id),
		import_id: toNumber(r.import_id),
		created_by: r.username,
		entity: r.entity_id === null ? null : { id: Number(r.entity_id), name: r.entity_name ?? "" },
		posted_at: r.posted_at,
		totals: [],
		lines: [],
		links: [],
	};
}

export async function getJournalEntry(app: App, id: bigint): Promise<JournalEntry> {
	const row = await queryRow<EntryRow>(app.db, ENTRY_SELECT + ` WHERE e.id = $1`, [id]);
	if (!row) throw new NotFoundError();
	const e = toEntry(row);
	await attachLines(app, [e]);
	return e;
}

export interface EntryFilter {
	from: string | null;
	to: string | null;
	accountCode: string | null;
	/** Only entries with this entity (vendor, customer). */
	entityId?: number | null;
	/** Leave out reversed entries and the entries that reverse them. */
	hideReversed?: boolean;
	limit: number;
	offset: number;
}

export async function listJournalEntries(app: App, f: EntryFilter): Promise<JournalEntry[]> {
	const rows = await queryRows<EntryRow>(
		app.db,
		ENTRY_SELECT +
			`
		WHERE ($1::date IS NULL OR e.entry_date >= $1)
		  AND ($2::date IS NULL OR e.entry_date <= $2)
		  AND ($3::text IS NULL OR EXISTS (
		        SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
		         WHERE t.journal_entry_id = e.id AND a.code = $3))
		  AND (NOT $6 OR (e.reverses_id IS NULL AND r.id IS NULL))
		  AND ($7::bigint IS NULL OR e.entity_id = $7)
		ORDER BY e.entry_date DESC, e.id DESC
		LIMIT $4 OFFSET $5`,
		[f.from, f.to, f.accountCode, f.limit, f.offset, f.hideReversed === true, f.entityId ?? null],
	);
	const entries = rows.map(toEntry);
	await attachLines(app, entries);
	return entries;
}

/** Loads lines for all given entries in one query and computes each entry's per-currency totals. */
async function attachLines(app: App, entries: JournalEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const byId = new Map(entries.map((e) => [e.id, e]));
	const links = await queryRows<EntryLink & { entry_id: bigint }>(
		app.db,
		`SELECT entry_id, module_id, ref, label, href, created_at FROM journal_entry_links WHERE entry_id = ANY($1) ORDER BY id`,
		[entries.map((e) => e.id)],
	);
	for (const { entry_id, ...l } of links) byId.get(Number(entry_id))!.links.push(l);
	const rows = await queryRows<{
		journal_entry_id: bigint;
		id: bigint;
		line_number: number;
		code: string;
		name: string;
		currency: Currency;
		amount: bigint;
		memo: string;
	}>(
		app.db,
		`SELECT t.journal_entry_id, t.id, t.line_number, a.code, a.name, t.currency, t.amount, t.memo
		   FROM transactions t
		   JOIN accounts a ON a.id = t.account_id
		  WHERE t.journal_entry_id = ANY($1)
		  ORDER BY t.journal_entry_id, t.line_number`,
		[entries.map((e) => e.id)],
	);
	const totals = new Map<number, Map<Currency, bigint>>();
	for (const r of rows) {
		const entryId = Number(r.journal_entry_id);
		const [debit, credit] = splitAmount(r.amount);
		const line: JournalLine = {
			id: Number(r.id),
			line_number: r.line_number,
			account_code: r.code,
			account_name: r.name,
			currency: r.currency,
			debit_cents: debit,
			credit_cents: credit,
			memo: r.memo,
		};
		byId.get(entryId)!.lines.push(line);
		let t = totals.get(entryId);
		if (!t) totals.set(entryId, (t = new Map()));
		t.set(r.currency, (t.get(r.currency) ?? 0n) + debit);
	}
	for (const [id, m] of totals) {
		byId.get(id)!.totals = sortedKeys(m).map((c): CurrencyTotal => ({ currency: c, amount_cents: m.get(c)! }));
	}
}
