// Backgrounds from Wallhaven (wallhaven.cc). The server searches Wallhaven's
// API for the person (safe-for-work pictures only) and, when they choose one,
// downloads it once and serves it itself: the browser doesn't load the
// picture from Wallhaven on every page, and it works where only the server
// has internet. LEDGER_WALLHAVEN_URL overrides the API's address (tests);
// LEDGER_WALLHAVEN_API_KEY, if set, is sent with searches.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "./app.ts";
import { queryRow } from "./db.ts";
import { HttpError, NotFoundError, ValidationError } from "./errors.ts";

const api = () => (process.env.LEDGER_WALLHAVEN_URL || "https://wallhaven.cc").replace(/\/+$/, "");
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export interface Wallpaper {
	id: string;
	/** A small preview, loaded by the browser straight from Wallhaven. */
	thumb: string;
	resolution: string;
	/** The picture's page on Wallhaven. */
	url: string;
}

export interface Background {
	id: string;
	resolution: string;
	url: string;
	/** How much of the page colour is laid over the picture, 0-95 (percent). */
	dim: number;
	/** Changes when the picture does, so browsers fetch the new one. */
	version: number;
}

/** A picture's address must be Wallhaven's own (or the test server's). */
function ownUrl(u: unknown): string | null {
	if (typeof u !== "string") return null;
	try {
		const url = new URL(u);
		const base = new URL(api());
		const ok = base.hostname === "wallhaven.cc" ? url.protocol === "https:" && /(^|\.)wallhaven\.cc$/.test(url.hostname) : url.host === base.host;
		return ok ? url.toString() : null;
	} catch {
		return null;
	}
}

export async function searchWallhaven(q: string, page: number, sorting: string): Promise<{ data: Wallpaper[]; page: number; last_page: number }> {
	const v = new ValidationError();
	if (q.length > 200) v.add("q", "must be at most 200 characters");
	if (!Number.isSafeInteger(page) || page < 1 || page > 500) v.add("page", "must be a page number");
	if (!["toplist", "relevance", "date_added", "views", "favorites", "random"].includes(sorting)) v.add("sorting", "is not a way to sort");
	v.throwIfAny();
	const u = new URL(api() + "/api/v1/search");
	if (q.trim()) u.searchParams.set("q", q.trim());
	u.searchParams.set("categories", "100"); // general: landscapes, patterns, photos
	u.searchParams.set("purity", "100"); // safe for work only
	u.searchParams.set("atleast", "1920x1080");
	u.searchParams.set("ratios", "16x9,16x10,21x9");
	u.searchParams.set("sorting", q.trim() && sorting === "toplist" ? "relevance" : sorting);
	u.searchParams.set("page", String(page));
	const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "ledger" };
	if (process.env.LEDGER_WALLHAVEN_API_KEY) headers["X-API-Key"] = process.env.LEDGER_WALLHAVEN_API_KEY;
	let res: Response;
	try {
		res = await fetch(u, { headers, signal: AbortSignal.timeout(15_000) });
	} catch (err) {
		throw new HttpError(502, `couldn't reach Wallhaven from the server (${(err as Error).message})`, "internal_error");
	}
	if (res.status === 429) throw new HttpError(429, "Wallhaven is asking to slow down; try again in a minute", "too_many_requests");
	if (!res.ok) throw new HttpError(502, `Wallhaven answered ${res.status}`, "internal_error");
	const body = (await res.json()) as { data?: unknown[]; meta?: { current_page?: number; last_page?: number } };
	const data: Wallpaper[] = [];
	for (const w of Array.isArray(body.data) ? body.data : []) {
		const o = w as { id?: unknown; thumbs?: { small?: unknown; large?: unknown }; resolution?: unknown; url?: unknown; purity?: unknown };
		const thumb = ownUrl(o.thumbs?.large ?? o.thumbs?.small);
		if (typeof o.id !== "string" || !/^[a-z0-9]{1,16}$/i.test(o.id) || !thumb || o.purity !== "sfw") continue;
		data.push({ id: o.id, thumb, resolution: typeof o.resolution === "string" ? o.resolution.slice(0, 20) : "", url: ownUrl(o.url) ?? "" });
	}
	return { data, page: Number(body.meta?.current_page) || page, last_page: Number(body.meta?.last_page) || page };
}

const dir = (app: App) => path.join(app.csvDir, ".backgrounds");

async function stored(app: App, userId: number): Promise<{ file: string; type: string } | null> {
	for (const [type, ext] of Object.entries(TYPES)) {
		const file = path.join(dir(app), `${userId}.${ext}`);
		if (await stat(file).then(() => true, () => false)) return { file, type };
	}
	return null;
}

export async function getBackground(app: App, userId: number): Promise<Background | null> {
	const r = await queryRow<{ background: Background | null }>(app.main, `SELECT background FROM user_settings WHERE user_id = $1`, [userId]);
	return r?.background ?? null;
}

async function save(app: App, userId: number, bg: Background | null): Promise<void> {
	await app.main.query(
		`INSERT INTO user_settings (user_id, background) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET background = EXCLUDED.background, updated_at = now()`,
		[userId, bg === null ? null : JSON.stringify(bg)],
	);
}

const dimOf = (d: unknown, fallback: number) => (d === undefined ? fallback : typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 95 ? d : null);

/** Chooses a Wallhaven picture as the user's background: looks it up, downloads it and keeps it on the server. */
export async function chooseBackground(app: App, userId: number, input: { id: string; dim?: number }): Promise<Background> {
	const v = new ValidationError();
	if (typeof input.id !== "string" || !/^[a-z0-9]{1,16}$/i.test(input.id)) v.add("id", "is not a Wallhaven picture");
	const dim = dimOf(input.dim, 70);
	if (dim === null) v.add("dim", "must be a whole number from 0 to 95");
	v.throwIfAny();
	let info: { data?: { path?: unknown; resolution?: unknown; url?: unknown; purity?: unknown; file_size?: unknown } };
	try {
		const res = await fetch(`${api()}/api/v1/w/${input.id}`, { headers: { Accept: "application/json", "User-Agent": "ledger" }, signal: AbortSignal.timeout(15_000) });
		if (res.status === 404) throw new NotFoundError();
		if (!res.ok) throw new HttpError(502, `Wallhaven answered ${res.status}`, "internal_error");
		info = (await res.json()) as typeof info;
	} catch (err) {
		if (err instanceof HttpError || err instanceof NotFoundError) throw err;
		throw new HttpError(502, `couldn't reach Wallhaven from the server (${(err as Error).message})`, "internal_error");
	}
	const src = ownUrl(info.data?.path);
	if (!src || info.data?.purity !== "sfw") {
		v.add("id", "that picture can't be used");
		v.throwIfAny();
	}
	const res = await fetch(src!, { headers: { "User-Agent": "ledger" }, signal: AbortSignal.timeout(60_000) }).catch((err: Error) => {
		throw new HttpError(502, `couldn't download the picture (${err.message})`, "internal_error");
	});
	const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
	if (!res.ok || !TYPES[type]) throw new HttpError(502, `the picture couldn't be downloaded (${res.status} ${type})`, "internal_error");
	const data = Buffer.from(await res.arrayBuffer());
	if (data.length === 0 || data.length > MAX_BYTES) throw new HttpError(413, "that picture is larger than 20 MB", "payload_too_large");
	await mkdir(dir(app), { recursive: true, mode: 0o750 });
	for (const ext of Object.values(TYPES)) await rm(path.join(dir(app), `${userId}.${ext}`), { force: true });
	await writeFile(path.join(dir(app), `${userId}.${TYPES[type]}`), data, { mode: 0o640 });
	const bg: Background = { id: input.id, resolution: typeof info.data?.resolution === "string" ? info.data.resolution.slice(0, 20) : "", url: ownUrl(info.data?.url) ?? "", dim: dim!, version: Date.now() };
	await save(app, userId, bg);
	return bg;
}

/** Changes how much the page colour covers the picture. */
export async function dimBackground(app: App, userId: number, dim: unknown): Promise<Background> {
	const cur = await getBackground(app, userId);
	if (!cur) throw new NotFoundError();
	const d = dimOf(dim, cur.dim);
	if (d === null) {
		const v = new ValidationError();
		v.add("dim", "must be a whole number from 0 to 95");
		v.throwIfAny();
	}
	const bg = { ...cur, dim: d! };
	await save(app, userId, bg);
	return bg;
}

export async function removeBackground(app: App, userId: number): Promise<void> {
	await save(app, userId, null);
	for (const ext of Object.values(TYPES)) await rm(path.join(dir(app), `${userId}.${ext}`), { force: true });
}

/** The user's picture as kept on the server. */
export async function backgroundImage(app: App, userId: number): Promise<{ data: Buffer; type: string }> {
	const f = await stored(app, userId);
	if (!f) throw new NotFoundError();
	return { data: await readFile(f.file), type: f.type };
}
