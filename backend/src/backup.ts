// Database backups to a TrueNAS share (a directory mounted into the
// container), to Google Drive, or both, on a schedule set in the app.
//
//   ledger backup run            back up now (ledger-backup.service; the updater
//                                runs it before installing a release)
//   ledger backup run --if-due   only if the schedule says so (ledger-backup.timer)
//
// The app runs the same code for "Back up now". Settings and the outcome of
// the last run live in BACKUP_STATE_DIR (default /var/lib/ledger/backup, owned
// by the ledger user, mode 0700), outside the database, so the Google
// credentials are not inside the dumps.

import { spawn } from "node:child_process";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { closeLedgerNotice, postLedgerNotice } from "./dashboard.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { dueSlot, isTimeZone, nextScheduledTime, readSmallFile, writeFileAtomic } from "./update.ts";

export const CONFIG_FILE = "config.json";
export const STATUS_FILE = "status.json";

export function backupStateDir(): string {
	return process.env.BACKUP_STATE_DIR || "/var/lib/ledger/backup";
}

export interface BackupSchedule {
	enabled: boolean;
	/** 0 = Sunday ... 6 = Saturday. */
	days: number[];
	/** "HH:MM", 24-hour. */
	time: string;
	timezone: string;
}

export interface TrueNasTarget {
	enabled: boolean;
	/** The share's directory inside the container. */
	path: string;
	/** Dumps older than this many days are deleted. */
	keep_days: number;
}

export interface GoogleTarget {
	enabled: boolean;
	client_id: string;
	client_secret: string;
	refresh_token: string;
	/** The "Ledger backups" folder Ledger created in the user's Drive. */
	folder_id: string;
	/** The connected account's email address. */
	account: string;
	/** How many dumps to keep in the folder. */
	keep_count: number;
}

export interface BackupConfig {
	schedule: BackupSchedule;
	truenas: TrueNasTarget;
	google: GoogleTarget;
}

export type BackupState = "idle" | "running" | "ok" | "warning" | "error";

export interface TargetResult {
	target: "truenas" | "google";
	ok: boolean;
	message: string;
}

export interface BackupStatus {
	state: BackupState;
	trigger: "manual" | "scheduled" | null;
	started_at: string | null;
	finished_at: string | null;
	message: string;
	file: string | null;
	size_bytes: number | null;
	results: TargetResult[];
	last_scheduled_for: string | null;
	/** When each destination last received a backup. */
	last_ok: { truenas: string | null; google: string | null };
}

const EMPTY_STATUS: BackupStatus = {
	state: "idle",
	trigger: null,
	started_at: null,
	finished_at: null,
	message: "",
	file: null,
	size_bytes: null,
	results: [],
	last_scheduled_for: null,
	last_ok: { truenas: null, google: null },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DUMP_RE = /^ledger-\d{8}T\d{6}Z\.dump$/;
/** The share must be under one of these (the systemd units let Ledger write only there). */
function allowedRoots(): string[] {
	return process.env.BACKUP_SHARE_ROOTS?.split(":").filter((r) => r.startsWith("/")) ?? ["/app/csv_data", "/mnt"];
}

function localTimeZone(): string {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return tz && isTimeZone(tz) ? tz : "UTC";
}

/** Before anything is saved: what the old shell script did (nightly, BACKUP_DIR from ledger.env). */
export function defaultConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
	const keep = Number.parseInt(env.BACKUP_KEEP_DAYS ?? "", 10);
	return {
		schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "02:30", timezone: localTimeZone() },
		truenas: { enabled: true, path: env.BACKUP_DIR || "/app/csv_data/backups", keep_days: Number.isInteger(keep) && keep >= 1 && keep <= 3650 ? keep : 30 },
		google: { enabled: false, client_id: "", client_secret: "", refresh_token: "", folder_id: "", account: "", keep_count: 30 },
	};
}

export async function readConfig(dir: string): Promise<BackupConfig> {
	const def = defaultConfig();
	const text = await readSmallFile(path.join(dir, CONFIG_FILE));
	if (text === null) return def;
	try {
		const v = JSON.parse(text) as Partial<BackupConfig>;
		return { schedule: { ...def.schedule, ...v.schedule }, truenas: { ...def.truenas, ...v.truenas }, google: { ...def.google, ...v.google } };
	} catch {
		return def;
	}
}

export async function writeConfig(dir: string, c: BackupConfig): Promise<void> {
	await writeFileAtomic(path.join(dir, CONFIG_FILE), JSON.stringify(c, null, 2) + "\n", 0o600);
}

export async function readBackupStatus(dir: string): Promise<BackupStatus> {
	const text = await readSmallFile(path.join(dir, STATUS_FILE));
	if (text === null) return { ...EMPTY_STATUS };
	try {
		const v = JSON.parse(text) as Partial<BackupStatus>;
		return { ...EMPTY_STATUS, ...v, last_ok: { ...EMPTY_STATUS.last_ok, ...v.last_ok } };
	} catch {
		return { ...EMPTY_STATUS };
	}
}

async function writeStatus(dir: string, s: BackupStatus): Promise<void> {
	await writeFileAtomic(path.join(dir, STATUS_FILE), JSON.stringify(s, null, 2) + "\n", 0o600);
}

/** Whether backups are set up on this server (install.sh creates the directory). */
export async function backupsInstalled(dir: string): Promise<boolean> {
	return (await fsp.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

/** A share path Ledger may write to; throws ValidationError otherwise. */
export function checkSharePath(p: string, err: ValidationError, field = "truenas.path"): string {
	const norm = path.posix.normalize(p);
	if (!p.startsWith("/") || norm !== p.replace(/\/+$/, "") || p.includes("\0")) err.add(field, "must be an absolute path such as /app/csv_data/backups");
	else if (!allowedRoots().some((r) => norm.startsWith(r + "/"))) err.add(field, `must be inside ${allowedRoots().join(" or ")}`);
	return norm;
}

// ---------------------------------------------------------------------------
// Settings as the app shows and saves them
// ---------------------------------------------------------------------------

/** Settings without secrets, for the browser. */
export function publicConfig(c: BackupConfig) {
	return {
		schedule: c.schedule,
		truenas: c.truenas,
		google: {
			enabled: c.google.enabled,
			client_id: c.google.client_id,
			has_client_secret: c.google.client_secret !== "",
			connected: c.google.refresh_token !== "",
			account: c.google.account,
			keep_count: c.google.keep_count,
		},
	};
}

/**
 * Applies a change from the settings page. client_secret: omitted or null
 * keeps the saved one. Changing the client ID disconnects the account.
 */
export function applyConfigChange(c: BackupConfig, v: unknown): BackupConfig {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	const obj = (k: string, keys: string[]) => {
		const x = o[k];
		if (x === undefined || x === null) return null;
		if (typeof x !== "object" || Array.isArray(x)) {
			err.add(k, "must be an object");
			return null;
		}
		for (const key of Object.keys(x)) if (!keys.includes(key)) err.add(`${k}.${key}`, "unknown field");
		return x as Record<string, unknown>;
	};
	for (const k of Object.keys(o)) if (!["schedule", "truenas", "google"].includes(k)) err.add(k, "unknown field");
	const next: BackupConfig = structuredClone(c);

	const s = obj("schedule", ["enabled", "days", "time", "timezone"]);
	if (s) {
		if (typeof s.enabled !== "boolean") err.add("schedule.enabled", "must be true or false");
		const days = s.days;
		if (!Array.isArray(days) || days.length === 0 || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(days).size !== days.length) {
			err.add("schedule.days", "must list one or more days of the week, 0 (Sunday) to 6 (Saturday)");
		}
		if (typeof s.time !== "string" || !TIME_RE.test(s.time)) err.add("schedule.time", 'must be a 24-hour time such as "02:30"');
		if (typeof s.timezone !== "string" || !isTimeZone(s.timezone)) err.add("schedule.timezone", "must be a time zone such as America/Toronto");
		next.schedule = { enabled: s.enabled as boolean, days: [...((days as number[]) ?? [])].sort((a, b) => a - b), time: s.time as string, timezone: s.timezone as string };
	}

	const t = obj("truenas", ["enabled", "path", "keep_days"]);
	if (t) {
		if (typeof t.enabled !== "boolean") err.add("truenas.enabled", "must be true or false");
		const p = typeof t.path === "string" ? checkSharePath(t.path, err) : (err.add("truenas.path", "is required"), "");
		if (!Number.isInteger(t.keep_days) || (t.keep_days as number) < 1 || (t.keep_days as number) > 3650) err.add("truenas.keep_days", "must be 1 to 3650 days");
		next.truenas = { enabled: t.enabled as boolean, path: p, keep_days: t.keep_days as number };
	}

	const g = obj("google", ["enabled", "client_id", "client_secret", "keep_count"]);
	if (g) {
		if (typeof g.enabled !== "boolean") err.add("google.enabled", "must be true or false");
		const id = typeof g.client_id === "string" ? g.client_id.trim() : "";
		if (id !== "" && !/^[0-9A-Za-z._-]{3,200}\.apps\.googleusercontent\.com$/.test(id)) err.add("google.client_id", "must be an OAuth client ID ending in .apps.googleusercontent.com");
		if (g.client_secret !== undefined && g.client_secret !== null && (typeof g.client_secret !== "string" || g.client_secret.length > 200 || /\s/.test(g.client_secret))) {
			err.add("google.client_secret", "is not valid");
		}
		if (!Number.isInteger(g.keep_count) || (g.keep_count as number) < 1 || (g.keep_count as number) > 1000) err.add("google.keep_count", "must be 1 to 1000");
		if (g.enabled === true && id === "") err.add("google.client_id", "is required to back up to Google Drive");
		const changedClient = id !== c.google.client_id;
		next.google = {
			...c.google,
			enabled: g.enabled as boolean,
			client_id: id,
			client_secret: typeof g.client_secret === "string" ? g.client_secret : changedClient ? "" : c.google.client_secret,
			keep_count: g.keep_count as number,
		};
		if (changedClient) Object.assign(next.google, { refresh_token: "", folder_id: "", account: "" });
	}
	err.throwIfAny();
	return next;
}

// ---------------------------------------------------------------------------
// TrueNAS (a mounted directory)
// ---------------------------------------------------------------------------

/** Checks the directory exists and is writable; reports free space. */
export async function testShare(p: string): Promise<{ ok: boolean; message: string; free_bytes: number | null }> {
	const err = new ValidationError();
	const dir = checkSharePath(p, err, "path");
	err.throwIfAny();
	const parent = path.dirname(dir);
	const info = await fsp.stat(dir).catch(() => null);
	if (!info) {
		const pinfo = await fsp.stat(parent).catch(() => null);
		if (!pinfo) return { ok: false, message: `${parent} does not exist. Is the TrueNAS share mounted into the container?`, free_bytes: null };
	} else if (!info.isDirectory()) {
		return { ok: false, message: `${dir} is not a directory`, free_bytes: null };
	}
	try {
		await fsp.mkdir(dir, { recursive: true });
		const probe = path.join(dir, `.ledger-write-test-${process.pid}`);
		await fsp.writeFile(probe, "ok");
		await fsp.rm(probe);
	} catch (e) {
		return { ok: false, message: `Can't write to ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Check the share's permissions for the container's ledger user.`, free_bytes: null };
	}
	const fs = await fsp.statfs(dir).catch(() => null);
	const free = fs ? fs.bavail * fs.bsize : null;
	return { ok: true, message: `${dir} is writable${free !== null ? `; ${(free / 1024 ** 3).toFixed(1)} GiB free` : ""}.`, free_bytes: free };
}

/** The newest dumps on the share, for the settings page. */
export async function listShareDumps(dir: string, limit = 10): Promise<{ name: string; size_bytes: number; modified_at: string }[]> {
	const names = await fsp.readdir(dir).catch(() => [] as string[]);
	const out = [];
	for (const n of names.filter((x) => DUMP_RE.test(x))) {
		const st = await fsp.stat(path.join(dir, n)).catch(() => null);
		if (st?.isFile()) out.push({ name: n, size_bytes: st.size, modified_at: st.mtime.toISOString() });
	}
	return out.sort((a, b) => b.name.localeCompare(a.name)).slice(0, limit);
}

async function copyToShare(file: string, t: TrueNasTarget, now: number): Promise<string> {
	await fsp.mkdir(t.path, { recursive: true });
	const name = path.basename(file);
	const tmp = path.join(t.path, `.${name}.tmp`);
	try {
		await fsp.copyFile(file, tmp);
		await fsp.rename(tmp, path.join(t.path, name));
	} catch (e) {
		await fsp.rm(tmp, { force: true });
		throw e;
	}
	let removed = 0;
	for (const n of await fsp.readdir(t.path)) {
		if (!DUMP_RE.test(n) || n === name) continue;
		const st = await fsp.stat(path.join(t.path, n)).catch(() => null);
		if (st && now - st.mtimeMs > t.keep_days * 86_400_000) {
			await fsp.rm(path.join(t.path, n), { force: true });
			removed++;
		}
	}
	return `Saved ${name} to ${t.path}${removed ? `; removed ${removed} older than ${t.keep_days} days` : ""}.`;
}

// ---------------------------------------------------------------------------
// Google Drive (OAuth device flow, drive.file scope)
// ---------------------------------------------------------------------------

export interface GoogleEndpoints {
	/** https://oauth2.googleapis.com */
	oauth: string;
	/** https://www.googleapis.com */
	api: string;
}

export function googleEndpoints(): GoogleEndpoints {
	return {
		oauth: process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com",
		api: process.env.GOOGLE_API_BASE || "https://www.googleapis.com",
	};
}

/** Only files Ledger creates are visible to it: it can't read anything else in the Drive. */
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Ledger backups";

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form),
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

function googleError(body: Record<string, unknown>, fallback: string): string {
	const e = body.error;
	if (typeof e === "string") return `${e}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`;
	if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
	return fallback;
}

export interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_url: string;
	expires_at: number;
	interval: number;
}

/** Step 1 of connecting: Google gives a code for the user to enter at google.com/device. */
export async function startDeviceFlow(g: GoogleTarget, ep: GoogleEndpoints): Promise<DeviceCode> {
	if (!g.client_id || !g.client_secret) throw new ConflictError("save the OAuth client ID and secret first");
	const r = await postForm(`${ep.oauth}/device/code`, { client_id: g.client_id, scope: SCOPE });
	if (r.status !== 200 || typeof r.body.device_code !== "string") {
		throw new ConflictError(`Google refused: ${googleError(r.body, `HTTP ${r.status}`)}. The OAuth client must be of type "TVs and Limited Input devices".`);
	}
	return {
		device_code: r.body.device_code,
		user_code: String(r.body.user_code),
		verification_url: String(r.body.verification_url ?? r.body.verification_uri ?? "https://www.google.com/device"),
		expires_at: Date.now() + Number(r.body.expires_in ?? 1800) * 1000,
		interval: Math.max(Number(r.body.interval ?? 5), 1),
	};
}

/**
 * Step 2: asks whether the user has approved yet. On approval, creates the
 * backup folder and returns the completed settings.
 */
export async function pollDeviceFlow(
	g: GoogleTarget,
	code: DeviceCode,
	ep: GoogleEndpoints,
): Promise<{ state: "pending" | "denied" | "expired" } | { state: "connected"; google: GoogleTarget }> {
	if (Date.now() > code.expires_at) return { state: "expired" };
	const r = await postForm(`${ep.oauth}/token`, {
		client_id: g.client_id,
		client_secret: g.client_secret,
		device_code: code.device_code,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	if (r.status !== 200) {
		const e = r.body.error;
		if (e === "authorization_pending" || e === "slow_down") return { state: "pending" };
		if (e === "access_denied") return { state: "denied" };
		if (e === "expired_token") return { state: "expired" };
		throw new ConflictError(`Google refused: ${googleError(r.body, `HTTP ${r.status}`)}`);
	}
	const access = String(r.body.access_token);
	const refresh = typeof r.body.refresh_token === "string" ? r.body.refresh_token : "";
	if (!refresh) throw new ConflictError("Google did not return a refresh token; remove Ledger's access at myaccount.google.com/permissions and connect again");
	const folder = await driveJson(ep, access, "POST", "/drive/v3/files?fields=id", { name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" });
	const about = await driveJson(ep, access, "GET", "/drive/v3/about?fields=user(emailAddress)").catch(() => ({}));
	const account = String((about as { user?: { emailAddress?: string } }).user?.emailAddress ?? "");
	return { state: "connected", google: { ...g, refresh_token: refresh, folder_id: String((folder as { id: string }).id), account } };
}

async function accessToken(g: GoogleTarget, ep: GoogleEndpoints): Promise<string> {
	const r = await postForm(`${ep.oauth}/token`, {
		client_id: g.client_id,
		client_secret: g.client_secret,
		refresh_token: g.refresh_token,
		grant_type: "refresh_token",
	});
	if (r.status !== 200 || typeof r.body.access_token !== "string") {
		const why = googleError(r.body, `HTTP ${r.status}`);
		throw new Error(
			r.body.error === "invalid_grant"
				? `Google access was revoked or expired (${why}); connect again under Settings → Backups. If this happens weekly, publish the OAuth app (see the setup steps).`
				: `couldn't sign in to Google: ${why}`,
		);
	}
	return r.body.access_token;
}

async function driveJson(ep: GoogleEndpoints, token: string, method: string, p: string, body?: unknown): Promise<unknown> {
	const res = await fetch(ep.api + p, {
		method,
		headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	if (res.status === 204) return {};
	const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(`Google Drive answered ${res.status}: ${googleError(j, res.statusText)}`);
	return j;
}

/** Revokes Ledger's access (best effort) when disconnecting. */
export async function revokeGoogle(g: GoogleTarget, ep: GoogleEndpoints): Promise<void> {
	if (!g.refresh_token) return;
	await postForm(`${ep.oauth}/revoke`, { token: g.refresh_token }).catch(() => undefined);
}

async function uploadToDrive(file: string, g: GoogleTarget, ep: GoogleEndpoints): Promise<string> {
	if (!g.refresh_token || !g.folder_id) throw new Error("Google Drive is not connected; connect it under Settings → Backups");
	const token = await accessToken(g, ep);
	const name = path.basename(file);
	const size = (await fsp.stat(file)).size;
	// Resumable upload: one session, the file in a single PUT.
	const start = await fetch(`${ep.api}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": "application/octet-stream",
			"X-Upload-Content-Length": String(size),
		},
		body: JSON.stringify({ name, parents: [g.folder_id], description: "Ledger database backup (pg_dump custom format)" }),
		signal: AbortSignal.timeout(30_000),
	});
	const session = start.headers.get("location");
	if (!start.ok || !session) {
		const j = (await start.json().catch(() => ({}))) as Record<string, unknown>;
		throw new Error(
			start.status === 404 ? `the "${FOLDER_NAME}" folder is gone from Google Drive; connect again to recreate it` : `Google Drive answered ${start.status}: ${googleError(j, start.statusText)}`,
		);
	}
	const put = await fetch(session, {
		method: "PUT",
		headers: { Authorization: `Bearer ${token}`, "Content-Length": String(size), "Content-Type": "application/octet-stream" },
		body: Readable.toWeb(createReadStream(file)) as ReadableStream,
		duplex: "half",
		signal: AbortSignal.timeout(30 * 60_000),
	} as RequestInit);
	if (!put.ok) {
		const j = (await put.json().catch(() => ({}))) as Record<string, unknown>;
		throw new Error(`upload failed (${put.status}): ${googleError(j, put.statusText)}`);
	}
	// Keep the newest keep_count dumps.
	const q = encodeURIComponent(`'${g.folder_id}' in parents and trashed = false`);
	const list = (await driveJson(ep, token, "GET", `/drive/v3/files?q=${q}&orderBy=name desc&pageSize=1000&fields=files(id,name)`)) as { files?: { id: string; name: string }[] };
	const old = (list.files ?? []).filter((f) => DUMP_RE.test(f.name)).slice(g.keep_count);
	for (const f of old) await driveJson(ep, token, "DELETE", `/drive/v3/files/${encodeURIComponent(f.id)}`);
	return `Uploaded ${name} to Google Drive (${g.account || "connected account"}, folder "${FOLDER_NAME}")${old.length ? `; removed ${old.length} older` : ""}.`;
}

// ---------------------------------------------------------------------------
// Running a backup
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		p.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
		p.on("error", reject);
		p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().split("\n").slice(-2).join(" / ")}`))));
	});
}

export interface BackupOptions {
	dir: string;
	databaseUrl: string;
	trigger: "manual" | "scheduled";
	now?: () => number;
	google?: GoogleEndpoints;
	/** Writes the dump (tests replace pg_dump). */
	dump?: (file: string) => Promise<void>;
}

export interface BackupOutcome {
	ran: boolean;
	ok: boolean;
	status: BackupStatus;
}

const LOCK_KEY = 0x1ed6e7; // pg_try_advisory_lock key: one backup at a time

/**
 * Dumps the database and sends it to each enabled destination. Never
 * throws for a failed backup: the outcome is in the status file, and ok is
 * true when at least one destination got the dump.
 */
export async function runBackup(o: BackupOptions): Promise<BackupOutcome> {
	const now = o.now ?? Date.now;
	const config = await readConfig(o.dir);
	const prev = await readBackupStatus(o.dir);
	let slot: number | null = null;
	if (o.trigger === "scheduled") {
		slot = dueSlot(config.schedule, now(), prev.last_scheduled_for);
		if (slot === null) return { ran: false, ok: true, status: prev };
	}

	const client = new pg.Client({ connectionString: o.databaseUrl, connectionTimeoutMillis: 10_000 });
	await client.connect();
	try {
		const locked = (await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])).rows[0]!.ok;
		if (!locked) throw new ConflictError("a backup is already running");

		const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
		const name = `ledger-${stamp}.dump`;
		const status: BackupStatus = {
			...prev,
			state: "running",
			trigger: o.trigger,
			started_at: new Date(now()).toISOString(),
			finished_at: null,
			message: "Backing up…",
			file: name,
			size_bytes: null,
			results: [],
			last_scheduled_for: slot !== null ? new Date(slot).toISOString() : prev.last_scheduled_for,
		};
		await writeStatus(o.dir, status);

		const targets = [config.truenas.enabled && "truenas", config.google.enabled && "google"].filter(Boolean) as ("truenas" | "google")[];
		const workDir = path.join(o.dir, "tmp");
		const file = path.join(workDir, name);
		try {
			if (targets.length === 0) throw new Error("no backup destination is turned on; choose TrueNAS or Google Drive under Settings → Backups");
			await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
			await (o.dump ?? ((f) => run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", `--file=${f}`, o.databaseUrl])))(file);
			if (!o.dump) await run("pg_restore", ["--list", file]); // the archive must be readable
			status.size_bytes = (await fsp.stat(file)).size;
			for (const t of targets) {
				try {
					const message = t === "truenas" ? await copyToShare(file, config.truenas, now()) : await uploadToDrive(file, config.google, o.google ?? googleEndpoints());
					status.results.push({ target: t, ok: true, message });
					status.last_ok[t] = new Date(now()).toISOString();
				} catch (e) {
					status.results.push({ target: t, ok: false, message: (e as Error).message });
				}
			}
			const okCount = status.results.filter((r) => r.ok).length;
			status.state = okCount === targets.length ? "ok" : okCount > 0 ? "warning" : "error";
			const label = (t: string) => (t === "truenas" ? "TrueNAS" : "Google Drive");
			status.message =
				status.state === "ok"
					? `Backed up to ${status.results.map((r) => label(r.target)).join(" and ")}.`
					: status.results
							.filter((r) => !r.ok)
							.map((r) => `${label(r.target)}: ${r.message}`)
							.join(" ");
		} catch (e) {
			status.state = "error";
			status.message = (e as Error).message;
		} finally {
			await fsp.rm(file, { force: true });
		}
		status.finished_at = new Date(now()).toISOString();
		await writeStatus(o.dir, status);
		log[status.state === "ok" ? "info" : "error"]("backup", { state: status.state, message: status.message, size_bytes: status.size_bytes });

		// Tell the dashboard about problems; a success clears the old warning.
		try {
			if (status.state === "ok") await closeLedgerNotice(client, "backup");
			else {
				await postLedgerNotice(client, {
					key: "backup",
					title: status.state === "warning" ? "Backup partly failed" : "Backup failed",
					body: status.message,
					level: status.state === "warning" ? "warning" : "danger",
					link: "/settings/backups",
				});
			}
		} catch (e) {
			log.warn("could not post the backup result to the dashboard", { err: (e as Error).message });
		}
		return { ran: true, ok: status.state !== "error", status };
	} finally {
		await client.end().catch(() => undefined);
	}
}

/** Schedule info for the settings page. */
export function nextBackupTime(c: BackupConfig, now = Date.now()): string | null {
	const t = nextScheduledTime(c.schedule, now);
	return t === null ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// `ledger backup run`
// ---------------------------------------------------------------------------

export const BACKUP_USAGE = `usage:
  ledger backup run            back up now to the destinations set in the app
  ledger backup run --if-due   only when the schedule says so (ledger-backup.timer)`;

export async function runBackupCommand(args: string[]): Promise<void> {
	const ifDue = args.length === 2 && args[1] === "--if-due";
	if (args[0] !== "run" || (args.length !== 1 && !ifDue)) throw new Error(BACKUP_USAGE);
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is not set (run as ledger-backup.service, which loads /etc/ledger/ledger.env)");
	const dir = backupStateDir();
	if (!(await backupsInstalled(dir))) throw new Error(`${dir} does not exist; run deploy/install.sh from a current release`);
	const out = await runBackup({ dir, databaseUrl, trigger: ifDue ? "scheduled" : "manual" });
	if (!out.ran) return;
	process.stdout.write(`${out.status.state}: ${out.status.message}\n`);
	for (const r of out.status.results) process.stdout.write(`  ${r.target}: ${r.ok ? "ok" : "FAILED"}: ${r.message}\n`);
	if (!out.ok) process.exitCode = 1;
}
