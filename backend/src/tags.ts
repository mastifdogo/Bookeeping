// Tags on journal entries, shared by Ledger and every module (migration
// 027). A module tags the entry of an invoice "billed" and its customer, a
// person or another module tags it "paid" when the money arrives, and every
// module that listens (ctx.tags.onChange) or asks (ctx.tags.of / entries)
// sees the same thing. Entries themselves don't change.

import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { claimLines, releaseLines, type EntityRole } from "./entity-accounts.ts";

/** The tags every module understands the same way. Others are allowed: lowercase words. */
export const STANDARD_TAGS = ["paid", "partially_paid", "unpaid", "billed", "overdue", "customer", "vendor", "rate"] as const;
const ENTITY_TAGS = new Set(["customer", "vendor"]);
const TAG_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** Setting the first takes the others off: an entry that is paid is no longer overdue. */
const CLEARS: Record<string, string[]> = { paid: ["overdue", "partially_paid", "unpaid"], partially_paid: ["paid", "unpaid"], unpaid: ["paid", "partially_paid"] };

export interface EntryTag {
	/** This tag's own number: tells an entry's rate items apart. */
	id: number;
	tag: string;
	/** Who, for the tags "customer" and "vendor"; null for the others. */
	entity: { id: number; name: string } | null;
	note: string;
	/** The module that set it; null when a person did. */
	module_id: string | null;
	set_by: string | null;
	set_at: Date;
	/** For the tag "rate": what the item is (e.g. "Labour"); null when not given and for other tags. */
	description: string | null;
	/** For the tag "rate": how many (e.g. 7.5); null for other tags. */
	quantity: number | null;
	/** For the tag "rate": of what (e.g. "hours"); null for other tags. */
	unit: string | null;
	/** For the tag "rate": the price of one unit in cents, in the entry's currency; null for other tags. */
	rate_cents: number | null;
	/**
	 * For "customer" and "vendor": the customer's or vendor's own account the
	 * entry has a line in, when that is what says whose the entry is (the tag
	 * is read from the account, it isn't kept apart; its id is 0); null otherwise.
	 */
	account_code: string | null;
}

/** What a tag "rate" says: one item, enough for a form to fill in a line (description, quantity × rate). */
export interface EntryRate {
	/** The tag's id: give it to change or take off this item. */
	id: number;
	description: string | null;
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
	/** For the tag "rate": which item (its id); null for other tags. */
	tag_id: number | null;
	entity_id: number | null;
	/** The module that made the change; null when a person did. */
	module_id: string | null;
}

export interface TagInput {
	tag: string;
	entity_id?: number | null;
	note?: string;
	/** The tag "rate" only: which item to change; left out, a new item is added. */
	id?: number | null;
	/** The tag "rate" only: what the item is, up to 100 characters. */
	description?: string | null;
	/** The tag "rate" only: quantity and/or rate_cents (at least one), and optionally a unit. */
	quantity?: number | string | null;
	unit?: string | null;
	rate_cents?: number | null;
}

type Row = {
	id: bigint;
	entry_id: bigint;
	tag: string;
	entity_id: bigint | null;
	entity_name: string | null;
	note: string;
	module_id: string | null;
	username: string | null;
	created_at: Date;
	description: string | null;
	quantity: string | null;
	unit: string | null;
	rate_cents: bigint | string | null;
};
const SELECT = `
	SELECT t.id, t.entry_id, t.tag, t.entity_id, e.name AS entity_name, t.note, t.module_id, u.username, t.created_at, t.description, t.quantity, t.unit, t.rate_cents
	  FROM journal_entry_tags t
	  LEFT JOIN entities e ON e.id = t.entity_id
	  LEFT JOIN users u ON u.id = t.created_by`;
const toTag = (r: Row): EntryTag => ({
	id: Number(r.id),
	tag: r.tag,
	entity: r.entity_id === null ? null : { id: Number(r.entity_id), name: r.entity_name ?? "" },
	note: r.note,
	module_id: r.module_id,
	set_by: r.username,
	set_at: r.created_at,
	description: r.description,
	quantity: r.quantity === null ? null : Number(r.quantity),
	unit: r.unit,
	rate_cents: r.rate_cents === null ? null : Number(r.rate_cents),
	account_code: null,
});

const rateOfTag = (t: EntryTag): EntryRate => ({
	id: t.id,
	description: t.description,
	quantity: t.quantity,
	unit: t.unit,
	rate_cents: t.rate_cents,
	amount_cents: t.quantity !== null && t.rate_cents !== null ? Math.round(t.quantity * t.rate_cents) : null,
});

/** Every "rate" item of an entry, in the order they were added. */
export function ratesOfTags(tags: EntryTag[]): EntryRate[] {
	return tags.filter((x) => x.tag === "rate").map(rateOfTag);
}

/** The entry's first "rate" item, or null when it has none. */
export function rateOfTags(tags: EntryTag[]): EntryRate | null {
	return ratesOfTags(tags)[0] ?? null;
}

/** The tags of each of the given entries. */
export async function tagsOfEntries(db: Queryable, ids: (number | bigint)[]): Promise<Map<number, EntryTag[]>> {
	const out = new Map<number, EntryTag[]>();
	if (ids.length === 0) return out;
	for (const r of await queryRows<Row>(db, SELECT + ` WHERE t.entry_id = ANY($1::bigint[]) ORDER BY t.id`, [ids])) {
		const k = Number(r.entry_id);
		out.set(k, [...(out.get(k) ?? []), toTag(r)]);
	}
	// "customer" and "vendor" read from the accounts: a line in a customer's or vendor's own account says whose the entry is.
	const own = await queryRows<{ entry_id: bigint; tag: string; entity_id: bigint; name: string; code: string; posted_at: Date }>(
		db,
		`SELECT DISTINCT ON (t.journal_entry_id, a.entity_role, a.entity_id) t.journal_entry_id AS entry_id, a.entity_role AS tag, a.entity_id, n.name, a.code, e.posted_at
		   FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN entities n ON n.id = a.entity_id JOIN journal_entries e ON e.id = t.journal_entry_id
		  WHERE t.journal_entry_id = ANY($1::bigint[]) AND a.entity_id IS NOT NULL
		  ORDER BY t.journal_entry_id, a.entity_role, a.entity_id, t.line_number`,
		[ids],
	);
	for (const r of own) {
		const k = Number(r.entry_id);
		const list = out.get(k) ?? [];
		const kept = list.find((t) => t.tag === r.tag && t.entity?.id === Number(r.entity_id));
		if (kept) kept.account_code = r.code;
		else list.push({ id: 0, tag: r.tag, entity: { id: Number(r.entity_id), name: r.name }, note: "", module_id: null, set_by: null, set_at: r.posted_at, description: null, quantity: null, unit: null, rate_cents: null, account_code: r.code });
		out.set(k, list);
	}
	return out;
}

export async function tagsOf(app: App, entryId: bigint): Promise<EntryTag[]> {
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

interface Checked {
	tag: string;
	/** The rate item to change; null adds one. */
	id: bigint | null;
	description: string | null;
	entityId: number | null;
	note: string;
	quantity: string | null;
	unit: string | null;
	rateCents: number | null;
}

function check(v: ValidationError, input: TagInput): Checked {
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	if (!TAG_RE.test(tag)) v.add("tag", "must be a lowercase word of up to 40 letters, digits, - or _ (paid, partially_paid, unpaid, billed, overdue, customer, vendor, or your own)");
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	if (ENTITY_TAGS.has(tag) && (entityId === null || !Number.isSafeInteger(entityId) || entityId < 1)) v.add("entity_id", `is required for the tag "${tag}": which ${tag}`);
	if (!ENTITY_TAGS.has(tag) && entityId !== null) v.add("entity_id", `only goes with the tags "customer" and "vendor"`);
	const note = input?.note === undefined ? "" : input.note;
	if (typeof note !== "string" || note.length > 200) v.add("note", "must be text of at most 200 characters");
	let id: bigint | null = null;
	let description: string | null = null;
	let quantity: string | null = null;
	let unit: string | null = null;
	let rateCents: number | null = null;
	const given = (x: unknown) => x !== undefined && x !== null && x !== "";
	if (tag === "rate") {
		if (given(input.id)) {
			const n = Number(input.id);
			if (!Number.isSafeInteger(n) || n < 1) v.add("id", "must be the number of one of the entry's rate items");
			else id = BigInt(n);
		}
		if (given(input.description)) {
			const d = typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : "";
			if (d.length < 1 || d.length > 100) v.add("description", "must be text of up to 100 characters, e.g. Labour");
			else description = d;
		}
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
		for (const k of ["id", "description", "quantity", "unit", "rate_cents"] as const) if (given(input?.[k])) v.add(k, `only goes with the tag "rate"`);
	}
	return { tag, id, description, entityId, note: typeof note === "string" ? note.trim() : "", quantity, unit, rateCents };
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
	if (t.tag === "rate") {
		// Rate items: a new one each time, or the one named by its id changed in place.
		const r = t.id === null
			? await tx.query(
					`INSERT INTO journal_entry_tags (entry_id, tag, note, module_id, created_by, description, quantity, unit, rate_cents) VALUES ($1, 'rate', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
					[entryId, t.note, by.moduleId, by.userId, t.description, t.quantity, t.unit, t.rateCents],
				)
			: await tx.query(
					`UPDATE journal_entry_tags SET note = $3, description = $4, quantity = $5, unit = $6, rate_cents = $7
					  WHERE id = $1 AND entry_id = $2 AND tag = 'rate' RETURNING id`,
					[t.id, entryId, t.note, t.description, t.quantity, t.unit, t.rateCents],
				);
		if (!r.rows[0]) {
			const v = new ValidationError();
			v.add("id", `entry ${entryId} has no rate item ${t.id}`);
			v.throwIfAny();
		}
		// A changed rate is news too: forms that copied it may want the new one.
		changes.push({ entry_id: Number(entryId), action: "set", tag: "rate", tag_id: Number(r.rows[0].id), entity_id: null, module_id: by.moduleId });
		return;
	}
	if (ENTITY_TAGS.has(t.tag) && t.entityId !== null) {
		// The entry's line in accounts receivable or payable moves to the customer's or vendor's own account,
		// which then says whose the entry is; a tag is kept only for an entry with no such line.
		const { moved, tracked } = await claimLines(tx, entryId, t.tag as EntityRole, t.entityId, by.userId);
		if (tracked) {
			await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2 AND entity_id = $3`, [entryId, t.tag, t.entityId]);
			if (moved > 0) changes.push({ entry_id: Number(entryId), action: "set", tag: t.tag, tag_id: null, entity_id: t.entityId, module_id: by.moduleId });
			return;
		}
	}
	const r = await tx.query(
		`INSERT INTO journal_entry_tags (entry_id, tag, entity_id, note, module_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (entry_id, tag, entity_id) WHERE tag <> 'rate' DO UPDATE
		   SET note = EXCLUDED.note
		 WHERE journal_entry_tags.note IS DISTINCT FROM EXCLUDED.note
		 RETURNING (xmax = 0) AS added`,
		[entryId, t.tag, t.entityId, t.note, by.moduleId, by.userId],
	);
	if (r.rows[0]?.added) changes.push({ entry_id: Number(entryId), action: "set", tag: t.tag, tag_id: null, entity_id: t.entityId, module_id: by.moduleId });
	for (const other of CLEARS[t.tag] ?? []) {
		const d = await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2`, [entryId, other]);
		if ((d.rowCount ?? 0) > 0) changes.push({ entry_id: Number(entryId), action: "removed", tag: other, tag_id: null, entity_id: null, module_id: by.moduleId });
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
 * Tags an entry. Setting a tag it already has changes nothing but the note.
 * "rate" is an item (description, quantity, rate): each one set is added,
 * unless input.id names an item of the entry to change. "paid" takes
 * "overdue" off. Returns the entry's tags.
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

/** Tags many entries at once, all or none (a "rate" item is added to each). Returns how many entries changed. */
export async function setTags(app: App, entryIds: unknown, input: TagInput, by: { moduleId: string | null; userId: number | null }): Promise<{ entries: number; changed: number }> {
	const ids = batchIds(entryIds);
	const v = new ValidationError();
	const t = check(v, input);
	if (t.id !== null) v.add("id", "names one entry's rate item: change it on that entry, not in a batch");
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
export async function removeTags(app: App, entryIds: unknown, input: { tag: string; entity_id?: number | null }, by: { moduleId: string | null; userId?: number | null }): Promise<{ entries: number; changed: number }> {
	const ids = batchIds(entryIds);
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	const v = new ValidationError();
	if (!TAG_RE.test(tag)) v.add("tag", "is not a tag");
	if (entityId !== null && (!Number.isSafeInteger(entityId) || entityId < 1)) v.add("entity_id", "must be a customer or vendor");
	v.throwIfAny();
	const gone = await withTx(app.db, {}, async (tx) => {
		await checkEntries(tx, ids);
		const rows = await queryRows<{ id: bigint; entry_id: bigint; entity_id: bigint | null }>(
			tx,
			`DELETE FROM journal_entry_tags WHERE entry_id = ANY($1::bigint[]) AND tag = $2 AND ($3::bigint IS NULL OR entity_id = $3) RETURNING id, entry_id, entity_id`,
			[ids, tag, entityId],
		);
		// Read from the customer's or vendor's own account: the line goes back to receivables or payables.
		if (ENTITY_TAGS.has(tag)) for (const id of ids) for (const who of await releaseLines(tx, id, tag as EntityRole, entityId, by.userId ?? null)) rows.push({ id: 0n, entry_id: id, entity_id: BigInt(who) });
		return rows;
	});
	announce(app, gone.map((g) => ({ entry_id: Number(g.entry_id), action: "removed" as const, tag, tag_id: tag === "rate" ? Number(g.id) : null, entity_id: g.entity_id === null ? null : Number(g.entity_id), module_id: by.moduleId })));
	return { entries: ids.length, changed: new Set(gone.map((g) => String(g.entry_id))).size };
}

/**
 * Takes a tag off an entry (for "customer" and "vendor": that one, or all of
 * them when no entity is given; for "rate": the item with that id, or all of
 * them when no id is given).
 */
export async function removeTag(app: App, entryId: bigint, input: { tag: string; entity_id?: number | null; id?: number | null }, by: { moduleId: string | null; userId?: number | null }): Promise<EntryTag[]> {
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	const entityId = input?.entity_id === undefined || input.entity_id === null ? null : Number(input.entity_id);
	const tagId = input?.id === undefined || input.id === null ? null : Number(input.id);
	if (!TAG_RE.test(tag) || (entityId !== null && (!Number.isSafeInteger(entityId) || entityId < 1)) || (tagId !== null && (!Number.isSafeInteger(tagId) || tagId < 1))) throw new NotFoundError();
	if (!(await queryRow(app.db, `SELECT 1 FROM journal_entries WHERE id = $1`, [entryId]))) throw new NotFoundError();
	const gone = await withTx(app.db, {}, async (tx) => {
		const rows = await queryRows<{ id: bigint; entity_id: bigint | null }>(
			tx,
			`DELETE FROM journal_entry_tags WHERE entry_id = $1 AND tag = $2 AND ($3::bigint IS NULL OR entity_id = $3) AND ($4::bigint IS NULL OR id = $4) RETURNING id, entity_id`,
			[entryId, tag, entityId, tagId],
		);
		// Read from the customer's or vendor's own account: the line goes back to receivables or payables.
		if (ENTITY_TAGS.has(tag) && tagId === null) for (const who of await releaseLines(tx, entryId, tag as EntityRole, entityId, by.userId ?? null)) rows.push({ id: 0n, entity_id: BigInt(who) });
		return rows;
	});
	announce(app, gone.map((g) => ({ entry_id: Number(entryId), action: "removed" as const, tag, tag_id: tag === "rate" ? Number(g.id) : null, entity_id: g.entity_id === null ? null : Number(g.entity_id), module_id: by.moduleId })));
	return (await tagsOfEntries(app.db, [entryId])).get(Number(entryId)) ?? [];
}

/** Every tag in use, with how many entries carry it (the standard ones always listed). */
export async function listTags(app: App): Promise<{ tag: string; entries: number; standard: boolean }[]> {
	const rows = await queryRows<{ tag: string; n: bigint }>(app.db, `SELECT tag, count(DISTINCT entry_id) AS n
		   FROM (SELECT tag, entry_id FROM journal_entry_tags
		         UNION SELECT a.entity_role, t.journal_entry_id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.entity_id IS NOT NULL) x
		  GROUP BY tag`);
	const counts = new Map(rows.map((r) => [r.tag, Number(r.n)]));
	const std = STANDARD_TAGS as readonly string[];
	return [...std, ...rows.map((r) => r.tag).filter((t) => !std.includes(t)).sort()].map((tag) => ({ tag, entries: counts.get(tag) ?? 0, standard: std.includes(tag) }));
}
