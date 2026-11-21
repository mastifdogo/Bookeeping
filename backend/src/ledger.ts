import type { App } from "./app.ts";
import { relatedEntries } from "./related.ts";
import { tagsOfEntries } from "./tags.ts";
import { entryMoves, syncUnreconciledLater, UNRECONCILED_WHERE } from "./unreconciled.ts";
import { withTx, queryRow, queryRows, toNumber, type Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { MAX_CENTS, formatCents, splitAmount } from "./money.ts";
import { checkText, quote, trimSpace } from "./text.ts";
import { dateYear, parseDate, today } from "./date.ts";
import {
	ACCOUNT_CODE_RE,
	type Currency,
	type CurrencyTotal,
	type EntryAmend,
	type EntryChange,
	type EntryDateChange,
	type EntryEdit,
	type EntryFieldEdit,
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
	       r.id AS reversed_by_id, e.import_id, u.username, e.posted_at, e.entity_id, en.name AS entity_name,
	       EXISTS (SELECT 1 FROM transaction_changes c WHERE c.journal_entry_id = e.id) AS amended
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
		tags: [],
		amended: (r as EntryRow & { amended?: boolean }).amended === true,
	};
}

/** Every change made to an entry's amounts, oldest first. */
async function entryChanges(db: Queryable, id: bigint): Promise<EntryChange[]> {
	const rows = await queryRows<{ id: bigint; line_number: number; code: string; name: string; currency: Currency; old_amount: bigint; new_amount: bigint; reason: string; username: string | null; changed_at: Date }>(
		db,
		`SELECT c.id, t.line_number, a.code, a.name, t.currency, c.old_amount, c.new_amount, c.reason, u.username, c.changed_at
		   FROM transaction_changes c
		   JOIN transactions t ON t.id = c.transaction_id
		   JOIN accounts a ON a.id = t.account_id
		   LEFT JOIN users u ON u.id = c.changed_by
		  WHERE c.journal_entry_id = $1 ORDER BY c.id`,
		[id],
	);
	return rows.map((r) => {
		const [od, oc] = splitAmount(r.old_amount);
		const [nd, nc] = splitAmount(r.new_amount);
		return { id: Number(r.id), line_number: r.line_number, account_code: r.code, account_name: r.name, currency: r.currency, old_debit_cents: od, old_credit_cents: oc, new_debit_cents: nd, new_credit_cents: nc, reason: r.reason, changed_by: r.username, changed_at: r.changed_at };
	});
}

/**
 * Changes the amounts of a posted entry's lines. The entry must still
 * balance in each currency. Refused for an entry that was reversed or is a
 * reversal (the pair must keep mirroring each other) and for lines ticked
 * on a reconciliation (the reconciled balance would no longer be true).
 * The database logs every changed line with who changed it and why.
 */
export async function amendEntryAmounts(app: App, id: bigint, input: EntryAmend, actorId: number | null): Promise<JournalEntry> {
	const orig = await getJournalEntry(app, id);
	if (orig.reverses_id !== null) throw new ConflictError(`entry ${id} is a reversal; its amounts follow the entry it reverses`);
	if (orig.reversed_by_id !== null) throw new ConflictError(`entry ${id} was reversed by entry ${orig.reversed_by_id}; its amounts can't change any more`);
	const v = new ValidationError();
	const reason = trimSpace(input.reason ?? "");
	if (reason.length > 500) v.add("reason", "must be at most 500 characters");
	if (!Array.isArray(input.lines) || input.lines.length === 0) v.add("lines", "give the lines to change");
	v.throwIfAny();
	const byNumber = new Map(orig.lines.map((l) => [l.line_number, l]));
	const next = new Map<number, bigint>(orig.lines.map((l) => [l.line_number, l.debit_cents - l.credit_cents]));
	const seen = new Set<number>();
	input.lines.forEach((l, i) => {
		const f = `lines[${i}]`;
		const cur = byNumber.get(l.line_number);
		if (!cur) return v.add(`${f}.line_number`, `entry ${id} has no line ${l.line_number}`);
		if (seen.has(l.line_number)) return v.add(`${f}.line_number`, "is given twice");
		seen.add(l.line_number);
		if (l.debit_cents < 0n || l.credit_cents < 0n) return v.add(f, "amounts can't be negative");
		if ((l.debit_cents > 0n) === (l.credit_cents > 0n)) return v.add(f, "give a debit or a credit, not both and not neither");
		if (l.debit_cents > MAX_CENTS || l.credit_cents > MAX_CENTS) return v.add(f, "the amount is too large");
		next.set(l.line_number, l.debit_cents - l.credit_cents);
	});
	v.throwIfAny();
	const changed = orig.lines.filter((l) => next.get(l.line_number) !== l.debit_cents - l.credit_cents);
	if (changed.length === 0) {
		v.add("lines", "the amounts are the same as before");
		v.throwIfAny();
	}
	// Each currency must still balance.
	const sums = new Map<Currency, bigint>();
	for (const l of orig.lines) sums.set(l.currency, (sums.get(l.currency) ?? 0n) + next.get(l.line_number)!);
	for (const [cur, sum] of sums) {
		if (sum !== 0n) v.add("lines", `the ${cur} lines don't balance: debits and credits differ by ${formatCents(sum < 0n ? -sum : sum)}`);
	}
	v.throwIfAny();

	await withTx(app.db, {}, async (tx) => {
		const ticked = await queryRow<{ line_number: number; statement_date: string; status: string }>(
			tx,
			`SELECT t.line_number, r.statement_date, r.status
			   FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id JOIN reconciliations r ON r.id = l.reconciliation_id
			  WHERE t.id = ANY($1::bigint[]) ORDER BY t.line_number LIMIT 1`,
			[changed.map((l) => l.id)],
		);
		if (ticked) {
			throw new ConflictError(
				`line ${ticked.line_number} is ticked on the reconciliation to ${ticked.statement_date}; ${ticked.status === "finished" ? "undo that reconciliation" : "untick it there"} before changing its amount`,
			);
		}
		// The database only lets an amount change inside a transaction that says who is changing it, and logs it.
		await tx.query(`SELECT set_config('ledger.amend_by', $1, true), set_config('ledger.amend_reason', $2, true)`, [String(actorId ?? "system"), reason]);
		for (const l of changed) await tx.query(`UPDATE transactions SET amount = $2 WHERE id = $1`, [l.id, next.get(l.line_number)]);
	});
	return getJournalEntry(app, id);
}

/**
 * Changes the date of a posted entry. Refused while one of its lines is
 * ticked on a reconciliation (the reconciled statement would no longer
 * hold). The database logs the old and new date, who changed it and why.
 */
export async function changeEntryDate(app: App, id: bigint, input: { entry_date: string; reason?: string }, actorId: number | null): Promise<JournalEntry> {
	const orig = await getJournalEntry(app, id);
	const v = new ValidationError();
	const reason = trimSpace(input.reason ?? "");
	if (reason.length > 500) v.add("reason", "must be at most 500 characters");
	const d = input.entry_date;
	let ok = false;
	try {
		ok = typeof d === "string" && parseDate(d) === d;
	} catch {
		// not a date
	}
	if (!ok) v.add("entry_date", "must be a date (YYYY-MM-DD)");
	else if (dateYear(d) < 1900 || dateYear(d) > 9999) v.add("entry_date", "year must be between 1900 and 9999");
	else if (d === orig.entry_date) v.add("entry_date", "is the same as before");
	v.throwIfAny();
	await withTx(app.db, {}, async (tx) => {
		const ticked = await queryRow<{ statement_date: string; status: string }>(
			tx,
			`SELECT r.statement_date, r.status
			   FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id JOIN reconciliations r ON r.id = l.reconciliation_id
			  WHERE t.journal_entry_id = $1 LIMIT 1`,
			[id],
		);
		if (ticked) {
			throw new ConflictError(
				`a line of this entry is ticked on the reconciliation to ${ticked.statement_date}; ${ticked.status === "finished" ? "undo that reconciliation" : "untick it there"} before changing its date`,
			);
		}
		await tx.query(`SELECT set_config('ledger.amend_by', $1, true), set_config('ledger.amend_reason', $2, true)`, [String(actorId ?? "system"), reason]);
		await tx.query(`UPDATE journal_entries SET entry_date = $2 WHERE id = $1`, [id, d]);
	});
	return getJournalEntry(app, id);
}

/** Every change to an entry's date, oldest first. */
async function entryDateChanges(db: Queryable, id: bigint): Promise<EntryDateChange[]> {
	const rows = await queryRows<{ id: bigint; old_date: string; new_date: string; reason: string; username: string | null; changed_at: Date }>(
		db,
		`SELECT c.id, c.old_date, c.new_date, c.reason, u.username, c.changed_at
		   FROM journal_entry_date_changes c LEFT JOIN users u ON u.id = c.changed_by
		  WHERE c.journal_entry_id = $1 ORDER BY c.id`,
		[id],
	);
	return rows.map((r) => ({ id: Number(r.id), old_date: r.old_date, new_date: r.new_date, reason: r.reason, changed_by: r.username, changed_at: r.changed_at }));
}

/** Every change to an entry's description, reference, customer or vendor, and its lines' memos, oldest first. */
async function entryFieldEdits(db: Queryable, id: bigint): Promise<EntryFieldEdit[]> {
	const rows = await queryRows<{ id: bigint; field: EntryFieldEdit["field"]; line_number: number | null; old_value: string; new_value: string; reason: string; username: string | null; changed_at: Date }>(
		db,
		`SELECT c.id, c.field, t.line_number, c.old_value, c.new_value, c.reason, u.username, c.changed_at
		   FROM journal_entry_edits c LEFT JOIN transactions t ON t.id = c.transaction_id LEFT JOIN users u ON u.id = c.changed_by
		  WHERE c.journal_entry_id = $1 ORDER BY c.id`,
		[id],
	);
	return rows.map((r) => ({ id: Number(r.id), field: r.field, line_number: r.line_number, old_value: r.old_value, new_value: r.new_value, reason: r.reason, changed_by: r.username, changed_at: r.changed_at }));
}

/**
 * The entry page's "Edit": changes whatever is given of a posted entry's
 * date, description, reference and customer or vendor, and of its lines'
 * accounts, memos and amounts; what isn't given, or is the same as before,
 * stays. Lines can't be added or taken away, and a line stays in its
 * currency. The entry must still balance. Amounts and accounts are refused
 * on an entry that was reversed or is a reversal, and on a line ticked on a
 * reconciliation; the date on an entry with any ticked line. All of it is
 * saved together or not at all, and the database logs every change with who
 * made it and why.
 */
export async function editJournalEntry(app: App, id: bigint, input: EntryEdit, actorId: number | null): Promise<JournalEntry> {
	const orig = await getJournalEntry(app, id);
	const v = new ValidationError();
	const reason = trimSpace(input.reason ?? "");
	if (reason.length > 500) v.add("reason", "must be at most 500 characters");

	// The entry's own fields: only those that really change.
	const head: { entry_date?: string; description?: string; reference?: string; entity_id?: number | null } = {};
	if (input.entry_date !== undefined && input.entry_date !== orig.entry_date) {
		const d = input.entry_date;
		let ok = false;
		try {
			ok = parseDate(d) === d;
		} catch {
			// not a date
		}
		if (!ok) v.add("entry_date", "must be a date (YYYY-MM-DD)");
		else if (dateYear(d) < 1900 || dateYear(d) > 9999) v.add("entry_date", "year must be between 1900 and 9999");
		else head.entry_date = d;
	}
	if (input.description !== undefined) {
		checkText(v, "description", input.description, 1, 500);
		if (trimSpace(input.description) !== orig.description) head.description = trimSpace(input.description);
	}
	if (input.reference !== undefined) {
		checkText(v, "reference", trimSpace(input.reference), 0, 100);
		if (trimSpace(input.reference) !== orig.reference) head.reference = trimSpace(input.reference);
	}
	if (input.entity_id !== undefined && input.entity_id !== (orig.entity?.id ?? null)) {
		if (input.entity_id !== null && !(Number.isSafeInteger(input.entity_id) && input.entity_id > 0)) v.add("entity_id", "there is no such customer or vendor");
		else head.entity_id = input.entity_id;
	}

	// The lines: only what really changes of each.
	const byNumber = new Map(orig.lines.map((l) => [l.line_number, l]));
	const amounts = new Map<number, bigint>();
	const accounts = new Map<number, string>();
	const memos = new Map<number, string>();
	const seen = new Set<number>();
	(input.lines ?? []).forEach((l, i) => {
		const f = `lines[${i}]`;
		const cur = byNumber.get(l.line_number);
		if (!cur) return v.add(`${f}.line_number`, `entry ${id} has no line ${l.line_number}`);
		if (seen.has(l.line_number)) return v.add(`${f}.line_number`, "is given twice");
		seen.add(l.line_number);
		if (l.account_code !== undefined && l.account_code !== cur.account_code) accounts.set(l.line_number, l.account_code);
		if (l.memo !== undefined) {
			checkText(v, `${f}.memo`, trimSpace(l.memo), 0, 500);
			if (trimSpace(l.memo) !== cur.memo) memos.set(l.line_number, trimSpace(l.memo));
		}
		if (l.debit_cents !== undefined || l.credit_cents !== undefined) {
			const debit = l.debit_cents ?? 0n;
			const credit = l.credit_cents ?? 0n;
			if (debit < 0n || credit < 0n) return v.add(f, "amounts can't be negative");
			if (debit > 0n === credit > 0n) return v.add(f, "give a debit or a credit, not both and not neither");
			if (debit > MAX_CENTS || credit > MAX_CENTS) return v.add(f, "the amount is too large");
			if (debit - credit !== cur.debit_cents - cur.credit_cents) amounts.set(l.line_number, debit - credit);
		}
	});
	v.throwIfAny();
	if (Object.keys(head).length === 0 && amounts.size === 0 && accounts.size === 0 && memos.size === 0) {
		v.add("", "nothing was changed");
		v.throwIfAny();
	}
	if (amounts.size > 0 || accounts.size > 0) {
		const what = amounts.size > 0 ? "amounts" : "accounts";
		if (orig.reverses_id !== null) throw new ConflictError(`entry ${id} is a reversal; its ${what} follow the entry it reverses`);
		if (orig.reversed_by_id !== null) throw new ConflictError(`entry ${id} was reversed by entry ${orig.reversed_by_id}; its ${what} can't change any more`);
	}
	// Each currency must still balance (a line stays in its currency).
	const sums = new Map<Currency, bigint>();
	for (const l of orig.lines) sums.set(l.currency, (sums.get(l.currency) ?? 0n) + (amounts.get(l.line_number) ?? l.debit_cents - l.credit_cents));
	for (const [cur, sum] of sums) {
		if (sum !== 0n) v.add("lines", `the ${cur} lines don't balance: debits and credits differ by ${formatCents(sum < 0n ? -sum : sum)}`);
	}
	v.throwIfAny();

	await withTx(app.db, {}, async (tx) => {
		if (!(await queryRow(tx, `SELECT 1 FROM journal_entries WHERE id = $1 FOR UPDATE`, [id]))) throw new NotFoundError();
		if (head.entity_id !== undefined && head.entity_id !== null) {
			const ent = await queryRow<{ is_active: boolean }>(tx, `SELECT is_active FROM entities WHERE id = $1`, [head.entity_id]);
			if (!ent) v.add("entity_id", "there is no such customer or vendor");
			else if (!ent.is_active) v.add("entity_id", "that customer or vendor is inactive");
		}
		const to = new Map<string, { id: bigint; currency: string; is_active: boolean; unreconciled: boolean }>();
		if (accounts.size > 0) {
			const rows = await queryRows<{ code: string; id: bigint; currency: string; is_active: boolean; unreconciled: boolean }>(
				tx,
				`SELECT a.code, a.id, a.currency, a.is_active, (${UNRECONCILED_WHERE}) AS unreconciled FROM accounts a WHERE a.code = ANY($1) ORDER BY a.id FOR SHARE`,
				[[...new Set(accounts.values())]],
			);
			for (const r of rows) to.set(r.code, r);
			(input.lines ?? []).forEach((l, i) => {
				const code = accounts.get(l.line_number);
				if (code === undefined) return;
				const f = `lines[${i}].account_code`;
				const a = to.get(code);
				const cur = byNumber.get(l.line_number)!;
				if (!a) v.add(f, `account ${JSON.stringify(code)} does not exist`);
				else if (a.unreconciled) v.add(f, "choose the account the line belongs in, not Unreconciled");
				else if (a.currency.trim() !== cur.currency.trim()) v.add(f, `must be a ${cur.currency.trim()} account, like the line`);
				else if (!a.is_active) v.add(f, "that account is inactive");
			});
		}
		v.throwIfAny();

		const lineIds = (m: Map<number, unknown>) => [...m.keys()].map((n) => byNumber.get(n)!.id);
		const ticked = await queryRow<{ line_number: number; statement_date: string; status: string; mine: boolean }>(
			tx,
			`SELECT t.line_number, r.statement_date, r.status, t.id = ANY($2::bigint[]) AS mine
			   FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id JOIN reconciliations r ON r.id = l.reconciliation_id
			  WHERE t.journal_entry_id = $1 AND ($3::boolean OR t.id = ANY($2::bigint[]))
			  ORDER BY mine DESC, t.line_number LIMIT 1`,
			[id, [...lineIds(amounts), ...lineIds(accounts)], head.entry_date !== undefined],
		);
		if (ticked) {
			const what = !ticked.mine ? "the entry's date" : amounts.has(ticked.line_number) ? "its amount" : "its account";
			throw new ConflictError(
				`line ${ticked.line_number} is ticked on the reconciliation to ${ticked.statement_date}; ${ticked.status === "finished" ? "undo that reconciliation" : "untick it there"} before changing ${what}`,
			);
		}

		// The database only lets these change inside a transaction that says who is changing them, and logs each.
		await tx.query(`SELECT set_config('ledger.amend_by', $1, true), set_config('ledger.amend_reason', $2, true)`, [String(actorId ?? "system"), reason]);
		if (Object.keys(head).length > 0) {
			await tx.query(
				`UPDATE journal_entries
				    SET entry_date = coalesce($2::date, entry_date), description = coalesce($3, description), reference = coalesce($4, reference),
				        entity_id = CASE WHEN $5 THEN $6::bigint ELSE entity_id END
				  WHERE id = $1`,
				[id, head.entry_date ?? null, head.description ?? null, head.reference ?? null, head.entity_id !== undefined, head.entity_id ?? null],
			);
		}
		// A line's account and its amount are logged apart, so they change one after the other.
		for (const [n, code] of accounts) await tx.query(`UPDATE transactions SET account_id = $2 WHERE id = $1`, [byNumber.get(n)!.id, to.get(code)!.id]);
		for (const [n, memo] of memos) await tx.query(`UPDATE transactions SET memo = $2 WHERE id = $1`, [byNumber.get(n)!.id, memo]);
		for (const [n, amount] of amounts) await tx.query(`UPDATE transactions SET amount = $2 WHERE id = $1`, [byNumber.get(n)!.id, amount]);
	});
	if (accounts.size > 0) await syncUnreconciledLater(app);
	return getJournalEntry(app, id);
}

export async function getJournalEntry(app: App, id: bigint): Promise<JournalEntry> {
	const row = await queryRow<EntryRow>(app.db, ENTRY_SELECT + ` WHERE e.id = $1`, [id]);
	if (!row) throw new NotFoundError();
	const e = toEntry(row);
	await attachLines(app, [e]);
	e.changes = e.amended ? await entryChanges(app.db, id) : [];
	e.moves = await entryMoves(app.db, id);
	e.date_changes = await entryDateChanges(app.db, id);
	e.edits = await entryFieldEdits(app.db, id);
	e.related = await relatedEntries(app, id);
	return e;
}

/** The given entries with their lines, totals, links and tags (no particular order). */
export async function journalEntriesByIds(app: App, ids: number[]): Promise<JournalEntry[]> {
	if (ids.length === 0) return [];
	const entries = (await queryRows<EntryRow>(app.db, ENTRY_SELECT + ` WHERE e.id = ANY($1::bigint[])`, [ids])).map(toEntry);
	await attachLines(app, entries);
	return entries;
}

export interface EntryFilter {
	from: string | null;
	to: string | null;
	accountCode: string | null;
	/** Only entries with this entity (vendor, customer): posted with it, or tagged with it. */
	entityId?: number | null;
	/** Only entries carrying this tag. */
	tag?: string | null;
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
		  AND ($7::bigint IS NULL OR e.entity_id = $7 OR EXISTS (SELECT 1 FROM journal_entry_tags jt WHERE jt.entry_id = e.id AND jt.entity_id = $7))
		  AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM journal_entry_tags jt WHERE jt.entry_id = e.id AND jt.tag = $8))
		ORDER BY e.entry_date DESC, e.id DESC
		LIMIT $4 OFFSET $5`,
		[f.from, f.to, f.accountCode, f.limit, f.offset, f.hideReversed === true, f.entityId ?? null, f.tag ?? null],
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
	for (const [entryId, tags] of await tagsOfEntries(app.db, entries.map((e) => e.id))) byId.get(entryId)!.tags = tags;
	const rows = await queryRows<{
		journal_entry_id: bigint;
		id: bigint;
		line_number: number;
		code: string;
		name: string;
		currency: Currency;
		amount: bigint;
		memo: string;
		unreconciled: boolean;
	}>(
		app.db,
		`SELECT t.journal_entry_id, t.id, t.line_number, a.code, a.name, t.currency, t.amount, t.memo,
		        (a.module_id = 'ledger' AND a.module_key = 'unreconciled') AS unreconciled
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
		if (r.unreconciled) line.unreconciled = true;
		byId.get(entryId)!.lines.push(line);
		let t = totals.get(entryId);
		if (!t) totals.set(entryId, (t = new Map()));
		t.set(r.currency, (t.get(r.currency) ?? 0n) + debit);
	}
	for (const [id, m] of totals) {
		byId.get(id)!.totals = sortedKeys(m).map((c): CurrencyTotal => ({ currency: c, amount_cents: m.get(c)! }));
	}
}
