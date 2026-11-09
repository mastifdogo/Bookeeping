// Files modules hand to each other (ctx.files): a bank statement, a bill, a
// receipt or a list of transactions, labelled with its kind. A module says in
// its manifest which kinds it accepts ("files": {"accepts": [...]}). Nothing
// is posted to the books: the receiving module decides, and records the
// outcome (accepted, done, rejected) for the sender to see.

import { createHash } from "node:crypto";
import type { App } from "./app.ts";
import { queryRow, queryRows } from "./db.ts";
import { HttpError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";

export const FILE_KINDS = ["transaction", "receipt", "statement", "bill", "customer", "vendor"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export type FileStatus = "new" | "accepted" | "done" | "rejected";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FileSummary {
	id: number;
	sender: string;
	recipient: string;
	kind: FileKind;
	filename: string;
	content_type: string;
	size_bytes: number;
	sha256: string;
	meta: Record<string, unknown>;
	note: string;
	status: FileStatus;
	result: string;
	sent_by: string | null;
	created_at: Date;
	updated_at: Date;
}

export interface SendFile {
	/** The receiving module's id. */
	to: string;
	kind: FileKind;
	filename: string;
	/** The bytes: a Buffer, a Uint8Array, or base64 text. */
	data: Buffer | Uint8Array | string;
	contentType?: string;
	/** Small structured details for the receiver (≤ 16 KB as JSON), e.g. { account_code, period }. */
	meta?: Record<string, unknown>;
	/** A note for the receiver (≤ 2000 characters). */
	note?: string;
}

const SELECT = `
	SELECT f.id, f.sender, f.recipient, f.kind, f.filename, f.content_type, f.size_bytes, f.sha256, f.meta, f.note,
	       f.status, f.result, u.username AS sent_by, f.created_at, f.updated_at
	  FROM module_files f LEFT JOIN users u ON u.id = f.created_by`;

type Row = Omit<FileSummary, "id"> & { id: bigint };
const toSummary = (r: Row): FileSummary => ({ ...r, id: Number(r.id) });

const bad = (field: string, msg: string): never => {
	const v = new ValidationError();
	v.add(field, msg);
	throw v;
};

const toId = (id: unknown): bigint => {
	if (typeof id === "bigint" && id > 0n) return id;
	if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return BigInt(id);
	if (typeof id === "string" && /^[1-9]\d{0,17}$/.test(id)) return BigInt(id);
	throw new HttpError(404, "no such file", "not_found");
};

/** Running modules that accept a kind (all kinds when omitted), for "send to …" choices. */
export function fileTargets(app: App, kind?: FileKind) {
	return [...app.modules.modules.values()]
		.filter((m) => !m.error && (m.manifest.files?.accepts.length ?? 0) > 0 && (!kind || m.manifest.files!.accepts.includes(kind)))
		.map((m) => ({ id: m.manifest.id, name: m.manifest.name, accepts: [...m.manifest.files!.accepts] }));
}

/** What module `self` can do with files. */
export function filesFor(app: App, self: string, actorOf: (u: unknown) => number | null) {
	const mine = async (id: unknown, as: "either" | "recipient") => {
		const r = await queryRow<Row>(app.db, SELECT + ` WHERE f.id = $1`, [toId(id)]);
		if (!r || !(r.recipient === self || (as === "either" && r.sender === self))) throw new HttpError(404, "no such file", "not_found");
		return r;
	};

	return {
		/** Modules that accept `kind`: [{ id, name, accepts }]. */
		targets: (kind?: FileKind) => {
			if (kind !== undefined && !FILE_KINDS.includes(kind)) bad("kind", `must be one of ${FILE_KINDS.join(", ")}`);
			return fileTargets(app, kind);
		},

		/** Sends a file; the receiver's onReceive listeners run right after. Pass req.user to record who sent it. */
		async send(f: SendFile, user?: unknown): Promise<FileSummary> {
			const o = (f ?? {}) as unknown as Record<string, unknown>;
			if (typeof o.to !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(o.to)) bad("to", "must be a module id");
			if (!FILE_KINDS.includes(o.kind as FileKind)) bad("kind", `must be one of ${FILE_KINDS.join(", ")}`);
			if (typeof o.filename !== "string" || !/^[^\u0000-\u001f/\\]{1,255}$/.test(o.filename)) bad("filename", "must be a file name (no slashes), 1-255 characters");
			const contentType = o.contentType === undefined ? "application/octet-stream" : o.contentType;
			if (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) bad("contentType", "must be a media type such as text/csv");
			let data: Buffer;
			if (Buffer.isBuffer(o.data)) data = o.data;
			else if (o.data instanceof Uint8Array) data = Buffer.from(o.data);
			else if (typeof o.data === "string") data = Buffer.from(o.data, "base64");
			else data = bad("data", "must be a Buffer, Uint8Array or base64 text");
			if (data.length === 0) bad("data", "is empty");
			if (data.length > MAX_FILE_BYTES) bad("data", `must be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
			const meta = o.meta === undefined ? {} : o.meta;
			if (!meta || typeof meta !== "object" || Array.isArray(meta) || JSON.stringify(meta).length > 16384) bad("meta", "must be an object of at most 16 KB as JSON");
			const note = o.note === undefined ? "" : o.note;
			if (typeof note !== "string" || note.length > 2000) bad("note", "must be text of at most 2000 characters");
			const to = app.modules.modules.get(o.to as string);
			if (!to || to.error) throw new HttpError(409, `the module "${o.to}" isn't installed or isn't running`, "conflict");
			if (!(to.manifest.files?.accepts ?? []).includes(o.kind as FileKind)) {
				throw new HttpError(409, `${to.manifest.name} doesn't accept ${o.kind} files`, "conflict");
			}
			const row = await queryRow<{ id: bigint }>(
				app.db,
				`INSERT INTO module_files (sender, recipient, kind, filename, content_type, size_bytes, sha256, data, meta, note, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11) RETURNING id`,
				[self, o.to, o.kind, o.filename, contentType, data.length, createHash("sha256").update(data).digest("hex"), data, JSON.stringify(meta), note, actorOf(user)],
			);
			const summary = toSummary((await queryRow<Row>(app.db, SELECT + ` WHERE f.id = $1`, [row!.id]))!);
			for (const fn of to.fileListeners) {
				Promise.resolve()
					.then(() => fn({ ...summary }))
					.catch((err: Error) => log.error("module file listener failed", { module: to.manifest.id, file: summary.id, err: err.message }));
			}
			return summary;
		},

		/** Files sent to this module, newest first (without their bytes). */
		inbox: async (opts: { kind?: FileKind; status?: FileStatus; limit?: number } = {}) =>
			(
				await queryRows<Row>(
					app.db,
					SELECT + ` WHERE f.recipient = $1 AND ($2::text IS NULL OR f.kind = $2) AND ($3::text IS NULL OR f.status = $3) ORDER BY f.id DESC LIMIT $4`,
					[self, opts.kind ?? null, opts.status ?? null, Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500)],
				)
			).map(toSummary),

		/** Files this module sent, newest first, with the receiver's status and result. */
		outbox: async (opts: { kind?: FileKind; status?: FileStatus; limit?: number } = {}) =>
			(
				await queryRows<Row>(
					app.db,
					SELECT + ` WHERE f.sender = $1 AND ($2::text IS NULL OR f.kind = $2) AND ($3::text IS NULL OR f.status = $3) ORDER BY f.id DESC LIMIT $4`,
					[self, opts.kind ?? null, opts.status ?? null, Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500)],
				)
			).map(toSummary),

		/** One file with its bytes ({ …summary, data: Buffer }); for its sender or receiver. */
		async get(id: number | bigint | string): Promise<FileSummary & { data: Buffer }> {
			const r = await mine(id, "either");
			const d = await queryRow<{ data: Buffer }>(app.db, `SELECT data FROM module_files WHERE id = $1`, [r.id]);
			return { ...toSummary(r), data: d!.data };
		},

		/**
		 * The receiver records what happened: "accepted" (taken in, being
		 * worked on), "done" or "rejected", with an optional result note.
		 */
		async update(id: number | bigint | string, change: { status: FileStatus; result?: string }): Promise<FileSummary> {
			const r = await mine(id, "recipient");
			const status = change?.status;
			if (!["new", "accepted", "done", "rejected"].includes(status as string)) bad("status", "must be new, accepted, done or rejected");
			const result = change?.result ?? r.result;
			if (typeof result !== "string" || result.length > 2000) bad("result", "must be text of at most 2000 characters");
			await app.db.query(`UPDATE module_files SET status = $2, result = $3, updated_at = now() WHERE id = $1`, [r.id, status, result]);
			return toSummary((await queryRow<Row>(app.db, SELECT + ` WHERE f.id = $1`, [r.id]))!);
		},

		/** Deletes a file: the receiver any time, the sender while it's still "new" (withdrawing it). */
		async remove(id: number | bigint | string): Promise<void> {
			const r = await mine(id, "either");
			if (r.recipient !== self && r.status !== "new") throw new HttpError(409, "the receiver has already taken this file", "conflict");
			await app.db.query(`DELETE FROM module_files WHERE id = $1`, [r.id]);
		},
	};
}
