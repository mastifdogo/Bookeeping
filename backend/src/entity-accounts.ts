// Customers' and vendors' own accounts (migration 034). Each customer has an
// account under accounts receivable and each vendor one under accounts
// payable, per currency, made the first time something is posted for them.
// What a customer owes, or a vendor is owed, is that account's balance, and
// the account a line sits in says whose it is.
//
// The rule kept here: a line in accounts receivable of an entry that is a
// customer's, or in accounts payable of a vendor's, sits in that customer's
// or vendor's own account. It holds when an entry is posted with a customer
// or vendor, when an entry's customer or vendor is changed, and when one is
// tagged "customer" or "vendor" (the line moves, and the tag is read from
// the account from then on).

import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { getAccount } from "./accounts.ts";
import { createJournalEntry } from "./ledger.ts";
import { MAX_CENTS } from "./money.ts";
import { checkText, trimSpace } from "./text.ts";
import { dateYear, parseDate } from "./date.ts";
import { moveLines } from "./unreconciled.ts";
import { ACCOUNT_CODE_RE, isCurrency, type Account, type Currency, type JournalEntry, type JournalEntryCreate } from "./types.ts";

export type EntityRole = "customer" | "vendor";
const ROLES: readonly string[] = ["customer", "vendor"];
/** The tag of the account each role's accounts sit under, and that account's type. */
const CONTROL = { customer: { kind: "receivable", type: "asset", code: "1200", name: "Accounts receivable" }, vendor: { kind: "payable", type: "liability", code: "2000", name: "Accounts payable" } } as const;
const ROLE_OF_KIND: Record<string, EntityRole> = { receivable: "customer", payable: "vendor" };
const MOVE_REASON = { customer: "A customer's entry: its line in accounts receivable sits in the customer's own account", vendor: "A vendor's entry: its line in accounts payable sits in the vendor's own account" } as const;

/** One of a customer's or vendor's own accounts, with what is owed in it. */
export interface EntityAccount {
	role: EntityRole;
	code: string;
	currency: Currency;
	/** What the customer owes (role customer) or what the vendor is owed (role vendor); negative when it is the other way round. */
	owed_cents: bigint;
}

/** The accounts of each of the given entities (all of them when ids is null). */
export async function entityAccounts(db: Queryable, ids: number[] | null): Promise<Map<number, EntityAccount[]>> {
	const rows = await queryRows<{ entity_id: bigint; role: EntityRole; code: string; currency: Currency; balance: bigint }>(
		db,
		`SELECT a.entity_id, a.entity_role AS role, a.code, a.currency,
		        COALESCE((SELECT sum(t.amount) FROM transactions t WHERE t.account_id = a.id), 0)::bigint AS balance
		   FROM accounts a
		  WHERE a.entity_id IS NOT NULL AND ($1::bigint[] IS NULL OR a.entity_id = ANY($1))
		  ORDER BY a.entity_role, a.currency`,
		[ids],
	);
	const out = new Map<number, EntityAccount[]>();
	for (const r of rows) {
		const k = Number(r.entity_id);
		out.set(k, [...(out.get(k) ?? []), { role: r.role, code: r.code, currency: r.currency.trim() as Currency, owed_cents: r.role === "customer" ? r.balance : -r.balance }]);
	}
	return out;
}

/**
 * Accounts receivable (customers) or payable (vendors) in a currency: the
 * account tagged so, made when the books have none in that currency.
 */
async function controlAccount(db: Queryable, role: EntityRole, currency: Currency): Promise<{ id: bigint; code: string }> {
	const c = CONTROL[role];
	const find = () => queryRow<{ id: bigint; code: string }>(db, `SELECT id, code FROM accounts WHERE kind = $1 AND currency = $2 ORDER BY is_active DESC, code LIMIT 1`, [c.kind, currency]);
	const found = await find();
	if (found) return found;
	const named = await queryRow(db, `SELECT 1 FROM accounts WHERE lower(name) = lower($1)`, [c.name]);
	for (let n = 0; n < 50; n++) {
		const code = n === 0 ? c.code : n === 1 ? `${c.code}-${currency}` : `${c.code}-${currency}-${n}`;
		await db.query(`INSERT INTO accounts (code, name, type, currency, description, kind) VALUES ($1, $2, $3, $4, '', $5) ON CONFLICT DO NOTHING`, [code, named ? `${c.name} (${currency})` : c.name, c.type, currency, c.kind]);
		const made = await find();
		if (made) return made;
	}
	throw new ConflictError(`could not find a free code for ${c.name.toLowerCase()} in ${currency}`);
}

/** How deep an account sits in the chart (1 for a top-level one). */
async function depthOf(db: Queryable, id: bigint): Promise<number> {
	const r = await queryRow<{ d: number }>(
		db,
		`WITH RECURSIVE up AS (SELECT id, parent_id, 1 AS d FROM accounts WHERE id = $1
		                       UNION ALL SELECT a.id, a.parent_id, up.d + 1 FROM accounts a JOIN up ON a.id = up.parent_id WHERE up.d < 20)
		 SELECT max(d)::int AS d FROM up`,
		[id],
	);
	return r?.d ?? 1;
}

/**
 * The customer's or vendor's own account in a currency, made when they have
 * none: a sub-account of accounts receivable or payable (of `under` when
 * given: the tagged account a line was posted to), named after them.
 */
export async function ensureEntityAccount(db: Queryable, entityId: number, role: EntityRole, currency: Currency, under?: bigint): Promise<{ id: bigint; code: string }> {
	const find = () => queryRow<{ id: bigint; code: string }>(db, `SELECT id, code FROM accounts WHERE entity_id = $1 AND entity_role = $2 AND currency = $3`, [entityId, role, currency]);
	const found = await find();
	if (found) {
		// Made active again: something is being posted for them.
		await db.query(`UPDATE accounts SET is_active = true WHERE id = $1 AND NOT is_active`, [found.id]);
		return found;
	}
	const v = new ValidationError();
	const who = Number.isSafeInteger(entityId) && entityId > 0 ? await queryRow<{ name: string; is_customer: boolean; is_vendor: boolean }>(db, `SELECT name, is_customer, is_vendor FROM entities WHERE id = $1`, [entityId]) : null;
	if (!who) v.add("entity_id", "there is no such customer or vendor");
	else if (role === "customer" && !who.is_customer) v.add("entity_id", `${who.name} is a vendor, not a customer`);
	else if (role === "vendor" && !who.is_vendor) v.add("entity_id", `${who.name} is a customer, not a vendor`);
	v.throwIfAny();
	const parent = under !== undefined ? (await queryRow<{ id: bigint; code: string }>(db, `SELECT id, code FROM accounts WHERE id = $1`, [under]))! : await controlAccount(db, role, currency);
	const parentId = (await depthOf(db, parent.id)) < 5 ? parent.id : null;
	const base = `${parent.code}-${entityId}`.length <= 32 ? `${parent.code}-${entityId}` : `E${entityId}-${role}`;
	for (let n = 1; n <= 50; n++) {
		const code = n === 1 ? base : `${base.slice(0, 32 - `-${n}`.length)}-${n}`;
		await db.query(
			`INSERT INTO accounts (code, name, type, currency, description, parent_id, entity_id, entity_role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
			[code, who!.name, CONTROL[role].type, currency, role === "customer" ? "What this customer owes: their invoices, less what they have paid." : "What this vendor is owed: their bills and receipts, less what was paid.", parentId, entityId, role],
		);
		const made = await find();
		if (made) return made;
	}
	throw new ConflictError(`could not find a free code for the account of ${who!.name}`);
}

/** The API's and modules' way in: the customer's or vendor's account in a currency, made when needed. */
export async function entityAccount(app: App, entityId: number, role: string, currency: string): Promise<Account> {
	const v = new ValidationError();
	if (!ROLES.includes(role)) v.add("role", "must be customer or vendor");
	if (!isCurrency(currency)) v.add("currency", "must be CAD or USD");
	v.throwIfAny();
	if (!(Number.isSafeInteger(entityId) && entityId > 0 && (await queryRow(app.db, `SELECT 1 FROM entities WHERE id = $1`, [entityId])))) throw new NotFoundError();
	const a = await withTx(app.db, {}, (tx) => ensureEntityAccount(tx, entityId, role as EntityRole, currency as Currency));
	return getAccount(app, a.code);
}

/**
 * An entry about to be posted with a customer or vendor: its lines in
 * accounts receivable (a customer's) or payable (a vendor's) are posted to
 * that customer's or vendor's own account instead. Returns the entry to post.
 */
export async function routeEntryLines(tx: Queryable, e: JournalEntryCreate): Promise<JournalEntryCreate> {
	if (e.entity_id === null || e.entity_id === undefined || !Number.isSafeInteger(e.entity_id) || e.entity_id < 1) return e;
	const controls = await queryRows<{ id: bigint; code: string; kind: string; currency: Currency }>(
		tx,
		`SELECT id, code, kind, currency FROM accounts WHERE code = ANY($1) AND kind IN ('receivable', 'payable') AND entity_id IS NULL AND is_active`,
		[e.lines.map((l) => l.account_code).filter((c) => ACCOUNT_CODE_RE.test(c))],
	);
	if (controls.length === 0) return e;
	const who = await queryRow<{ is_customer: boolean; is_vendor: boolean; is_active: boolean }>(tx, `SELECT is_customer, is_vendor, is_active FROM entities WHERE id = $1`, [e.entity_id]);
	if (!who || !who.is_active) return e; // refused by the posting itself
	// An entry between receivables (or payables) and their own account moves an amount from one to the other: it stays as written.
	const own = await queryRows<{ entity_role: string }>(tx, `SELECT entity_role FROM accounts WHERE code = ANY($1) AND entity_id = $2`, [e.lines.map((l) => l.account_code).filter((c) => ACCOUNT_CODE_RE.test(c)), e.entity_id]);
	const to = new Map<string, string>();
	for (const c of controls) {
		const role = ROLE_OF_KIND[c.kind]!;
		if (role === "customer" ? !who.is_customer : !who.is_vendor) continue;
		if (own.some((o) => o.entity_role === role)) continue;
		to.set(c.code, (await ensureEntityAccount(tx, e.entity_id, role, c.currency.trim() as Currency, c.id)).code);
	}
	return to.size === 0 ? e : { ...e, lines: e.lines.map((l) => (to.has(l.account_code) ? { ...l, account_code: to.get(l.account_code)! } : l)) };
}

interface TrackedLine {
	id: bigint;
	line_number: number;
	account_id: bigint;
	currency: Currency;
	/** The line's account: its tag, whose it is, and the account it sits under. */
	kind: string | null;
	entity_id: bigint | null;
	entity_role: EntityRole | null;
	parent_id: bigint | null;
	parent_kind: string | null;
}

/**
 * Moves lines of a posted entry: `pick` names the account each goes to
 * (null: it stays). Lines ticked on a reconciliation stay. The entry that
 * reverses this one, or that it reverses, mirrors it: its matching lines go
 * along. Returns how many lines of the entry itself moved.
 */
async function relocate(tx: Queryable, entryId: bigint, pick: (l: TrackedLine) => Promise<bigint | null>, actorId: number | null, reason: string): Promise<number> {
	const lines = await queryRows<TrackedLine>(
		tx,
		`SELECT t.id, t.line_number, t.account_id, t.currency, a.kind, a.entity_id, a.entity_role, a.parent_id, p.kind AS parent_kind
		   FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts p ON p.id = a.parent_id
		  WHERE t.journal_entry_id = $1 AND (a.entity_id IS NOT NULL OR a.kind IN ('receivable', 'payable'))
		    AND NOT EXISTS (SELECT 1 FROM reconciliation_lines r WHERE r.transaction_id = t.id)
		  ORDER BY t.line_number`,
		[entryId],
	);
	let moved = 0;
	for (const l of lines) {
		const target = await pick({ ...l, currency: l.currency.trim() as Currency });
		if (target === null || target === l.account_id) continue;
		const mirror = await queryRows<{ id: bigint }>(
			tx,
			`SELECT t.id FROM transactions t JOIN journal_entries o ON o.id = t.journal_entry_id
			  WHERE (o.reverses_id = $1 OR o.id = (SELECT reverses_id FROM journal_entries WHERE id = $1))
			    AND t.line_number = $2 AND t.account_id = $3
			    AND NOT EXISTS (SELECT 1 FROM reconciliation_lines r WHERE r.transaction_id = t.id)`,
			[entryId, l.line_number, l.account_id],
		);
		await moveLines(tx, [l.id, ...mirror.map((m) => m.id)], target, actorId, reason, null);
		moved++;
	}
	return moved;
}

/** Whether the entry has a line in some customer's (vendor's) own account. */
async function hasOwnLine(tx: Queryable, entryId: bigint, role: EntityRole): Promise<boolean> {
	return !!(await queryRow(tx, `SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.journal_entry_id = $1 AND a.entity_role = $2 LIMIT 1`, [entryId, role]));
}

const has = (who: { is_customer: boolean; is_vendor: boolean } | null | undefined, role: EntityRole) => !!who && (role === "customer" ? who.is_customer : who.is_vendor);

/**
 * The entry is this customer's (or vendor's): its lines in accounts
 * receivable (payable) move to their own account. Returns whether the entry
 * then has a line there, which is what says whose it is.
 */
export async function claimLines(tx: Queryable, entryId: bigint, role: EntityRole, entityId: number, actorId: number | null): Promise<{ moved: number; tracked: boolean }> {
	// An entry that already has a line in a customer's (vendor's) own account says whose it is: a line it also
	// has in accounts receivable (payable) is there on purpose (a stand-in for the bank side) and stays.
	const moved = (await hasOwnLine(tx, entryId, role))
		? 0
		: await relocate(tx, entryId, async (l) => (l.entity_id === null && l.kind === CONTROL[role].kind ? (await ensureEntityAccount(tx, entityId, role, l.currency, l.account_id)).id : null), actorId, MOVE_REASON[role]);
	const tracked = await queryRow(tx, `SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.journal_entry_id = $1 AND a.entity_id = $2 AND a.entity_role = $3 LIMIT 1`, [entryId, entityId, role]);
	return { moved, tracked: !!tracked };
}

/**
 * The entry isn't that customer's (or vendor's) after all: its lines in
 * their own account (anyone's, when entityId is null) move back to accounts
 * receivable (payable). Returns whose lines moved.
 */
export async function releaseLines(tx: Queryable, entryId: bigint, role: EntityRole, entityId: number | null, actorId: number | null): Promise<number[]> {
	const freed = new Set<number>();
	await relocate(
		tx,
		entryId,
		async (l) => {
			if (l.entity_role !== role || l.entity_id === null || (entityId !== null && Number(l.entity_id) !== entityId) || l.parent_kind !== CONTROL[role].kind) return null;
			freed.add(Number(l.entity_id));
			return l.parent_id;
		},
		actorId,
		`Not that ${role}'s entry any more: its line is back in accounts ${CONTROL[role].kind}`,
	);
	return [...freed];
}

/**
 * An entry's customer or vendor was changed (Edit on its page): the lines
 * that sat in the previous one's accounts go to the new one's (or back to
 * accounts receivable or payable), and lines in those go to the new one's.
 */
export async function retrackEntry(tx: Queryable, entryId: bigint, oldEntityId: number | null, newEntityId: number | null, actorId: number | null): Promise<void> {
	const who = newEntityId === null ? null : await queryRow<{ is_customer: boolean; is_vendor: boolean }>(tx, `SELECT is_customer, is_vendor FROM entities WHERE id = $1`, [newEntityId]);
	const own = { customer: await hasOwnLine(tx, entryId, "customer"), vendor: await hasOwnLine(tx, entryId, "vendor") };
	await relocate(
		tx,
		entryId,
		async (l) => {
			if (l.entity_id === null) {
				const role = ROLE_OF_KIND[l.kind ?? ""];
				return role && !own[role] && has(who, role) ? (await ensureEntityAccount(tx, newEntityId!, role, l.currency, l.account_id)).id : null;
			}
			if (oldEntityId === null || Number(l.entity_id) !== oldEntityId || l.entity_role === null) return null;
			if (has(who, l.entity_role)) return (await ensureEntityAccount(tx, newEntityId!, l.entity_role, l.currency, l.parent_kind === CONTROL[l.entity_role].kind ? l.parent_id! : undefined)).id;
			return l.parent_kind === CONTROL[l.entity_role].kind ? l.parent_id : null;
		},
		actorId,
		"The entry's customer or vendor was changed: its line follows to their own account",
	);
}

/** A customer or vendor was renamed: their accounts still named after them follow. */
export async function renameEntityAccounts(db: Queryable, entityId: number, oldName: string, newName: string): Promise<void> {
	if (oldName !== newName) await db.query(`UPDATE accounts SET name = $3 WHERE entity_id = $1 AND name = $2`, [entityId, oldName, newName]);
}

export interface EntityPayment {
	/** "vendor": a bill is paid; "customer": a payment is received. */
	role: string;
	/** The bank or credit card account the money left or arrived in. */
	account_code: string;
	entry_date: string;
	amount_cents: bigint;
	description?: string;
	reference?: string;
}

/**
 * Pay bill and Receive payment: one entry between a bank or card account and
 * the vendor's or customer's own account, in the bank account's currency.
 * Paying a vendor debits what they are owed and credits the bank; a
 * customer's payment debits the bank and credits what they owe.
 */
export async function postEntityPayment(app: App, entityId: number, input: EntityPayment, actorId: number | null): Promise<JournalEntry> {
	const v = new ValidationError();
	const role = input.role;
	if (!ROLES.includes(role)) v.add("role", "must be vendor (a bill is paid) or customer (a payment is received)");
	if (!ACCOUNT_CODE_RE.test(input.account_code ?? "")) v.add("account_code", "choose the bank or credit card account");
	let dateOk = false;
	try {
		dateOk = typeof input.entry_date === "string" && parseDate(input.entry_date) === input.entry_date && dateYear(input.entry_date) >= 1900 && dateYear(input.entry_date) <= 9999;
	} catch {
		// not a date
	}
	if (!dateOk) v.add("entry_date", "must be a date (YYYY-MM-DD)");
	if (typeof input.amount_cents !== "bigint" || input.amount_cents <= 0n) v.add("amount_cents", "must be more than zero");
	else if (input.amount_cents > MAX_CENTS) v.add("amount_cents", "the amount is too large");
	if (input.description !== undefined) checkText(v, "description", input.description, 0, 500);
	if (input.reference !== undefined) checkText(v, "reference", input.reference, 0, 100);
	v.throwIfAny();
	const who = Number.isSafeInteger(entityId) && entityId > 0 ? await queryRow<{ name: string; is_active: boolean }>(app.db, `SELECT name, is_active FROM entities WHERE id = $1`, [entityId]) : null;
	if (!who) throw new NotFoundError();
	const bank = await queryRow<{ currency: Currency; type: string; is_active: boolean; entity_id: bigint | null }>(app.db, `SELECT currency, type, is_active, entity_id FROM accounts WHERE code = $1`, [input.account_code]);
	if (!bank) v.add("account_code", `there is no account ${input.account_code}`);
	else if (!bank.is_active) v.add("account_code", "that account is inactive");
	else if (bank.entity_id !== null || (bank.type !== "asset" && bank.type !== "liability")) v.add("account_code", "choose a bank or credit card account");
	v.throwIfAny();
	const own = await entityAccount(app, entityId, role, bank!.currency.trim());
	const paying = role === "vendor";
	const line = (code: string, debit: boolean) => ({ account_code: code, debit_cents: debit ? input.amount_cents : 0n, credit_cents: debit ? 0n : input.amount_cents, memo: "" });
	return createJournalEntry(
		app,
		{
			entry_date: input.entry_date,
			description: trimSpace(input.description ?? "") || `${paying ? "Bill payment" : "Payment received"} - ${who.name}`.slice(0, 500),
			reference: trimSpace(input.reference ?? ""),
			entity_id: entityId,
			lines: paying ? [line(own.code, true), line(input.account_code, false)] : [line(input.account_code, true), line(own.code, false)],
		},
		actorId,
	);
}
