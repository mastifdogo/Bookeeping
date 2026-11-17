// Tags on journal entries, shared by Ledger and every module (migration
// 027). A module tags the entry of an invoice "billed" and its customer, a
// person or another module tags it "paid" when the money arrives, and every
// module that listens (ctx.tags.onChange) or asks (ctx.tags.of / entries)
// sees the same thing. Entries themselves don't change.

import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";

/** The tags every module understands the same way. Others are allowed: lowercase words. */
export const STANDARD_TAGS = ["paid", "billed", "overdue", "customer", "vendor"] as const;
const ENTITY_TAGS = new Set(["customer", "vendor"]);
const TAG_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** Setting the first takes the others off: an entry that is paid is no longer overdue. */
const CLEARS: Record<string, string[]> = { paid: ["overdue"] };

export interface EntryTag {
	tag: string;
	/** Who, for the tags "customer" and "vendor"; null for the others. */
	entity: { id: number; name: string } | null;
	note: string;
	/** The module that set it; null when a person did. */
	module_id: string | null;
	set_by: string | null;
	set_at: Date;
}

export interface TagChange {
	entry_id: number;
	action: "set" | "removed";
	tag: string;
	entity_id: number | null;
	/** The module that made the change; null when a person did. */
	module_id: string | null;
}

export interface TagInput {
	tag: string;
	entity_id?: number | null;
	note?: string;
}

type Row = { entry_id: bigint; tag: string; entity_id: bigint | null; entity_name: string | null; note: string; module_id: string | null; username: string | null; created_at: Date };
const SELECT = `
	SELECT t.entry_id, t.tag, t.entity_id, e.name AS entity_name, t.note, t.module_id, u.username, t.created_at
	  FROM journal_entry_tags t
	  LEFT JOIN entities e ON e.id = t.entity_id
	  LEFT JOIN users u ON u.id = t.created_by`;
const toTag = (r: Row): EntryTag => ({ tag: r.tag, entity: r.entity_id === null ? null : { id: Number(r.entity_id), name: r.entity_name ?? "" }, note: r.note, module_id: r.module_id, set_by: r.username, set_at: r.created_at });

/** The tags of each of the given entries. */
export async function tagsOfEntries(db: Queryable, ids: (number | bigint)[]): Promise<Map<number, EntryTag[]>> {
	const out = new Map<number, EntryTag[]>();
	if (ids.length === 0) return out;
	for (const r of await queryRows<Row>(db, SELECT + ` WHERE t.entry_id = ANY($1::bigint[]) ORDER BY t.id`, [ids])) {
		const k = Number(r.entry_id);
		out.set(k, [...(out.get(k) ?? []), toTag(r)]);
	}
	return out;
}

export async function tagsOf(app: App, entryId: bigint): Promise<EntryTag[]> {
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

function check(v: ValidationError, input: TagInput): { tag: string; entityId: number | null; note: string } {
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	if (!TAG_RE.test(tag)) v.add("tag", "must be a lowercase word of up to 40 letters, digits, - or _ (paid, billed, overdue, customer, vendor, or your own)");
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	if (ENTITY_TAGS.has(tag) && (entityId === null || !Number.isSafeInteger(entityId) || entityId < 1)) v.add("entity_id", `is required for the tag "${tag}": which ${tag}`);
	if (!ENTITY_TAGS.has(tag) && entityId !== null) v.add("entity_id", `only goes with the tags "customer" and "vendor"`);
	const note = input?.note === undefined ? "" : input.note;
	if (typeof note !== "string" || note.length > 200) v.add("note", "must be text of at most 200 characters");
	return { tag, entityId, note: typeof note === "string" ? note.trim() : "" };
}

/** Tells every module that listens, after the change is saved. */
function announce(app: App, changes: TagChange[]): void {
	for (const m of app.modules.modules.values()) {
		if (m.error) continue;
		for (const fn of m.tagListeners) {
			for (const c of changes) {
				Promise.resolve()
					.then(() => fn(c))
					.catch((err: Error) => log.error("module tag listener failed", { module: m.manifest.id, err: err.message }));
			}
		}
	}
}

/**
 * Tags an entry. Setting a tag it already has changes nothing but the note.
 * "paid" takes "overdue" off. Returns the entry's tags.
 */
export async function setTag(app: App, entryId: bigint, input: TagInput, by: { moduleId: string | null; userId: number | null }): Promise<EntryTag[]> {
	const v = new ValidationError();
	const t = check(v, input);
	v.throwIfAny();
	const changes: TagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		if (!(await queryRow(tx, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
		if (t.entityId !== null) {
			const e = await queryRow<{ is_customer: boolean; is_vendor: boolean }>(tx, `SELECT is_customer, is_vendor FROM entities WHERE id = $1`, [t.entityId]);
			if (!e) v.add("entity_id", "there is no such customer or vendor");
			else if (t.tag === "customer" && !e.is_customer) v.add("entity_id", "that one is a vendor, not a customer");
			else if (t.tag === "vendor" && !e.is_vendor) v.add("entity_id", "that one is a customer, not a vendor");
			v.throwIfAny();
		}
		const r = await tx.query(
			`INSERT INTO journal_entry_tags (entry_id, tag, entity_id, note, module_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT ON CONSTRAINT journal_entry_tags_once DO UPDATE SET note = EXCLUDED.note WHERE journal_entry_tags.note IS DISTINCT FROM EXCLUDED.note
			 RETURNING (xmax = 0) AS added`,
			[entryId, t.tag, t.entityId, t.note, by.moduleId, by.userId],
		);
		if (r.rows[0]?.added) changes.push({ entry_id: Number(entryId), action: "set", tag: t.tag, entity_id: t.entityId, module_id: by.moduleId });
		for (const other of CLEARS[t.tag] ?? []) {
			const d = await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2`, [entryId, other]);
			if ((d.rowCount ?? 0) > 0) changes.push({ entry_id: Number(entryId), action: "removed", tag: other, entity_id: null, module_id: by.moduleId });
		}
	});
	announce(app, changes);
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

/** Takes a tag off an entry (for "customer" and "vendor": that one, or all of them when no entity is given). */
export async function removeTag(app: App, entryId: bigint, input: { tag: string; entity_id?: number | null }, by: { moduleId: string | null }): Promise<EntryTag[]> {
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	if (!TAG_RE.test(tag) || (entityId !== null && (!Number.isSafeInteger(entityId) || entityId < 1))) throw new NotFoundError();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	const gone = await queryRows<{ entity_id: bigint | null }>(app.db, `DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2 AND ($3::bigint IS NULL OR entity_id = $3) RETURNING entity_id`, [entryId, tag, entityId]);
	announce(app, gone.map((g) => ({ entry_id: Number(entryId), action: "removed" as const, tag, entity_id: g.entity_id === null ? null : Number(g.entity_id), module_id: by.moduleId })));
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

/** Every tag in use, with how many entries carry it (the standard ones always listed). */
export async function listTags(app: App): Promise<{ tag: string; entries: number; standard: boolean }[]> {
	const rows = await queryRows<{ tag: string; n: bigint }>(app.db, `SELECT tag, count(DISTINCT entry_id) AS n FROM journal_entry_tags GROUP BY tag`);
	const counts = new Map(rows.map((r) => [r.tag, Number(r.n)]));
	const std = STANDARD_TAGS as readonly string[];
	return [...std, ...rows.map((r) => r.tag).filter((t) => !std.includes(t)).sort()].map((tag) => ({ tag, entries: counts.get(tag) ?? 0, standard: std.includes(tag) }));
}
