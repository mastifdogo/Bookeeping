// Links between journal entries (migration 031): the payment and the invoice
// it settled, a transfer's two halves, a refund and its sale. Opening an
// entry shows every entry linked to it:
//
//   linked       a link made between the two entries, by a person or a module
//   chain        linked to an entry that is linked to this one (and so on)
//   record       both are linked to the same record of a module (an invoice
//                and its payments: journal_entry_links, same module and ref)
//   reverses / reversed_by   the entry and its reversal
//
// Entries themselves don't change.

import type { App } from "./app.ts";
import { queryRow, queryRows } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { journalEntriesByIds } from "./ledger.ts";
import type { EntryTag } from "./tags.ts";
import type { CurrencyTotal } from "./types.ts";

/** Why an entry is shown with another. */
export interface RelatedWhy {
	kind: "linked" | "chain" | "record" | "reverses" | "reversed_by";
	/** linked: what the link is (may be empty). */
	note: string;
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

const why = (kind: RelatedWhy["kind"], o: Partial<RelatedWhy> = {}): RelatedWhy => ({ kind, note: "", module_id: null, set_by: null, label: "", href: "", through: null, ...o });

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
		const rows = await queryRows<{ entry_id: bigint; related_id: bigint; note: string; module_id: string | null; username: string | null }>(
			app.db,
			`SELECT r.entry_id, r.related_id, r.note, r.module_id, u.username
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
				add(to, from === self ? why("linked", { note: r.note, module_id: r.module_id, set_by: r.username }) : why("chain", { through: from }));
			}
		}
		frontier = next;
	}
	const direct = new Set([...reasons].filter(([, w]) => w[0]!.kind === "linked").map(([id]) => id));

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

/** Links two entries (or changes that link's note). */
export async function relateEntries(app: App, entryId: bigint, otherId: bigint, note: unknown, by: { moduleId: string | null; userId: number | null }): Promise<void> {
	const v = new ValidationError();
	if (note !== undefined && note !== null && (typeof note !== "string" || note.trim().length > 200)) v.add("note", "must be at most 200 characters");
	if (entryId === otherId) v.add("entry_id", "an entry can't be linked to itself");
	v.throwIfAny();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [otherId]))) {
		v.add("entry_id", `there is no entry ${otherId}`);
		v.throwIfAny();
	}
	const [a, b] = entryId < otherId ? [entryId, otherId] : [otherId, entryId];
	await app.db.query(
		`INSERT INTO journal_entry_relations (entry_id, related_id, note, module_id, created_by) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (entry_id, related_id) DO UPDATE SET note = EXCLUDED.note`,
		[a, b, typeof note === "string" ? note.trim() : "", by.moduleId, by.userId],
	);
}

/** Takes off the link between two entries; false if there was none. */
export async function unrelateEntries(app: App, entryId: bigint, otherId: bigint): Promise<boolean> {
	const [a, b] = entryId < otherId ? [entryId, otherId] : [otherId, entryId];
	const r = await app.db.query(`DELETE FROM journal_entry_relations WHERE entry_id = $1 AND related_id = $2`, [a, b]);
	return (r.rowCount ?? 0) > 0;
}
