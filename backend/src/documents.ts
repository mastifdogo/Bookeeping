// Documents: one place for the PDFs (and scans) a business keeps: receipts,
// statements and invoices that were imported, and PDFs made in Ledger (an
// invoice a module drew up, a report). People manage them on the Documents
// page; modules read and add them through ctx.documents.
//
// The files are ordinary files on the data share, in folders a person can
// browse, per organization:
//
//   <CSV_DIR>/.modules/_documents/receipts/2026/12-hydro-march.pdf
//   <CSV_DIR>/.orgs/<database>/.modules/_documents/invoices/2026/31-inv-0031.pdf
//
// They sit beside the modules' own files (ctx.storage) so every backup folder
// carries them (files/_documents/...) and a restore brings them back; no
// module can be called "_documents". The documents table is their index.

import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { App } from "./app.ts";
import { queryRow, queryRows } from "./db.ts";
import { HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { filesDir } from "./orgs.ts";

export const DOCUMENT_KINDS = ["receipt", "statement", "invoice", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_ORIGINS = ["imported", "created"] as const;
export type DocumentOrigin = (typeof DOCUMENT_ORIGINS)[number];
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const FOLDERS: Record<DocumentKind, string> = { receipt: "receipts", statement: "statements", invoice: "invoices", other: "other" };

/** What a file may be, told from its first bytes (never from its name). */
const TYPES: { type: string; ext: string; is: (b: Buffer) => boolean }[] = [
	{ type: "application/pdf", ext: ".pdf", is: (b) => b.subarray(0, 1024).includes("%PDF-") },
	{ type: "image/png", ext: ".png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ type: "image/jpeg", ext: ".jpg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

export interface DocumentInfo {
	id: number;
	kind: DocumentKind;
	origin: DocumentOrigin;
	/** "user", or the id of the module that added it. */
	source: string;
	title: string;
	filename: string;
	/** Its place in the documents folder, e.g. "receipts/2026/12-hydro-march.pdf". */
	path: string;
	content_type: string;
	size_bytes: number;
	sha256: string;
	/** The date on the document (YYYY-MM-DD), if known. */
	doc_date: string | null;
	entity_id: number | null;
	entity_name: string | null;
	note: string;
	added_by: string | null;
	created_at: Date;
	updated_at: Date;
	/** The address a logged-in user's browser opens it at. */
	url: string;
	/** What modules did with it: [{ module, status, note }]. */
	marks: { module: string; status: "done" | "skipped"; note: string }[];
}

export interface DocumentAdd {
	kind: DocumentKind;
	filename: string;
	data: Buffer;
	origin?: DocumentOrigin;
	title?: string;
	doc_date?: string | null;
	entity_id?: number | null;
	note?: string;
}

export interface DocumentFilter {
	kind?: DocumentKind | null;
	origin?: DocumentOrigin | null;
	source?: string | null;
	year?: number | null;
	entity_id?: number | null;
	/** Words in the title, file name, note or entity name. */
	q?: string | null;
	/** Only documents this module hasn't marked yet. */
	unmarkedBy?: string | null;
	limit?: number;
	offset?: number;
}

const SELECT = `
	SELECT d.id, d.kind, d.origin, d.source, d.title, d.filename, d.path, d.content_type, d.size_bytes, d.sha256,
	       to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, d.entity_id, e.name AS entity_name, d.note, u.username AS added_by,
	       d.created_at, d.updated_at,
	       coalesce((SELECT jsonb_agg(jsonb_build_object('module', m.module, 'status', m.status, 'note', m.note) ORDER BY m.module)
	                   FROM document_marks m WHERE m.document_id = d.id), '[]'::jsonb) AS marks
	  FROM documents d
	  LEFT JOIN entities e ON e.id = d.entity_id
	  LEFT JOIN users u ON u.id = d.created_by`;

type Row = Omit<DocumentInfo, "id" | "entity_id" | "url"> & { id: bigint; entity_id: bigint | null };
const toInfo = (r: Row): DocumentInfo => ({ ...r, id: Number(r.id), entity_id: r.entity_id === null ? null : Number(r.entity_id), url: `/api/v1/documents/${r.id}/file` });

export const documentsDir = async (app: App) => path.join(await filesDir(app), ".modules", "_documents");

export function documentId(id: unknown): bigint {
	if (typeof id === "bigint" && id > 0n) return id;
	if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return BigInt(id);
	if (typeof id === "string" && /^[1-9]\d{0,17}$/.test(id)) return BigInt(id);
	throw new NotFoundError();
}

/** A file name that is safe in any folder: letters, digits, dots, dashes. */
function slug(name: string): string {
	const base = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\.[A-Za-z0-9]{1,5}$/, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.toLowerCase();
	return base || "document";
}

const yearOf = (docDate: string | null, added: Date) => (docDate ? docDate.slice(0, 4) : String(added.getFullYear()));
const relPath = (id: bigint | number, kind: DocumentKind, year: string, filename: string, ext: string) => `${FOLDERS[kind]}/${year}/${id}-${slug(filename)}${ext}`;

function checkFields(o: Record<string, unknown>, err: ValidationError) {
	const out: { kind?: DocumentKind; origin?: DocumentOrigin; title?: string; doc_date?: string | null; entity_id?: number | null; note?: string } = {};
	if (o.kind !== undefined) {
		if (!DOCUMENT_KINDS.includes(o.kind as DocumentKind)) err.add("kind", `must be one of ${DOCUMENT_KINDS.join(", ")}`);
		else out.kind = o.kind as DocumentKind;
	}
	if (o.origin !== undefined) {
		if (!DOCUMENT_ORIGINS.includes(o.origin as DocumentOrigin)) err.add("origin", `must be one of ${DOCUMENT_ORIGINS.join(", ")}`);
		else out.origin = o.origin as DocumentOrigin;
	}
	if (o.title !== undefined) {
		const t = typeof o.title === "string" ? o.title.trim() : "";
		if (t.length < 1 || t.length > 200 || /[\r\n\0]/.test(t)) err.add("title", "must be 1-200 characters on one line");
		else out.title = t;
	}
	if (o.doc_date !== undefined) {
		if (o.doc_date === null || o.doc_date === "") out.doc_date = null;
		else if (typeof o.doc_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.doc_date) || Number.isNaN(new Date(`${o.doc_date}T00:00:00Z`).getTime())) err.add("doc_date", "must be a date (YYYY-MM-DD)");
		else out.doc_date = o.doc_date;
	}
	if (o.entity_id !== undefined) {
		if (o.entity_id === null || o.entity_id === "") out.entity_id = null;
		else if (!Number.isSafeInteger(Number(o.entity_id)) || Number(o.entity_id) < 1) err.add("entity_id", "must be an entity's id");
		else out.entity_id = Number(o.entity_id);
	}
	if (o.note !== undefined) {
		if (typeof o.note !== "string" || o.note.length > 2000) err.add("note", "must be text of at most 2000 characters");
		else out.note = o.note.trim();
	}
	return out;
}

async function checkEntity(app: App, id: number | null | undefined, err: ValidationError) {
	if (id === null || id === undefined) return;
	if (!(await queryRow(app.db, `SELECT 1 FROM entities WHERE id = $1`, [id]))) err.add("entity_id", "no such entity");
}

export async function getDocument(app: App, id: unknown): Promise<DocumentInfo> {
	const r = await queryRow<Row>(app.db, SELECT + ` WHERE d.id = $1`, [documentId(id)]);
	if (!r) throw new NotFoundError();
	return toInfo(r);
}

export async function listDocuments(app: App, f: DocumentFilter = {}): Promise<{ data: DocumentInfo[]; total: number }> {
	const where: string[] = [];
	const args: unknown[] = [];
	const add = (sql: string, v: unknown) => {
		args.push(v);
		where.push(sql.replace("?", `$${args.length}`));
	};
	if (f.kind) add(`d.kind = ?`, f.kind);
	if (f.origin) add(`d.origin = ?`, f.origin);
	if (f.source) add(`d.source = ?`, f.source);
	if (f.year) add(`extract(year FROM coalesce(d.doc_date, (d.created_at AT TIME ZONE 'UTC')::date)) = ?`, f.year);
	if (f.entity_id) add(`d.entity_id = ?`, f.entity_id);
	if (f.unmarkedBy) add(`NOT EXISTS (SELECT 1 FROM document_marks m WHERE m.document_id = d.id AND m.module = ?)`, f.unmarkedBy);
	for (const word of (f.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
		add(`(d.title || ' ' || d.filename || ' ' || d.note || ' ' || coalesce(e.name, '')) ILIKE ?`, `%${word.replace(/[\\%_]/g, "\\$&")}%`);
	}
	const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";
	const limit = Math.min(Math.max(Math.trunc(f.limit ?? 100), 1), 500);
	const offset = Math.max(Math.trunc(f.offset ?? 0), 0);
	const [rows, count] = await Promise.all([
		queryRows<Row>(app.db, SELECT + cond + ` ORDER BY coalesce(d.doc_date, (d.created_at AT TIME ZONE 'UTC')::date) DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`, args),
		queryRow<{ n: number }>(app.db, `SELECT count(*)::int AS n FROM documents d LEFT JOIN entities e ON e.id = d.entity_id` + cond, args),
	]);
	return { data: rows.map(toInfo), total: count?.n ?? 0 };
}

/** The folders of the documents store with how much each holds: kind → year. */
export async function documentFolders(app: App) {
	return queryRows<{ kind: DocumentKind; year: number; count: number; size_bytes: number }>(
		app.db,
		`SELECT kind, extract(year FROM coalesce(doc_date, (created_at AT TIME ZONE 'UTC')::date))::int AS year, count(*)::int AS count, sum(size_bytes)::bigint::float8 AS size_bytes
		   FROM documents GROUP BY 1, 2 ORDER BY 1, 2 DESC`,
	);
}

type Listener = (doc: DocumentInfo) => unknown;

/** Tells every running module that listens (ctx.documents.onAdded) about a new document, except the one that added it. */
function announce(app: App, doc: DocumentInfo) {
	for (const m of app.modules.modules.values()) {
		if (m.error || m.manifest.id === doc.source) continue;
		for (const fn of m.documentListeners) {
			Promise.resolve()
				.then(() => fn({ ...doc }))
				.catch((err: Error) => log.error("module document listener failed", { module: m.manifest.id, document: doc.id, err: err.message }));
		}
	}
}

/**
 * Adds a document: checks it is a PDF, PNG or JPEG, refuses a file that is
 * already there (409, naming it), writes it into its folder and records it.
 */
export async function addDocument(app: App, input: DocumentAdd, by: { source: string; userId: number | null }): Promise<DocumentInfo> {
	const err = new ValidationError();
	const f = checkFields({ kind: input.kind, origin: input.origin, title: input.title, doc_date: input.doc_date, entity_id: input.entity_id, note: input.note }, err);
	if (input.kind === undefined) err.add("kind", `must be one of ${DOCUMENT_KINDS.join(", ")}`);
	const filename = typeof input.filename === "string" ? path.basename(input.filename.replace(/\\/g, "/")).trim() : "";
	if (filename.length < 1 || filename.length > 255 || /[\r\n\0]/.test(filename)) err.add("filename", "must be a file name of 1-255 characters");
	const data = input.data;
	if (!Buffer.isBuffer(data) || data.length === 0) err.add("data", "is empty");
	else if (data.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, `documents are at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`, "payload_too_large");
	const type = Buffer.isBuffer(data) ? TYPES.find((t) => t.is(data)) : undefined;
	if (Buffer.isBuffer(data) && data.length > 0 && !type) err.add("data", "must be a PDF, or a PNG or JPEG picture");
	await checkEntity(app, f.entity_id, err);
	err.throwIfAny();

	const sha256 = createHash("sha256").update(data).digest("hex");
	const dup = await queryRow<{ id: bigint; title: string }>(app.db, `SELECT id, title FROM documents WHERE sha256 = $1 ORDER BY id LIMIT 1`, [sha256]);
	if (dup) throw new HttpError(409, `this file is already here as "${dup.title}" (document ${dup.id})`, "duplicate_document");

	const title = f.title ?? (filename.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_-]+/g, " ").trim().slice(0, 200) || "Document");
	const root = await documentsDir(app);
	// The row comes first (its id names the file); a file that can't be written takes the row back out.
	const row = await queryRow<{ id: bigint; created_at: Date }>(
		app.db,
		`INSERT INTO documents (kind, origin, source, title, filename, path, content_type, size_bytes, sha256, doc_date, entity_id, note, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, created_at`,
		[f.kind, f.origin ?? "imported", by.source, title, filename, `pending/${randomBytes(12).toString("hex")}`, type!.type, data.length, sha256, f.doc_date ?? null, f.entity_id ?? null, f.note ?? "", by.userId],
	);
	const rel = relPath(row!.id, f.kind!, yearOf(f.doc_date ?? null, row!.created_at), filename, type!.ext);
	const full = path.join(root, rel);
	try {
		await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o750 });
		const tmp = `${full}.${randomBytes(4).toString("hex")}.tmp`;
		await fsp.writeFile(tmp, data, { mode: 0o640 });
		await fsp.rename(tmp, full);
		await app.db.query(`UPDATE documents SET path = $2 WHERE id = $1`, [row!.id, rel]);
	} catch (e) {
		await app.db.query(`DELETE FROM documents WHERE id = $1`, [row!.id]).catch(() => undefined);
		await fsp.rm(full, { force: true }).catch(() => undefined);
		throw new HttpError(500, `could not save the document: ${(e as Error).message}`, "internal");
	}
	const doc = await getDocument(app, row!.id);
	announce(app, doc);
	return doc;
}

/** Changes a document's details; its file moves when the kind or the year changes, so the folders stay true. */
export async function updateDocument(app: App, id: unknown, change: unknown): Promise<DocumentInfo> {
	const cur = await getDocument(app, id);
	const err = new ValidationError();
	const o = (change && typeof change === "object" && !Array.isArray(change) ? change : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!["kind", "title", "doc_date", "entity_id", "note"].includes(k)) err.add(k, "unknown field");
	const f = checkFields(o, err);
	await checkEntity(app, f.entity_id, err);
	err.throwIfAny();
	const kind = f.kind ?? cur.kind;
	const docDate = f.doc_date !== undefined ? f.doc_date : cur.doc_date;
	const rel = relPath(cur.id, kind, yearOf(docDate, cur.created_at), cur.filename, path.extname(cur.path));
	if (rel !== cur.path) {
		const root = await documentsDir(app);
		await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o750 });
		// A missing file (after a restore from an uploaded dump) still lets the details change.
		await fsp.rename(path.join(root, cur.path), path.join(root, rel)).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw new HttpError(500, `could not move the document: ${e.message}`, "internal");
		});
		await pruneEmpty(root, path.dirname(path.join(root, cur.path)));
	}
	await app.db.query(`UPDATE documents SET kind = $2, title = $3, doc_date = $4, entity_id = $5, note = $6, path = $7, updated_at = now() WHERE id = $1`, [
		cur.id,
		kind,
		f.title ?? cur.title,
		docDate,
		f.entity_id !== undefined ? f.entity_id : cur.entity_id,
		f.note ?? cur.note,
		rel,
	]);
	return getDocument(app, cur.id);
}

async function pruneEmpty(root: string, dir: string) {
	for (; dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
		if ((await fsp.readdir(dir).catch(() => ["x"])).length > 0) break;
		await fsp.rmdir(dir).catch(() => undefined);
	}
}

export async function deleteDocument(app: App, id: unknown): Promise<void> {
	const cur = await getDocument(app, id);
	const root = await documentsDir(app);
	await app.db.query(`DELETE FROM documents WHERE id = $1`, [cur.id]);
	await fsp.rm(path.join(root, cur.path), { force: true });
	await pruneEmpty(root, path.dirname(path.join(root, cur.path)));
}

/** Where a document's file is, for sending it to a browser; null when the file is gone. */
export async function openDocument(app: App, id: unknown): Promise<{ doc: DocumentInfo; full: string } | null> {
	const doc = await getDocument(app, id);
	const full = path.join(await documentsDir(app), doc.path);
	const st = await fsp.lstat(full).catch(() => null);
	return st?.isFile() ? { doc, full } : null;
}

export async function readDocument(app: App, id: unknown): Promise<Buffer> {
	const f = await openDocument(app, id);
	if (!f) throw new HttpError(404, "the document's file is missing from the data share", "not_found");
	return fsp.readFile(f.full);
}

/** What module `self` can do with documents, in the organization the code runs in. */
export function documentsFor(app: App, self: string, actorOf: (u: unknown) => number | null, listeners: Listener[]) {
	const bytes = (data: unknown): Buffer => {
		if (Buffer.isBuffer(data)) return data;
		if (data instanceof Uint8Array) return Buffer.from(data);
		if (typeof data === "string") return Buffer.from(data, "base64");
		throw new HttpError(422, "documents.add: data must be a Buffer, Uint8Array or base64 text", "validation_failed");
	};
	return {
		kinds: DOCUMENT_KINDS,
		/** Documents, newest first: { kind, origin, source, year, entity_id, q, unmarked, limit, offset } → { data, total }. */
		list: (f: Omit<DocumentFilter, "unmarkedBy"> & { unmarked?: boolean } = {}) => {
			const { unmarked, ...rest } = f ?? {};
			return listDocuments(app, { ...rest, unmarkedBy: unmarked ? self : null });
		},
		/** One document's details (throws 404 if there is none). */
		get: (id: number | string) => getDocument(app, id),
		/** Its bytes (a Buffer). */
		read: (id: number | string) => readDocument(app, id),
		/**
		 * Adds a PDF (or PNG/JPEG): { kind, filename, data, origin?, title?, doc_date?, entity_id?, note? }.
		 * origin is "created" for a PDF this module made (the default) and "imported" for one it brought in.
		 * Pass the user of the request when a person asked for it.
		 */
		add: (d: Omit<DocumentAdd, "data"> & { data: Buffer | Uint8Array | string }, user?: unknown) =>
			addDocument(app, { ...d, origin: d?.origin ?? "created", data: bytes(d?.data) }, { source: self, userId: actorOf(user) }),
		/** Changes kind, title, doc_date, entity_id or note. */
		update: (id: number | string, change: object) => updateDocument(app, id, change),
		/** Deletes a document this module added (others belong to the people who keep them). */
		async remove(id: number | string): Promise<void> {
			const d = await getDocument(app, id);
			if (d.source !== self) throw new HttpError(403, "a module can only delete documents it added itself", "forbidden");
			await deleteDocument(app, id);
		},
		/** Records what this module did with a document ("done" or "skipped"), so list({ unmarked: true }) leaves it out. */
		async mark(id: number | string, status: "done" | "skipped" = "done", note = ""): Promise<void> {
			if (status !== "done" && status !== "skipped") throw new HttpError(422, 'documents.mark: status must be "done" or "skipped"', "validation_failed");
			if (typeof note !== "string" || note.length > 500) throw new HttpError(422, "documents.mark: note must be text of at most 500 characters", "validation_failed");
			const d = await getDocument(app, id);
			await app.db.query(
				`INSERT INTO document_marks (document_id, module, status, note) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (document_id, module) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`,
				[d.id, self, status, note],
			);
		},
		/** Takes this module's mark off again. */
		async unmark(id: number | string): Promise<void> {
			await app.db.query(`DELETE FROM document_marks WHERE document_id = $1 AND module = $2`, [documentId(id), self]);
		},
		/** The address a logged-in user's browser opens the document at (for links and <iframe>). */
		url: (id: number | string) => `/api/v1/documents/${documentId(id)}/file`,
		/** Called with a document's details right after a person or another module adds one. */
		onAdded(fn: Listener) {
			if (typeof fn !== "function") throw new Error("documents.onAdded: expected a function");
			listeners.push(fn);
		},
	};
}
