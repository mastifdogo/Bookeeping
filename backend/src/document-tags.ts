// Tags on documents and the data read out of them (migration 030), shared by
// Ledger and every module the way the tags on journal entries are (tags.ts).
//
// A tag says something about a file that every module should see: it has
// been posted, it is paid, or its data has been extracted. "extracted" is the
// one Ledger keeps itself: it is on a document exactly while the document has
// an extraction (what was read out of it: fields as JSON, and its plain
// text), so a module checks for it and reads the extraction instead of
// reading, parsing or sending the file to the AI again.

import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";

/** The file tags every module understands the same way. Others are allowed: lowercase words. */
export const STANDARD_FILE_TAGS = ["extracted", "posted", "paid", "billed", "overdue"] as const;
const TAG_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** Setting the first takes the others off: a bill that is paid is no longer overdue. */
const CLEARS: Record<string, string[]> = { paid: ["overdue"] };
/** Kept by Ledger: on a document while it has an extraction, set and removed with it. */
export const EXTRACTED = "extracted";

export const MAX_EXTRACTION_DATA = 2 * 1024 * 1024;
export const MAX_EXTRACTION_TEXT = 5_000_000;
export const MAX_TAG_BATCH = 500;

export interface DocumentTag {
	tag: string;
	note: string;
	/** The module that set it; null when a person did. */
	module_id: string | null;
	set_by: string | null;
	set_at: Date;
}

export interface DocumentTagChange {
	document_id: number;
	action: "set" | "removed";
	tag: string;
	/** The module that made the change; null when a person (or Ledger) did. */
	module_id: string | null;
}

/** What a document's listing says about its extraction, without the data itself. */
export interface ExtractionSummary {
	/** The module that read it last; null when Ledger did. */
	module_id: string | null;
	extracted_at: Date;
	updated_at: Date;
	/** The top-level keys of the data, e.g. ["type", "vendor", "total_cents", "items"]. */
	keys: string[];
	has_text: boolean;
	/** Where a logged-in user's browser (or a module's page) reads it. */
	url: string;
}

export interface Extraction extends ExtractionSummary {
	document_id: number;
	data: Record<string, unknown>;
	text: string | null;
	extracted_by: string | null;
}

export interface ExtractionInput {
	/** Fields read from the file. Merged into what is there key by key; a key set to null is removed. */
	data?: Record<string, unknown>;
	/** The file's plain text; null takes it away, left out keeps it. */
	text?: string | null;
	/** true: `data` replaces everything that was there instead of merging. */
	replace?: boolean;
}

type By = { moduleId: string | null; userId: number | null };

const docId = (id: unknown): bigint => {
	if (typeof id === "bigint" && id > 0n) return id;
	if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return BigInt(id);
	if (typeof id === "string" && /^[1-9]\d{0,17}$/.test(id)) return BigInt(id);
	throw new NotFoundError();
};

export const extractionUrl = (id: number | bigint) => `/api/v1/documents/${id}/extracted`;

type TagRow = { document_id: bigint; tag: string; note: string; module_id: string | null; username: string | null; created_at: Date };
const toTag = (r: TagRow): DocumentTag => ({ tag: r.tag, note: r.note, module_id: r.module_id, set_by: r.username, set_at: r.created_at });

/** The tags of each of the given documents. */
export async function tagsOfDocuments(db: Queryable, ids: (number | bigint)[]): Promise<Map<number, DocumentTag[]>> {
	const out = new Map<number, DocumentTag[]>();
	if (ids.length === 0) return out;
	const rows = await queryRows<TagRow>(
		db,
		`SELECT t.document_id, t.tag, t.note, t.module_id, u.username, t.created_at
		   FROM document_tags t LEFT JOIN users u ON u.id = t.created_by
		  WHERE t.document_id = ANY($1::bigint[]) ORDER BY t.id`,
		[ids],
	);
	for (const r of rows) {
		const k = Number(r.document_id);
		out.set(k, [...(out.get(k) ?? []), toTag(r)]);
	}
	return out;
}

async function mustExist(db: Queryable, id: bigint): Promise<void> {
	if (!(await queryRow(db, `SELECT 1 FROM documents WHERE id = $1`, [id]))) throw new NotFoundError();
}

export async function documentTagsOf(app: App, id: unknown): Promise<DocumentTag[]> {
	const d = docId(id);
	await mustExist(app.db, d);
	return (await tagsOfDocuments(app.db, [d])).get(Number(d)) ?? [];
}

function checkTag(input: { tag?: unknown; note?: unknown }): { tag: string; note: string } {
	const v = new ValidationError();
	const tag = typeof input?.tag === "string" ? input.tag.trim().toLowerCase() : "";
	if (!TAG_RE.test(tag)) v.add("tag", "must be a lowercase word of up to 40 letters, digits, - or _ (posted, paid, billed, overdue, or your own)");
	if (tag === EXTRACTED) v.add("tag", `"extracted" is set by saving what was read from the file (documents.setExtracted), not by hand`);
	const note = input?.note === undefined || input.note === null ? "" : input.note;
	if (typeof note !== "string" || note.length > 200) v.add("note", "must be text of at most 200 characters");
	v.throwIfAny();
	return { tag, note: (note as string).trim() };
}

/** Tells every module that listens (ctx.documents.tags.onChange), after the change is saved. */
function announce(app: App, changes: DocumentTagChange[]): void {
	if (changes.length === 0) return;
	for (const m of app.modules.modules.values()) {
		if (m.error) continue;
		for (const fn of m.documentTagListeners) {
			for (const c of changes) {
				Promise.resolve()
					.then(() => fn({ ...c }))
					.catch((err: Error) => log.error("module document tag listener failed", { module: m.manifest.id, err: err.message }));
			}
		}
	}
}

async function setTagTx(tx: Queryable, id: bigint, t: { tag: string; note: string }, by: By, changes: DocumentTagChange[]): Promise<void> {
	const r = await tx.query(
		`INSERT INTO document_tags (document_id, tag, note, module_id, created_by) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (document_id, tag) DO UPDATE SET note = EXCLUDED.note
		 WHERE document_tags.note IS DISTINCT FROM EXCLUDED.note
		 RETURNING (xmax = 0) AS added`,
		[id, t.tag, t.note, by.moduleId, by.userId],
	);
	if (r.rows[0]?.added) changes.push({ document_id: Number(id), action: "set", tag: t.tag, module_id: by.moduleId });
	for (const other of CLEARS[t.tag] ?? []) {
		const d = await tx.query(`DELETE FROM document_tags WHERE document_id = $1 AND tag = $2`, [id, other]);
		if ((d.rowCount ?? 0) > 0) changes.push({ document_id: Number(id), action: "removed", tag: other, module_id: by.moduleId });
	}
}

/** Tags a document. Setting a tag it already has changes nothing but the note. "paid" takes "overdue" off. Returns its tags. */
export async function setDocumentTag(app: App, id: unknown, input: { tag: string; note?: string }, by: By): Promise<DocumentTag[]> {
	const d = docId(id);
	const t = checkTag(input);
	const changes: DocumentTagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		await mustExist(tx, d);
		await setTagTx(tx, d, t, by, changes);
	});
	announce(app, changes);
	return (await tagsOfDocuments(app.db, [d])).get(Number(d)) ?? [];
}

/** Takes a tag off a document. Taking "extracted" off forgets what was read from it. Returns its tags. */
export async function removeDocumentTag(app: App, id: unknown, tag: unknown, by: { moduleId: string | null }): Promise<DocumentTag[]> {
	const d = docId(id);
	const name = typeof tag === "string" ? tag.trim().toLowerCase() : "";
	if (!TAG_RE.test(name)) throw new NotFoundError();
	await mustExist(app.db, d);
	if (name === EXTRACTED) {
		await clearExtraction(app, d, by);
	} else {
		const gone = await app.db.query(`DELETE FROM document_tags WHERE document_id = $1 AND tag = $2`, [d, name]);
		if ((gone.rowCount ?? 0) > 0) announce(app, [{ document_id: Number(d), action: "removed", tag: name, module_id: by.moduleId }]);
	}
	return (await tagsOfDocuments(app.db, [d])).get(Number(d)) ?? [];
}

function batchIds(ids: unknown): bigint[] {
	const v = new ValidationError();
	if (!Array.isArray(ids) || ids.length === 0) v.add("document_ids", "must be a list of document numbers");
	else if (ids.length > MAX_TAG_BATCH) v.add("document_ids", `at most ${MAX_TAG_BATCH} documents at a time`);
	v.throwIfAny();
	const out = new Set<bigint>();
	(ids as unknown[]).forEach((x, i) => {
		try {
			out.add(docId(x));
		} catch {
			v.add(`document_ids[${i}]`, "must be a document number");
		}
	});
	v.throwIfAny();
	return [...out];
}

async function checkDocuments(tx: Queryable, ids: bigint[]): Promise<void> {
	const found = await queryRows<{ id: bigint }>(tx, `SELECT id FROM documents WHERE id = ANY($1::bigint[])`, [ids]);
	const have = new Set(found.map((r) => String(r.id)));
	const missing = ids.filter((i) => !have.has(String(i)));
	if (missing.length) {
		const v = new ValidationError();
		v.add("document_ids", `no such document${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
		v.throwIfAny();
	}
}

/** Tags many documents at once, all or none. Returns how many there were and how many changed. */
export async function setDocumentTags(app: App, documentIds: unknown, input: { tag: string; note?: string }, by: By): Promise<{ documents: number; changed: number }> {
	const ids = batchIds(documentIds);
	const t = checkTag(input);
	const changes: DocumentTagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		await checkDocuments(tx, ids);
		for (const id of ids) await setTagTx(tx, id, t, by, changes);
	});
	announce(app, changes);
	return { documents: ids.length, changed: new Set(changes.filter((c) => c.action === "set").map((c) => c.document_id)).size };
}

/** Takes a tag off many documents at once. Returns how many there were and how many had it. */
export async function removeDocumentTags(app: App, documentIds: unknown, tag: unknown, by: { moduleId: string | null }): Promise<{ documents: number; changed: number }> {
	const ids = batchIds(documentIds);
	const name = typeof tag === "string" ? tag.trim().toLowerCase() : "";
	const v = new ValidationError();
	if (!TAG_RE.test(name)) v.add("tag", "is not a tag");
	if (name === EXTRACTED) v.add("tag", `take "extracted" off one document at a time: it forgets what was read from it`);
	v.throwIfAny();
	const gone = await withTx(app.db, {}, async (tx) => {
		await checkDocuments(tx, ids);
		return queryRows<{ document_id: bigint }>(tx, `DELETE FROM document_tags WHERE document_id = ANY($1::bigint[]) AND tag = $2 RETURNING document_id`, [ids, name]);
	});
	announce(app, gone.map((g) => ({ document_id: Number(g.document_id), action: "removed" as const, tag: name, module_id: by.moduleId })));
	return { documents: ids.length, changed: gone.length };
}

/** Every file tag in use, with how many documents carry it (the standard ones always listed). */
export async function listDocumentTags(app: App): Promise<{ tag: string; documents: number; standard: boolean }[]> {
	const rows = await queryRows<{ tag: string; n: number }>(app.db, `SELECT tag, count(*)::int AS n FROM document_tags GROUP BY tag`);
	const counts = new Map(rows.map((r) => [r.tag, r.n]));
	const std = STANDARD_FILE_TAGS as readonly string[];
	return [...std, ...rows.map((r) => r.tag).filter((t) => !std.includes(t)).sort()].map((tag) => ({ tag, documents: counts.get(tag) ?? 0, standard: std.includes(tag) }));
}

// ---------------------------------------------------------------------------
// Extractions
// ---------------------------------------------------------------------------

type ExtractionRow = { document_id: bigint; data: Record<string, unknown>; text: string | null; module_id: string | null; username: string | null; created_at: Date; updated_at: Date };
const toExtraction = (r: ExtractionRow): Extraction => ({
	document_id: Number(r.document_id),
	data: r.data,
	text: r.text,
	module_id: r.module_id,
	extracted_by: r.username,
	extracted_at: r.created_at,
	updated_at: r.updated_at,
	keys: Object.keys(r.data),
	has_text: r.text !== null && r.text !== "",
	url: extractionUrl(r.document_id),
});

/** What was read out of a document, or null when nothing has been yet. */
export async function getExtraction(app: App, id: unknown): Promise<Extraction | null> {
	const d = docId(id);
	const r = await queryRow<ExtractionRow>(
		app.db,
		`SELECT x.document_id, x.data, x.text, x.module_id, u.username, x.created_at, x.updated_at
		   FROM document_extractions x LEFT JOIN users u ON u.id = x.created_by WHERE x.document_id = $1`,
		[d],
	);
	if (r) return toExtraction(r);
	await mustExist(app.db, d);
	return null;
}

function plainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/**
 * Saves what was read out of a document and tags it "extracted". `data` is
 * merged into what is already there key by key (a key set to null is
 * removed), so one module can add the transactions to the fields another
 * read; `replace: true` starts over. Returns the extraction.
 */
export async function setExtraction(app: App, id: unknown, input: ExtractionInput, by: By): Promise<Extraction> {
	const d = docId(id);
	const v = new ValidationError();
	const o = (input ?? {}) as ExtractionInput;
	if (o.data !== undefined && !plainObject(o.data)) v.add("data", "must be an object of the fields read from the file, e.g. { type, vendor, date, total_cents, items }");
	if (o.text !== undefined && o.text !== null && typeof o.text !== "string") v.add("text", "must be the file's text");
	if (typeof o.text === "string" && o.text.length > MAX_EXTRACTION_TEXT) v.add("text", `must be at most ${MAX_EXTRACTION_TEXT.toLocaleString("en")} characters`);
	if (o.data === undefined && o.text === undefined) v.add("data", "give the data read from the file, its text, or both");
	if (typeof o.text === "string" && o.text.includes("\0")) v.add("text", "must not contain NUL characters");
	let given: Record<string, unknown> = {};
	if (plainObject(o.data)) {
		try {
			// Through JSON: bigint cents become numbers, and anything JSON can't carry is refused.
			given = JSON.parse(JSON.stringify(o.data, (_k, x) => (typeof x === "bigint" ? Number(x) : x))) as Record<string, unknown>;
		} catch {
			v.add("data", "must be plain JSON (no circular references)");
		}
	}
	v.throwIfAny();

	const changes: DocumentTagChange[] = [];
	await withTx(app.db, {}, async (tx) => {
		// The document's row is locked so two modules saving at once merge rather than overwrite.
		if (!(await queryRow(tx, `SELECT 1 FROM documents WHERE id = $1 FOR UPDATE`, [d]))) throw new NotFoundError();
		const cur = await queryRow<{ data: Record<string, unknown>; text: string | null }>(tx, `SELECT data, text FROM document_extractions WHERE document_id = $1`, [d]);
		const data: Record<string, unknown> = o.data === undefined ? (cur?.data ?? {}) : { ...(o.replace ? {} : (cur?.data ?? {})), ...given };
		for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
		const json = JSON.stringify(data);
		// A NUL inside a value is written \u0000 by JSON.stringify; the same six characters typed as text come out as \\u0000.
		if (/(?<!\\)(?:\\\\)*\\u0000/.test(json)) throw new HttpError(422, "the data read from a document must not contain NUL characters", "validation_failed");
		if (Buffer.byteLength(json) > MAX_EXTRACTION_DATA) throw new HttpError(413, `the data read from a document is at most ${MAX_EXTRACTION_DATA / 1024 / 1024} MB as JSON`, "payload_too_large");
		await tx.query(
			`INSERT INTO document_extractions (document_id, data, text, module_id, created_by) VALUES ($1, $2::jsonb, $3, $4, $5)
			 ON CONFLICT (document_id) DO UPDATE
			   SET data = EXCLUDED.data, text = EXCLUDED.text, module_id = EXCLUDED.module_id,
			       created_by = coalesce(EXCLUDED.created_by, document_extractions.created_by), updated_at = now()`,
			[d, json, o.text === undefined ? (cur?.text ?? null) : o.text, by.moduleId, by.userId],
		);
		const t = await tx.query(
			`INSERT INTO document_tags (document_id, tag, module_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (document_id, tag) DO NOTHING RETURNING id`,
			[d, EXTRACTED, by.moduleId, by.userId],
		);
		if ((t.rowCount ?? 0) > 0) changes.push({ document_id: Number(d), action: "set", tag: EXTRACTED, module_id: by.moduleId });
	});
	announce(app, changes);
	return (await getExtraction(app, d))!;
}

/** Forgets what was read out of a document (and takes "extracted" off), so it can be read again. False when there was nothing. */
export async function clearExtraction(app: App, id: unknown, by: { moduleId: string | null }): Promise<boolean> {
	const d = docId(id);
	const gone = await withTx(app.db, {}, async (tx) => {
		const x = await tx.query(`DELETE FROM document_extractions WHERE document_id = $1`, [d]);
		const t = await tx.query(`DELETE FROM document_tags WHERE document_id = $1 AND tag = $2`, [d, EXTRACTED]);
		return (x.rowCount ?? 0) + (t.rowCount ?? 0) > 0;
	});
	if (gone) announce(app, [{ document_id: Number(d), action: "removed", tag: EXTRACTED, module_id: by.moduleId }]);
	return gone;
}
