// Files modules keep (ctx.storage): PDFs, scans, attachments. They live on the
// data share next to the CSV files, per organization and module, not in the
// database, and every backup folder carries them under files/<module>/.
//
//   <CSV_DIR>/.modules/<module>/<path>                 the main books
//   <CSV_DIR>/.orgs/<database>/.modules/<module>/<path>  another organization
//
// Logged-in users fetch them at /api/v1/modules/<module>/storage/<path>.

import { randomBytes } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
import path from "node:path";
import type { App } from "./app.ts";
import { HttpError } from "./errors.ts";
import { filesDir } from "./orgs.ts";

export const MAX_STORED_FILE = 100 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,127}$/;

/** Where a module's files are, under an organization's files directory. */
export function moduleStorageDir(orgFilesDir: string, moduleId: string): string {
	return path.join(orgFilesDir, ".modules", moduleId);
}

const TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".heic": "image/heic",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".csv": "text/csv",
	".txt": "text/plain",
	".json": "application/json",
	".xml": "application/xml",
	".eml": "message/rfc822",
	".zip": "application/zip",
	".ofx": "application/x-ofx",
	".qfx": "application/x-ofx",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function contentTypeOf(p: string): string {
	return TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/** Types a browser may show inline from Ledger's origin (never HTML or SVG, which could run script). */
export const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv"]);

/** Checks a module's file path ("invoices/2026/INV-31.pdf"); returns its segments. */
export function checkStoragePath(p: unknown): string[] {
	if (typeof p !== "string" || p.length === 0 || p.length > 500) throw new HttpError(422, "storage path must be 1-500 characters", "validation_failed");
	const parts = p.split("/");
	if (parts.length > 8 || !parts.every((s) => SEGMENT.test(s) && s !== "." && s !== ".." && !s.endsWith(".tmp"))) {
		throw new HttpError(422, `storage path "${p}" must be folders and a file name of letters, digits, spaces and . _ - ( ), separated by /`, "validation_failed");
	}
	return parts;
}

export interface StoredFile {
	path: string;
	size: number;
	content_type: string;
	modified_at: Date;
	/** Where a logged-in user's browser can open it. */
	url: string;
}

const urlFor = (moduleId: string, p: string) => `/api/v1/modules/${moduleId}/storage/${p.split("/").map(encodeURIComponent).join("/")}`;

async function walk(dir: string, rel = ""): Promise<{ rel: string; full: string }[]> {
	const out: { rel: string; full: string }[] = [];
	for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (e.name.startsWith(".")) continue; // temporary files
		const full = path.join(dir, e.name);
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await walk(full, r)));
		else if (e.isFile()) out.push({ rel: r, full });
	}
	return out;
}

/** Every stored file under a module storage root (or any directory), for backups. */
export async function listTree(dir: string): Promise<{ rel: string; full: string }[]> {
	return walk(dir);
}

/** What module `id` can do with its files, in the organization the code runs in. */
export function storageFor(app: App, id: string) {
	const root = async () => moduleStorageDir(await filesDir(app), id);
	const resolve = async (p: unknown) => {
		const parts = checkStoragePath(p);
		return { rel: parts.join("/"), full: path.join(await root(), ...parts) };
	};
	const info = async (rel: string, full: string): Promise<StoredFile | null> => {
		const st = await fsp.lstat(full).catch(() => null);
		if (!st?.isFile()) return null;
		return { path: rel, size: st.size, content_type: contentTypeOf(rel), modified_at: st.mtime, url: urlFor(id, rel) };
	};
	return {
		/** Saves a file (a Buffer, Uint8Array or base64 text; at most 100 MB), replacing one at the same path. */
		async put(p: string, data: Buffer | Uint8Array | string): Promise<StoredFile> {
			const { rel, full } = await resolve(p);
			const bytes = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data) : typeof data === "string" ? Buffer.from(data, "base64") : null;
			if (!bytes) throw new HttpError(422, "storage.put: data must be a Buffer, Uint8Array or base64 text", "validation_failed");
			if (bytes.length > MAX_STORED_FILE) throw new HttpError(413, `storage.put: files are at most ${MAX_STORED_FILE / 1024 / 1024} MB`, "payload_too_large");
			await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o750 });
			// Written under a temporary name, then renamed: a reader never sees half a file.
			const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${randomBytes(4).toString("hex")}.tmp`);
			try {
				await fsp.writeFile(tmp, bytes, { mode: 0o640 });
				await fsp.rename(tmp, full);
			} catch (err) {
				await fsp.rm(tmp, { force: true });
				throw err;
			}
			return (await info(rel, full))!;
		},
		/** The file and its bytes; null if there is none. */
		async get(p: string): Promise<(StoredFile & { data: Buffer }) | null> {
			const { rel, full } = await resolve(p);
			const meta = await info(rel, full);
			if (!meta) return null;
			const fh = await fsp.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				return { ...meta, data: await fh.readFile() };
			} finally {
				await fh.close();
			}
		},
		/** The file's details without its bytes; null if there is none. */
		stat: async (p: string) => {
			const { rel, full } = await resolve(p);
			return info(rel, full);
		},
		/** Files under a folder ("" or omitted: all), sorted by path. */
		async list(prefix = ""): Promise<StoredFile[]> {
			const base = await root();
			const start = prefix ? path.join(base, ...checkStoragePath(prefix.replace(/\/+$/, ""))) : base;
			const relBase = prefix.replace(/\/+$/, "");
			const out: StoredFile[] = [];
			for (const f of await walk(start, relBase)) {
				const meta = await info(f.rel, f.full);
				if (meta) out.push(meta);
			}
			return out.sort((a, b) => a.path.localeCompare(b.path));
		},
		/** Deletes a file (empty folders above it go too); false if there was none. */
		async remove(p: string): Promise<boolean> {
			const { full } = await resolve(p);
			const st = await fsp.lstat(full).catch(() => null);
			if (!st?.isFile()) return false;
			await fsp.rm(full);
			const base = await root();
			for (let dir = path.dirname(full); dir.startsWith(base + path.sep); dir = path.dirname(dir)) {
				if ((await fsp.readdir(dir).catch(() => ["x"])).length > 0) break;
				await fsp.rmdir(dir).catch(() => {});
			}
			return true;
		},
		/** The address a logged-in user's browser opens the file at (for links and <iframe>/<img> in the module's page). */
		url: (p: string) => urlFor(id, checkStoragePath(p).join("/")),
	};
}

/** Reads a stored file for /api/v1/modules/<id>/storage/<path>, in the request's organization. */
export async function openStored(app: App, moduleId: string, rawParts: string[]): Promise<{ full: string; size: number; type: string; name: string } | null> {
	let parts: string[];
	try {
		parts = checkStoragePath(rawParts.map((p) => decodeURIComponent(p)).join("/"));
	} catch {
		return null;
	}
	const full = path.join(moduleStorageDir(await filesDir(app), moduleId), ...parts);
	const st = await fsp.lstat(full).catch(() => null);
	if (!st?.isFile()) return null;
	return { full, size: st.size, type: contentTypeOf(full), name: parts.at(-1)! };
}
