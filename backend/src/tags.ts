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
export const STANDARD_TAGS = ["paid", "billed", "overdue", "customer", "vendor", "rate"] as const;
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
	/** For the tag "rate": how many (e.g. 7.5); null for other tags. */
	quantity: number | null;
	/** For the tag "rate": of what (e.g. "hours"); null for other tags. */
	unit: string | null;
	/** For the tag "rate": the price of one unit in cents, in the entry's currency; null for other tags. */
	rate_cents: number | null;
}

/** What the tag "rate" says: enough for a form to fill in a line (quantity × rate). */
export interface EntryRate {
	quantity: number | null;
	unit: string | null;
	rate_cents: number | null;
	/** quantity × rate, rounded to the cent; null unless both are known. */
	amount_cents: number | null;
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
	/** The tag "rate" only: quantity and/or rate_cents (at least one), and optionally a unit. */
	quantity?: number | string | null;
	unit?: string | null;
	rate_cents?: number | null;
}

type Row = {
	entry_id: bigint;
	tag: string;
	entity_id: bigint | null;
	entity_name: string | null;
	note: string;
	module_id: string | null;
	username: string | null;
	created_at: Date;
	quantity: string | null;
	unit: string | null;
	rate_cents: bigint | string | null;
};
const SELECT = `
	SELECT t.entry_id, t.tag, t.entity_id, e.name AS entity_name, t.note, t.module_id, u.username, t.created_at, t.quantity, t.unit, t.rate_cents
	  FROM journal_entry_tags t
	  LEFT JOIN entities e ON e.id = t.entity_id
	  LEFT JOIN users u ON u.id = t.created_by`;
const toTag = (r: Row): EntryTag => ({
	tag: r.tag,
	entity: r.entity_id === null ? null : { id: Number(r.entity_id), name: r.entity_name ?? "" },
	note: r.note,
	module_id: r.module_id,
	set_by: r.username,
	set_at: r.created_at,
	quantity: r.quantity === null ? null : Number(r.quantity),
	unit: r.unit,
	rate_cents: r.rate_cents === null ? null : Number(r.rate_cents),
});

/** The rate of an entry's "rate" tag, or null when it has none. */
export function rateOfTags(tags: EntryTag[]): EntryRate | null {
	const t = tags.find((x) => x.tag === "rate");
	if (!t) return null;
	const amount = t.quantity !== null && t.rate_cents !== null ? Math.round(t.quantity * t.rate_cents) : null;
	return { quantity: t.quantity, unit: t.unit, rate_cents: t.rate_cents, amount_cents: amount };
}

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

interface Checked {
	tag: string;
	entityId: number | null;
	note: string;
	quantity: string | null;
	unit: string | null;
	rateCents: number | null;
}

function check(v: ValidationError, input: TagInput): Checked {
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	if (!TAG_RE.test(tag)) v.add("tag", "must be a lowercase word of up to 40 letters, digits, - or _ (paid, billed, overdue, customer, vendor, or your own)");
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	if (ENTITY_TAGS.has(tag) && (entityId === null || !Number.isSafeInteger(entityId) || entityId < 1)) v.add("entity_id", `is required for the tag "${tag}": which ${tag}`);
	if (!ENTITY_TAGS.has(tag) && entityId !== null) v.add("entity_id", `only goes with the tags "customer" and "vendor"`);
	const note = input?.note === undefined ? "" : input.note;
	if (typeof note !== "string" || note.length > 200) v.add("note", "must be text of at most 200 characters");
	let quantity: string | null = null;
	let unit: string | null = null;
	let rateCents: number | null = null;
	const given = (x: unknown) => x !== undefined && x !== null && x !== "";
	if (tag === "rate") {
		if (given(input.quantity)) {
			const q = typeof input.quantity === "number" ? input.quantity : Number(String(input.quantity).trim());
			if (!Number.isFinite(q) || Math.abs(q) >= 1e14 || Math.round(q * 10000) / 10000 !== q) v.add("quantity", "must be a number with at most 4 decimals");
			else quantity = String(q);
		}
		if (given(input.rate_cents)) {
			const r = Number(input.rate_cents);
			if (!Number.isSafeInteger(r) || r < 0) v.add("rate_cents", "must be a whole number of cents, 0 or more");
			else rateCents = r;
		}
		if (given(input.unit)) {
			const u = typeof input.unit === "string" ? input.unit.trim().toLowerCase() : "";
			if (!/^[a-z][a-z0-9 ./_-]{0,19}$/.test(u)) v.add("unit", "must be a word of up to 20 characters, e.g. hours, km, litres, items");
			else unit = u;
		}
		if (!given(input.quantity) && !given(input.rate_cents)) v.add("quantity", `the tag "rate" needs a quantity, a rate (rate_cents) or both`);
	} else {
		for (const k of ["quantity", "unit", "rate_cents"] as const) if (given(input?.[k])) v.add(k, `only goes with the tag "rate"`);
	}
	return { tag, entityId, note: typeof note === "string" ? note.trim() : "", quantity, unit, rateCents };
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

async function setTagTx(tx: Queryable, entryId: bigint, t: Checked, by: { moduleId: string | null; userId: number | null }, changes: TagChange[]): Promise<void> {
	const r = await tx.query(
		`INSERT INTO journal_entry_tags (entry_id, tag, entity_id, note, module_id, created_by, quantity, unit, rate_cents) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT ON CONSTRAINT journal_entry_tags_once DO UPDATE
		   SET note = EXCLUDED.note, quantity = EXCLUDED.quantity, unit = EXCLUDED.unit, rate_cents = EXCLUDED.rate_cents
		 WHERE (journal_entry_tags.note, journal_entry_tags.quantity, journal_entry_tags.unit, journal_entry_tags.rate_cents)
		       IS DISTINCT FROM (EXCLUDED.note, EXCLUDED.quantity, EXCLUDED.unit, EXCLUDED.rate_cents)
		 RETURNING (xmax = 0) AS added`,
		[entryId, t.tag, t.entityId, t.note, by.moduleId, by.userId, t.quantity, t.unit, t.rateCents],
	);
	// A changed rate is news too: forms that copied it may want the new one.
	if (r.rows[0] && (r.rows[0].added || t.tag === "rate")) changes.push({ entry_id: Number(entryId), action: "set", tag: t.tag, entity_id: t.entityId, module_id: by.moduleId });
	for (const other of CLEARS[t.tag] ?? []) {
		const d = await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2`, [entryId, other]);
		if ((d.rowCount ?? 0) > 0) changes.push({ entry_id: Number(entryId), action: "removed", tag: other, entity_id: null, module_id: by.moduleId });
	}
}

async function checkEntity(tx: Queryable, v: ValidationError, t: Checked): Promise<void> {
	if (t.entityId === null) return;
	const e = await queryRow<{ is_customer: boolean; is_vendor: boolean }>(tx, `SELECT is_customer, is_vendor FROM entities WHERE id = $1`, [t.entityId]);
	if (!e) v.add("entity_id", "there is no such customer or vendor");
	else if (t.tag === "customer" && !e.is_customer) v.add("entity_id", "that one is a vendor, not a customer");
	else if (t.tag === "vendor" && !e.is_vendor) v.add("entity_id", "that one is a customer, not a vendor");
	v.throwIfAny();
}

/**
 * Tags an entry. Setting a tag it already has changes nothing but the note
 * (and, for "rate", its quantity, unit and rate). "paid" takes "overdue"
 * off. Returns the entry's tags.
 */
export async function setTag(app: App, entryId: bigint, input: TagInput, by: { moduleId: string | null; userId: number | null }): Promise<EntryTag[]> {
	const v = new ValidationError();
	const t = check(v, input);
	v.throwIfAny();
	const changes: TagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		if (!(await queryRow(tx, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
		await checkEntity(tx, v, t);
		await setTagTx(tx, entryId, t, by, changes);
	});
	announce(app, changes);
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

export const MAX_BATCH = 500;

function batchIds(ids: unknown): bigint[] {
	const v = new ValidationError();
	if (!Array.isArray(ids) || ids.length === 0) v.add("entry_ids", "must be a list of journal entry numbers");
	else if (ids.length > MAX_BATCH) v.add("entry_ids", `at most ${MAX_BATCH} entries at a time`);
	v.throwIfAny();
	const out = new Set<bigint>();
	(ids as unknown[]).forEach((x, i) => {
		const n = typeof x === "bigint" ? x : typeof x === "number" && Number.isSafeInteger(x) ? BigInt(x) : typeof x === "string" && /^[1-9]\d{0,17}$/.test(x) ? BigInt(x) : 0n;
		if (n <= 0n) v.add(`entry_ids[${i}]`, "must be a journal entry number");
		else out.add(n);
	});
	v.throwIfAny();
	return [...out];
}

async function checkEntries(tx: Queryable, ids: bigint[]): Promise<void> {
	const found = await queryRows<{ id: bigint }>(tx, `SELECT id FROM journal_entries WHERE id = ANY($1::bigint[])`, [ids]);
	const have = new Set(found.map((r) => String(r.id)));
	const missing = ids.filter((i) => !have.has(String(i)));
	if (missing.length) {
		const v = new ValidationError();
		v.add("entry_ids", `no such journal entr${missing.length === 1 ? "y" : "ies"}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
		v.throwIfAny();
	}
}

/** Tags many entries at once, all or none. Returns how many entries changed. */
export async function setTags(app: App, entryIds: unknown, input: TagInput, by: { moduleId: string | null; userId: number | null }): Promise<{ entries: number; changed: number }> {
	const ids = batchIds(entryIds);
	const v = new ValidationError();
	const t = check(v, input);
	v.throwIfAny();
	const changes: TagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		await checkEntries(tx, ids);
		await checkEntity(tx, v, t);
		for (const id of ids) await setTagTx(tx, id, t, by, changes);
	});
	announce(app, changes);
	return { entries: ids.length, changed: new Set(changes.filter((c) => c.action === "set").map((c) => c.entry_id)).size };
}

/** Takes a tag off many entries at once. Returns how many entries had it. */
export async function removeTags(app: App, entryIds: unknown, input: { tag: string; entity_id?: number | null }, by: { moduleId: string | null }): Promise<{ entries: number; changed: number }> {
	const ids = batchIds(entryIds);
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	const v = new ValidationError();
	if (!TAG_RE.test(tag)) v.add("tag", "is not a tag");
	if (entityId !== null && (!Number.isSafeInteger(entityId) || entityId < 1)) v.add("entity_id", "must be a customer or vendor");
	v.throwIfAny();
	const gone = await withTx(app.db, {}, async (tx) => {
		await checkEntries(tx, ids);
		return queryRows<{ entry_id: bigint; entity_id: bigint | null }>(
			tx,
			`DELETE FROM journal_entry_tags WHERE entry_id = ANY($1::bigint[]) AND tag = $2 AND ($3::bigint IS NULL OR entity_id = $3) RETURNING entry_id, entity_id`,
			[ids, tag, entityId],
		);
	});
	announce(app, gone.map((g) => ({ entry_id: Number(g.entry_id), action: "removed" as const, tag, entity_id: g.entity_id === null ? null : Number(g.entity_id), module_id: by.moduleId })));
	return { entries: ids.length, changed: new Set(gone.map((g) => String(g.entry_id))).size };
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
