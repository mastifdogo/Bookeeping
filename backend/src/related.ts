// Links between journal entries (migration 031): the payment and the invoice
// it settled, a transfer's two halves, a refund and its sale. Opening an
// entry shows every entry linked to it:
//
//   linked       a link made between the two entries, by a person or a module
//   payment      a link that says the other entry is a payment of this one
//   pays         a link that says this entry is a payment of the other one
//   chain        linked to an entry that is linked to this one (and so on)
//   record       both are linked to the same record of a module (an invoice
//                and its payments: journal_entry_links, same module and ref)
//   reverses / reversed_by   the entry and its reversal
//
// Entries themselves don't change.
//
// Payments (migration 035): a link can say one entry pays the other, and how
// much of it. The entry paid shows what is paid and what is left, and Ledger
// keeps one of the tags unpaid, partially_paid or paid on it.

import type { App } from "./app.ts";
import { queryRow, queryRows } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { journalEntriesByIds } from "./ledger.ts";
import { MAX_CENTS } from "./money.ts";
import { setTag, type EntryTag } from "./tags.ts";
import type { Currency, CurrencyTotal } from "./types.ts";

/** Why an entry is shown with another. */
export interface RelatedWhy {
	kind: "linked" | "payment" | "pays" | "chain" | "record" | "reverses" | "reversed_by";
	/** linked, payment, pays: what the link is (may be empty). */
	note: string;
	/** payment, pays: how much of the payment goes to the entry paid, in cents. */
	amount_cents: bigint | null;
	/** linked: the module that made it (null: a person). record: the module whose record it is. */
	module_id: string | null;
	/** linked: who made it. */
	set_by: string | null;
	/** record: the record's name and where it opens ('' for none). */
	label: string;
	href: string;
	/** chain: the linked entry it was reached through. */
	through: number | null;
}

export interface RelatedEntry {
	id: number;
	entry_date: string;
	description: string;
	reference: string;
	totals: CurrencyTotal[];
	tags: EntryTag[];
	/** It was reversed, or is itself a reversal. */
	reversed: boolean;
	/** The two entries are linked themselves: that link can be taken off. */
	direct: boolean;
	why: RelatedWhy[];
}

/** The most entries shown with one entry. */
export const MAX_RELATED = 200;

const why = (kind: RelatedWhy["kind"], o: Partial<RelatedWhy> = {}): RelatedWhy => ({ kind, note: "", amount_cents: null, module_id: null, set_by: null, label: "", href: "", through: null, ...o });

/** Every entry linked to the given one, oldest first. */
export async function relatedEntries(app: App, entryId: bigint): Promise<RelatedEntry[]> {
	const self = Number(entryId);
	const reasons = new Map<number, RelatedWhy[]>();
	const add = (id: number, w: RelatedWhy) => {
		if (id === self) return;
		if (!reasons.has(id) && reasons.size >= MAX_RELATED) return;
		reasons.set(id, [...(reasons.get(id) ?? []), w]);
	};

	// Links between entries: the ones on this entry, then the ones on those, and so on.
	const seen = new Set<number>([self]);
	let frontier = [self];
	while (frontier.length > 0 && seen.size <= MAX_RELATED) {
		const rows = await queryRows<{ entry_id: bigint; related_id: bigint; note: string; module_id: string | null; username: string | null; payment_of: bigint | null }>(
			app.db,
			`SELECT r.entry_id, r.related_id, r.note, r.module_id, u.username, r.payment_of
			   FROM journal_entry_relations r LEFT JOIN users u ON u.id = r.created_by
			  WHERE r.entry_id = ANY($1::bigint[]) OR r.related_id = ANY($1::bigint[])
			  ORDER BY r.id`,
			[frontier],
		);
		const at = new Set(frontier);
		const next: number[] = [];
		for (const r of rows) {
			const pair = [Number(r.entry_id), Number(r.related_id)];
			for (const [from, to] of [pair, [pair[1]!, pair[0]!]] as [number, number][]) {
				if (!at.has(from) || seen.has(to)) continue;
				seen.add(to);
				next.push(to);
				const kind = r.payment_of === null ? "linked" : Number(r.payment_of) === self ? "payment" : "pays";
				add(to, from === self ? why(kind, { note: r.note, module_id: r.module_id, set_by: r.username }) : why("chain", { through: from }));
			}
		}
		frontier = next;
	}
	const direct = new Set([...reasons].filter(([, w]) => ["linked", "payment", "pays"].includes(w[0]!.kind)).map(([id]) => id));
	// How much each payment link is for.
	for (const id of direct) {
		const w = reasons.get(id)![0]!;
		if (w.kind === "linked") continue;
		const [bill, payment] = w.kind === "payment" ? [entryId, BigInt(id)] : [BigInt(id), entryId];
		w.amount_cents = (await paymentsOf(app, bill))?.payments.find((x) => x.entry_id === Number(payment))?.amount_cents ?? null;
	}

	// Entries linked to the same record of a module.
	for (const r of await queryRows<{ entry_id: bigint; module_id: string; label: string; href: string }>(
		app.db,
		`SELECT o.entry_id, o.module_id, o.label, o.href
		   FROM journal_entry_links m
		   JOIN journal_entry_links o ON o.module_id = m.module_id AND o.ref = m.ref AND o.entry_id <> m.entry_id
		  WHERE m.entry_id = $1
		  ORDER BY o.entry_id, o.id LIMIT 500`,
		[entryId],
	)) {
		add(Number(r.entry_id), why("record", { module_id: r.module_id, label: r.label, href: r.href }));
	}

	// The entry it reverses, and the one that reverses it.
	for (const r of await queryRows<{ id: bigint; kind: "reverses" | "reversed_by" }>(
		app.db,
		`SELECT reverses_id AS id, 'reverses' AS kind FROM journal_entries WHERE id = $1 AND reverses_id IS NOT NULL
		 UNION ALL SELECT id, 'reversed_by' FROM journal_entries WHERE reverses_id = $1`,
		[entryId],
	)) {
		add(Number(r.id), why(r.kind));
	}

	const entries = await journalEntriesByIds(app, [...reasons.keys()]);
	return entries
		.sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id))
		.map((e) => ({
			id: e.id,
			entry_date: e.entry_date,
			description: e.description,
			reference: e.reference,
			totals: e.totals,
			tags: e.tags,
			reversed: e.reverses_id !== null || e.reversed_by_id !== null,
			direct: direct.has(e.id),
			why: reasons.get(e.id)!,
		}));
}

export type PaidStatus = "unpaid" | "partially_paid" | "paid";

/** What an entry is owed and what its linked payments come to. */
export interface EntryPayments {
	currency: Currency;
	/** What the entry is for: its line in the customer's or vendor's own account (else in accounts receivable or payable, else the entry's total). */
	due_cents: bigint;
	paid_cents: bigint;
	/** Never below zero. */
	left_cents: bigint;
	status: PaidStatus;
	/** The payments linked to it, oldest first. Reversed ones are listed with counted false. */
	payments: { entry_id: number; entry_date: string; description: string; amount_cents: bigint; counted: boolean; note: string }[];
}

/** The payments linked to an entry and what they leave owing; null when none is linked. */
export async function paymentsOf(app: App, entryId: bigint): Promise<EntryPayments | null> {
	const links = await queryRows<{ payment_id: bigint; amount: bigint | null; note: string; entry_date: string; description: string; reversed: boolean }>(
		app.db,
		`SELECT p.id AS payment_id, r.amount, r.note, p.entry_date, p.description,
		        (p.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM journal_entries x WHERE x.reverses_id = p.id)) AS reversed
		   FROM journal_entry_relations r
		   JOIN journal_entries p ON p.id = CASE WHEN r.entry_id = r.payment_of THEN r.related_id ELSE r.entry_id END
		  WHERE r.payment_of = $1 ORDER BY p.entry_date, p.id`,
		[entryId],
	);
	if (links.length === 0) return null;
	// What the entry is for, in the currency of its receivable or payable line.
	const lines = await queryRows<{ currency: Currency; amount: bigint; own: boolean; control: boolean }>(
		app.db,
		`SELECT t.currency, t.amount, a.entity_id IS NOT NULL AS own, a.kind IN ('receivable', 'payable') AS control
		   FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.journal_entry_id = $1 ORDER BY t.line_number`,
		[entryId],
	);
	const pick = lines.some((l) => l.own) ? lines.filter((l) => l.own) : lines.some((l) => l.control) ? lines.filter((l) => l.control) : [];
	const currency = (pick[0] ?? lines[0])?.currency.trim() as Currency;
	const abs = (n: bigint) => (n < 0n ? -n : n);
	const net = abs(pick.filter((l) => l.currency.trim() === currency).reduce((s, l) => s + l.amount, 0n));
	const total = (ls: { currency: string; amount: bigint }[]) => ls.filter((l) => l.currency.trim() === currency && l.amount > 0n).reduce((s, l) => s + l.amount, 0n);
	const due = net > 0n ? net : total(lines);
	const totals = new Map<string, bigint>();
	for (const r of await queryRows<{ id: bigint; total: bigint }>(
		app.db,
		`SELECT journal_entry_id AS id, COALESCE(sum(amount) FILTER (WHERE amount > 0), 0)::bigint AS total FROM transactions
		  WHERE journal_entry_id = ANY($1::bigint[]) AND currency = $2 GROUP BY journal_entry_id`,
		[links.map((l) => l.payment_id), currency],
	)) totals.set(String(r.id), r.total);
	const payments = links.map((l) => ({ entry_id: Number(l.payment_id), entry_date: l.entry_date, description: l.description, amount_cents: l.amount ?? totals.get(String(l.payment_id)) ?? 0n, counted: !l.reversed, note: l.note }));
	const paid = payments.filter((p) => p.counted).reduce((s, p) => s + p.amount_cents, 0n);
	return { currency, due_cents: due, paid_cents: paid, left_cents: paid >= due ? 0n : due - paid, status: paid <= 0n ? "unpaid" : paid >= due ? "paid" : "partially_paid", payments };
}

/**
 * Brings an entry's tag in line with its linked payments: unpaid,
 * partially_paid or paid (each takes the other two off). `left`: the entry
 * had payments and its last one was just taken off, so it is unpaid again.
 */
async function syncPaidTag(app: App, entryId: bigint, by: { moduleId: string | null; userId: number | null }, left = false): Promise<void> {
	const p = await paymentsOf(app, entryId);
	if (!p && !left) return;
	await setTag(app, entryId, { tag: p?.status ?? "unpaid" }, by);
}

/** A payment entry changed (it was reversed): the entries it pays are looked at again. */
export async function syncEntriesPaidBy(app: App, paymentId: bigint, userId: number | null): Promise<void> {
	const rows = await queryRows<{ payment_of: bigint }>(app.db, `SELECT payment_of FROM journal_entry_relations WHERE payment_of IS NOT NULL AND payment_of <> $1 AND (entry_id = $1 OR related_id = $1)`, [paymentId]);
	for (const r of rows) await syncPaidTag(app, r.payment_of, { moduleId: null, userId });
}

/**
 * Links two entries (or changes that link). With `payment`, the link says
 * `otherId` is a payment of `entryId` (amount_cents: how much of it, when it
 * pays several entries; left out, all of it), and the entry paid is tagged
 * unpaid, partially_paid or paid by what its payments come to.
 */
export async function relateEntries(
	app: App,
	entryId: bigint,
	otherId: bigint,
	note: unknown,
	by: { moduleId: string | null; userId: number | null },
	payment?: { amount_cents?: bigint | null } | null,
): Promise<void> {
	const v = new ValidationError();
	const amount = payment?.amount_cents ?? null;
	if (amount !== null && (typeof amount !== "bigint" || amount <= 0n || amount > MAX_CENTS)) v.add("amount_cents", "must be more than zero");
	if (note !== undefined && note !== null && (typeof note !== "string" || note.trim().length > 200)) v.add("note", "must be at most 200 characters");
	if (entryId === otherId) v.add("entry_id", "an entry can't be linked to itself");
	v.throwIfAny();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [otherId]))) {
		v.add("entry_id", `there is no entry ${otherId}`);
		v.throwIfAny();
	}
	const [a, b] = entryId < otherId ? [entryId, otherId] : [otherId, entryId];
	// The same pair again changes the link; without `payment` it stays the kind of link it was.
	const was = await queryRow<{ payment_of: bigint | null }>(app.db, `SELECT payment_of FROM journal_entry_relations WHERE entry_id = $1 AND related_id = $2`, [a, b]);
	await app.db.query(
		`INSERT INTO journal_entry_relations (entry_id, related_id, note, module_id, created_by, payment_of, amount) VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (entry_id, related_id) DO UPDATE SET note = EXCLUDED.note,
		   payment_of = CASE WHEN $8 THEN EXCLUDED.payment_of ELSE journal_entry_relations.payment_of END,
		   amount = CASE WHEN $8 THEN EXCLUDED.amount ELSE journal_entry_relations.amount END`,
		[a, b, typeof note === "string" ? note.trim() : "", by.moduleId, by.userId, payment ? entryId : null, payment ? amount : null, payment !== undefined],
	);
	if (payment) await syncPaidTag(app, entryId, by);
	// It was a payment the other way round, or isn't one any more.
	if (was?.payment_of != null && (!payment || was.payment_of !== entryId) && payment !== undefined) await syncPaidTag(app, was.payment_of, by, true);
}

/** Takes off the link between two entries; false if there was none. */
export async function unrelateEntries(app: App, entryId: bigint, otherId: bigint, by: { moduleId: string | null; userId: number | null } = { moduleId: null, userId: null }): Promise<boolean> {
	const [a, b] = entryId < otherId ? [entryId, otherId] : [otherId, entryId];
	const r = await queryRows<{ payment_of: bigint | null }>(app.db, `DELETE FROM journal_entry_relations WHERE entry_id = $1 AND related_id = $2 RETURNING payment_of`, [a, b]);
	// A payment taken off: the entry it paid is partially paid or unpaid again.
	if (r[0]?.payment_of != null) await syncPaidTag(app, r[0].payment_of, by, true);
	return r.length > 0;
}
