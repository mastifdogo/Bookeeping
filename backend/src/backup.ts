// Database backups to a network share (SMB/CIFS: TrueNAS, Synology, Windows,
// Samba, ... reached with smbclient, or any folder mounted into the
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
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { getTypeParser, withDatabase } from "./db.ts";
import { csvRecord } from "./csv.ts";
import { csvText, writeGeneralLedger } from "./files.ts";
import { modulesDir, scanInstalled } from "./modules.ts";
import { listTree } from "./module-storage.ts";
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

export interface ShareTarget {
	enabled: boolean;
	/** "smb": Ledger connects to the SMB share itself; "folder": a directory already mounted into the container. */
	mode: "smb" | "folder";
	/** folder: the directory inside the container. */
	path: string;
	/** smb: the server's name or IP address, the share's name and a folder inside it. */
	server: string;
	share: string;
	directory: string;
	username: string;
	password: string;
	/** smb: the workgroup or Windows domain ("" for none). */
	domain: string;
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
	share: ShareTarget;
	google: GoogleTarget;
	/** Also save CSV copies beside each dump: the General Ledger and each module's tables. */
	include_csv: boolean;
}

export type BackupState = "idle" | "running" | "ok" | "warning" | "error";

export interface TargetResult {
	target: "share" | "google";
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
	last_ok: { share: string | null; google: string | null };
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
	last_ok: { share: null, google: null },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// ledger-<stamp>.dump for the main database, ledger-<database>-<stamp>.dump
// for each other organization's.
// With CSV copies beside each dump: ledger[-<database>]-<stamp>-general-ledger.csv
// and ledger[-<database>]-<stamp>-<module>[-<table>].csv.
const DUMP_RE = /^ledger-(?:([a-z0-9_]+)-)?(\d{8}T\d{6}Z)(?:-([a-z0-9-]+))?\.(dump|csv)$/;
// Each backup run is one folder named with its date and time in the backup
// schedule's time zone and that zone's UTC offset, e.g.
// ledger-2026-11-11_20-30-00-0600, holding ledger.dump, general-ledger.csv,
// <module>[-<table>].csv and, for other organizations' books,
// <database>.dump and <database>-….csv. (Before 0.13.1 the files sat side by
// side, named by DUMP_RE; those are still tidied away.)
const FOLDER_RE = /^ledger-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})([+-])(\d{2})(\d{2})$/;

/** The folder name for a backup made at `at` (ms), in time zone tz. */
export function backupFolderName(at: number, tz: string): string {
	const zone = isTimeZone(tz) ? tz : "UTC";
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value]),
	);
	const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
	const offset = Math.round((local - Math.floor(at / 1000) * 1000) / 60_000);
	const sign = offset < 0 ? "-" : "+";
	const abs = Math.abs(offset);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `ledger-${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** When the backup in a folder was made (ms), from its name; null if it isn't a backup folder. */
export function folderTime(name: string): number | null {
	const m = FOLDER_RE.exec(name);
	if (!m) return null;
	const local = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
	const offset = (m[7] === "-" ? -1 : 1) * (+m[8]! * 60 + +m[9]!);
	return local - offset * 60_000;
}

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
		share: {
			enabled: true,
			mode: "folder",
			path: env.BACKUP_DIR || "/app/csv_data/backups",
			server: "",
			share: "",
			directory: "ledger-backups",
			username: "",
			password: "",
			domain: "",
			keep_days: Number.isInteger(keep) && keep >= 1 && keep <= 3650 ? keep : 30,
		},
		google: { enabled: false, client_id: "", client_secret: "", refresh_token: "", folder_id: "", account: "", keep_count: 30 },
		include_csv: true,
	};
}

export async function readConfig(dir: string): Promise<BackupConfig> {
	const def = defaultConfig();
	const text = await readSmallFile(path.join(dir, CONFIG_FILE));
	if (text === null) return def;
	try {
		const v = JSON.parse(text) as Partial<BackupConfig> & { truenas?: Partial<ShareTarget> };
		// Ledger ≤ 0.11.2 called the share "truenas" and only wrote to a mounted folder.
		const share = v.share ?? (v.truenas ? { ...v.truenas, mode: "folder" as const } : {});
		return { schedule: { ...def.schedule, ...v.schedule }, share: { ...def.share, ...share }, google: { ...def.google, ...v.google }, include_csv: v.include_csv !== false };
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
		const v = JSON.parse(text) as Partial<BackupStatus> & { last_ok?: { truenas?: string | null } };
		const results = (v.results ?? []).map((r) => ({ ...r, target: (r.target as string) === "truenas" ? ("share" as const) : r.target }));
		return { ...EMPTY_STATUS, ...v, results, last_ok: { share: v.last_ok?.share ?? v.last_ok?.truenas ?? null, google: v.last_ok?.google ?? null } };
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
export function checkSharePath(p: string, err: ValidationError, field = "share.path"): string {
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
		include_csv: c.include_csv,
		share: { ...c.share, password: undefined, has_password: c.share.password !== "" },
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
	for (const k of Object.keys(o)) if (!["schedule", "share", "google", "include_csv"].includes(k)) err.add(k, "unknown field");
	if (o.include_csv !== undefined && typeof o.include_csv !== "boolean") err.add("include_csv", "must be true or false");
	const next: BackupConfig = structuredClone(c);
	if (typeof o.include_csv === "boolean") next.include_csv = o.include_csv;

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

	const t = obj("share", ["enabled", "mode", "path", "server", "share", "directory", "username", "password", "domain", "keep_days"]);
	if (t) next.share = checkShare(t, c.share, err);

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
// Network share: SMB through smbclient, or a mounted directory
// ---------------------------------------------------------------------------

const SMB_NAME = /^[^\\/:*?"<>|;\x00-\x1f]{1,80}$/;

/**
 * Validates share settings from the page. password: omitted or null keeps the
 * saved one (when the server and user stay the same), "" clears it.
 */
export function checkShare(t: Record<string, unknown>, cur: ShareTarget, err: ValidationError): ShareTarget {
	const str = (k: string) => (typeof t[k] === "string" ? (t[k] as string).trim() : t[k] === undefined ? "" : (err.add(`share.${k}`, "must be text"), ""));
	if (typeof t.enabled !== "boolean") err.add("share.enabled", "must be true or false");
	const mode = t.mode === undefined ? "smb" : t.mode;
	if (mode !== "smb" && mode !== "folder") err.add("share.mode", "must be smb or folder");
	if (!Number.isInteger(t.keep_days) || (t.keep_days as number) < 1 || (t.keep_days as number) > 3650) err.add("share.keep_days", "must be 1 to 3650 days");
	const server = str("server").replace(/^\\\\|^smb:\/\//, "").replace(/\/+$/, "");
	const share = str("share").replace(/^\/+|\/+$/g, "");
	const directory = str("directory").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	const username = str("username");
	const domain = str("domain");
	let path_ = cur.path;
	if (mode === "folder") path_ = typeof t.path === "string" ? checkSharePath(t.path, err) : (err.add("share.path", "is required"), "");
	if (mode === "smb") {
		if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:]+\]$/.test(server)) err.add("share.server", "must be a server name or IP address, e.g. truenas.local or 192.168.1.20");
		if (!SMB_NAME.test(share)) err.add("share.share", "must be the share's name, e.g. backups");
		if (directory !== "" && (directory.length > 200 || !directory.split("/").every((d) => SMB_NAME.test(d) && d !== "." && d !== ".."))) err.add("share.directory", "must be a folder inside the share, e.g. ledger/backups");
		if (username.length > 100 || /[\x00-\x1f]/.test(username)) err.add("share.username", "is not valid");
		if (domain.length > 100 || /[\x00-\x1f]/.test(domain)) err.add("share.domain", "is not valid");
	}
	let password = server === cur.server && username === cur.username ? cur.password : "";
	if (t.password !== undefined && t.password !== null) {
		if (typeof t.password !== "string" || t.password.length > 200 || /[\x00-\x1f]/.test(t.password)) err.add("share.password", "is not valid");
		else password = t.password;
	}
	return { enabled: t.enabled as boolean, mode: mode as ShareTarget["mode"], path: path_, server, share, directory, username, password, domain, keep_days: t.keep_days as number };
}

/** Where a dump goes, for messages: \\server\share\folder or the mounted path. */
export function shareLabel(t: ShareTarget): string {
	return t.mode === "folder" ? t.path : `\\\\${t.server}\\${t.share}${t.directory ? "\\" + t.directory.replaceAll("/", "\\") : ""}`;
}

/** Runs smbclient against the share with the given commands; throws on any NT_STATUS error. */
async function smbclient(t: ShareTarget, workDir: string, commands: string[], opts: { ignoreErrors?: boolean } = {}): Promise<string> {
	await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
	// The password goes in a file only this user can read, never on the command line.
	const auth = path.join(workDir, `.smb-auth-${process.pid}-${Date.now()}`);
	const lines = [`username = ${t.username || "guest"}`, `password = ${t.password}`, ...(t.domain ? [`domain = ${t.domain}`] : [])];
	await fsp.writeFile(auth, lines.join("\n") + "\n", { mode: 0o600 });
	// Its own small config: Ledger's services may only write to their state directory.
	const state = path.join(workDir, "smb");
	const conf = path.join(state, "smb.conf");
	await fsp.mkdir(state, { recursive: true, mode: 0o700 });
	const dirs = ["lock directory", "state directory", "cache directory", "private dir", "ncalrpc dir"].map((k) => `\t${k} = ${state}`);
	// ledger.service only allows AF_UNIX/INET/INET6 sockets, so smbclient can't
	// list the network interfaces itself (netlink); give it one so it doesn't
	// stop with "Could not determine network interfaces". Names are found by
	// DNS / /etc/hosts.
	const conf_ = ["[global]", ...dirs, "\tclient min protocol = SMB2", "\tinterfaces = 127.0.0.1/8", "\tname resolve order = host wins bcast", ""];
	await fsp.writeFile(conf, conf_.join("\n"), { mode: 0o600 });
	try {
		const out = await runCapture(SMBCLIENT(), ["-s", conf, `//${t.server}/${t.share}`, "-A", auth, "-m", "SMB3", "-t", "20", "-c", commands.join("; ")]);
		const bad = /(NT_STATUS_[A-Z_]+)/.exec(out);
		if (bad && !opts.ignoreErrors) throw new Error(smbError(bad[1]!, out));
		return out;
	} catch (e) {
		const m = /(NT_STATUS_[A-Z_]+)/.exec((e as Error).message);
		// A command that may fail (e.g. deleting what isn't there): only a connection or login problem counts.
		if (m && opts.ignoreErrors && !/LOGON_FAILURE|BAD_NETWORK_NAME|HOST_UNREACHABLE|CONNECTION_REFUSED|IO_TIMEOUT|UNSUCCESSFUL|NOT_FOUND\b/.test(m[1]!)) return (e as Error).message;
		if (m && !(e as Error).message.startsWith("SMB:")) throw new Error(smbError(m[1]!, (e as Error).message));
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("smbclient is not installed on the server (apt install smbclient)");
		throw e;
	} finally {
		await fsp.rm(auth, { force: true });
	}
}

const SMBCLIENT = () => process.env.LEDGER_SMBCLIENT || "smbclient";

function smbError(status: string, out: string): string {
	const why: Record<string, string> = {
		NT_STATUS_LOGON_FAILURE: "the user name or password is wrong",
		NT_STATUS_ACCESS_DENIED: "that user may not write there",
		NT_STATUS_BAD_NETWORK_NAME: "there is no share by that name on the server",
		NT_STATUS_OBJECT_NAME_NOT_FOUND: "the folder could not be created or found",
		NT_STATUS_OBJECT_PATH_NOT_FOUND: "the folder could not be created or found",
		NT_STATUS_HOST_UNREACHABLE: "the server can't be reached (check its name, or use its IP address)",
		NT_STATUS_NOT_FOUND: "the server's name couldn't be found; use its IP address or full name (e.g. truenas.local)",
		NT_STATUS_IO_TIMEOUT: "the server didn't answer",
		NT_STATUS_CONNECTION_REFUSED: "the server refused the connection (is SMB turned on?)",
		NT_STATUS_UNSUCCESSFUL: "the server can't be reached (check its name, or use its IP address)",
		NT_STATUS_DISK_FULL: "the share is full",
	};
	return `SMB: ${why[status] ?? out.trim().split("\n").at(-1)} (${status})`;
}

/** cd commands for the share's folder, creating it first (errors for folders that exist are ignored). */
async function smbEnterDir(t: ShareTarget, workDir: string): Promise<string[]> {
	if (!t.directory) return [];
	const parts = t.directory.split("/");
	const mk = parts.map((_, i) => `mkdir "${parts.slice(0, i + 1).join("/")}"`);
	await smbclient(t, workDir, mk, { ignoreErrors: true });
	return [`cd "${t.directory}"`];
}

const freeSpace = (out: string) => {
	const m = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(out);
	return m ? Number(m[3]) * Number(m[2]) : null;
};

/** Checks the share can be written to; reports free space. */
export async function testShare(t: ShareTarget, workDir: string): Promise<{ ok: boolean; message: string; free_bytes: number | null }> {
	if (t.mode === "folder") return testFolder(t.path);
	try {
		const cd = await smbEnterDir(t, workDir);
		const probe = path.join(workDir, `ledger-write-test-${process.pid}`);
		await fsp.writeFile(probe, "ok");
		try {
			const out = await smbclient(t, workDir, [...cd, `put "${probe}" ".ledger-write-test"`, `del ".ledger-write-test"`, "ls"]);
			const free = freeSpace(out);
			return { ok: true, message: `${shareLabel(t)} is writable${free !== null ? `; ${(free / 1024 ** 3).toFixed(1)} GiB free` : ""}.`, free_bytes: free };
		} finally {
			await fsp.rm(probe, { force: true });
		}
	} catch (e) {
		return { ok: false, message: `Can't write to ${shareLabel(t)}: ${(e as Error).message}`, free_bytes: null };
	}
}

export interface BackupEntry {
	/** A backup folder (or, from before 0.13.1, a single .dump file). */
	name: string;
	size_bytes: number;
	modified_at: string;
}

/** One line of smbclient's `ls`: name, attributes (D = folder), size, date. */
function parseSmbLs(line: string): { name: string; dir: boolean; size: number; at: string } | null {
	const m = /^\s+(\S+)\s+([A-Z]*)\s+(\d+)\s+\w{3} (\w{3}\s+\d+ [\d:]+ \d{4})$/.exec(line);
	if (!m || m[1] === "." || m[1] === "..") return null;
	return { name: m[1]!, dir: m[2]!.includes("D"), size: Number(m[3]), at: new Date(`${m[4]} UTC`).toISOString() };
}

/** The newest backups on the share, for the settings page: folders with their total size. */
export async function listShareDumps(t: ShareTarget, workDir: string, limit = 10): Promise<BackupEntry[]> {
	if (t.mode === "folder") return listFolderDumps(t.path, limit);
	const out = await smbclient(t, workDir, [...(t.directory ? [`cd "${t.directory}"`] : []), "recurse ON", "ls"]).catch(() => "");
	const entries = new Map<string, BackupEntry>();
	let current = ""; // the folder the following lines list ("" = the backups folder itself)
	for (const line of out.split("\n")) {
		if (line.startsWith("\\")) {
			// e.g. \ledger\nightly\ledger-2026-…: the share's folder, then the backup's.
			current = line.trim().split("\\").find((p) => FOLDER_RE.test(p)) ?? "-";
			continue;
		}
		const e = parseSmbLs(line);
		if (!e) continue;
		if (current === "") {
			if (e.dir && FOLDER_RE.test(e.name)) entries.set(e.name, { name: e.name, size_bytes: 0, modified_at: e.at });
			else if (!e.dir && DUMP_RE.test(e.name) && e.name.endsWith(".dump")) entries.set(e.name, { name: e.name, size_bytes: e.size, modified_at: e.at });
		} else if (!e.dir && entries.has(current)) entries.get(current)!.size_bytes += e.size;
	}
	return newestFirst([...entries.values()]).slice(0, limit);
}

const entryTime = (name: string) => folderTime(name) ?? dumpTime(name) ?? 0;
const newestFirst = (list: BackupEntry[]) => list.sort((a, b) => entryTime(b.name) - entryTime(a.name));

/** When a pre-0.13.1 backup file was made, from the stamp in its name (…-YYYYMMDDTHHMMSSZ[-…].dump|csv). */
function dumpTime(name: string): number | null {
	const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-[a-z0-9-]+)?\.(?:dump|csv)$/.exec(name);
	return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

// ---------------------------------------------------------------------------
// Fetching a backup back (Settings → Backups → Restore)
// ---------------------------------------------------------------------------

/** Whether a name is a backup folder's (ledger-2026-11-11_20-30-00-0600). */
export const isBackupFolder = (name: string) => FOLDER_RE.test(name);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,127}$/;

/** Copies a backup folder from the share into dest (regular files only). */
export async function fetchShareBackup(t: ShareTarget, workDir: string, name: string, dest: string): Promise<void> {
	if (!isBackupFolder(name)) throw new Error(`${name} is not a backup folder`);
	await fsp.rm(dest, { recursive: true, force: true });
	await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
	if (t.mode === "folder") {
		const src = path.join(t.path, name);
		const st = await fsp.lstat(src).catch(() => null);
		if (!st?.isDirectory()) throw new Error(`${name} is no longer in ${t.path}`);
		for (const f of await listTree(src)) {
			if (!(await fsp.lstat(f.full)).isFile()) continue;
			await fsp.mkdir(path.dirname(path.join(dest, f.rel)), { recursive: true, mode: 0o700 });
			await fsp.copyFile(f.full, path.join(dest, f.rel));
		}
		return;
	}
	await smbclient(t, workDir, [`cd "${t.directory ? `${t.directory}/` : ""}${name}"`, `lcd "${dest}"`, "recurse ON", "prompt OFF", "mget *"]);
}

interface DriveFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: string;
}

async function driveChildren(ep: GoogleEndpoints, token: string, parent: string): Promise<DriveFile[]> {
	const q = encodeURIComponent(`'${parent}' in parents and trashed = false`);
	const out: DriveFile[] = [];
	let page = "";
	do {
		const r = (await driveJson(ep, token, "GET", `/drive/v3/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,size)${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`)) as {
			files?: DriveFile[];
			nextPageToken?: string;
		};
		out.push(...(r.files ?? []));
		page = r.nextPageToken ?? "";
	} while (page);
	return out;
}

const DRIVE_FOLDER = "application/vnd.google-apps.folder";

/** The newest backup folders on Google Drive. */
export async function listDriveBackups(g: GoogleTarget, ep: GoogleEndpoints, limit = 10): Promise<BackupEntry[]> {
	if (!g.refresh_token || !g.folder_id) return [];
	const token = await accessToken(g, ep);
	const folders = (await driveChildren(ep, token, g.folder_id)).filter((f) => isBackupFolder(f.name));
	return newestFirst(folders.map((f) => ({ name: f.name, size_bytes: 0, modified_at: new Date(folderTime(f.name)!).toISOString() }))).slice(0, limit);
}

/** Downloads a backup folder from Google Drive into dest. */
export async function fetchDriveBackup(g: GoogleTarget, ep: GoogleEndpoints, name: string, dest: string): Promise<void> {
	if (!isBackupFolder(name)) throw new Error(`${name} is not a backup folder`);
	if (!g.refresh_token || !g.folder_id) throw new Error("Google Drive is not connected");
	const token = await accessToken(g, ep);
	const top = (await driveChildren(ep, token, g.folder_id)).find((f) => f.name === name);
	if (!top) throw new Error(`${name} is no longer on Google Drive`);
	await fsp.rm(dest, { recursive: true, force: true });
	const walk = async (id: string, dir: string, depth: number): Promise<void> => {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		for (const f of await driveChildren(ep, token, id)) {
			if (!SAFE_NAME.test(f.name)) continue;
			if (f.mimeType === DRIVE_FOLDER) {
				if (depth < 10) await walk(f.id, path.join(dir, f.name), depth + 1);
				continue;
			}
			const res = await fetch(`${ep.api}/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30 * 60_000) });
			if (!res.ok || !res.body) throw new Error(`download of ${f.name} from Google Drive failed (${res.status})`);
			await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path.join(dir, f.name), { mode: 0o600 }));
		}
	};
	await walk(top.id, dest, 0);
}

/** Checks a dump file is a readable pg_dump archive. */
export const checkDump = (file: string) => run("pg_restore", ["--list", file]);

/** A file to put in a backup folder: where it is now, and its path inside the folder ("files/sales/a.pdf"). */
export interface BackupItem {
	src: string;
	rel: string;
}

/** The folders a set of items needs, parents first ("files", "files/sales", …). */
function foldersOf(items: BackupItem[]): string[] {
	const dirs = new Set<string>();
	for (const it of items) {
		const parts = it.rel.split("/").slice(0, -1);
		for (let k = 1; k <= parts.length; k++) dirs.add(parts.slice(0, k).join("/"));
	}
	return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Puts a backup folder on the share and removes backups older than keep_days. */
async function copyToShare(folder: string, items: BackupItem[], t: ShareTarget, now: number, workDir: string): Promise<string> {
	if (t.mode === "folder") return copyToFolder(folder, items, t, now);
	const cd = await smbEnterDir(t, workDir);
	// Upload into a temporary folder, then rename it, so a half-written backup never looks complete.
	const tmp = `.${folder}.tmp`;
	await smbclient(t, workDir, [...cd, `deltree "${tmp}"`, `deltree "${folder}"`], { ignoreErrors: true });
	const win = (rel: string) => rel.replaceAll("/", "\\");
	const steps = [`mkdir "${tmp}"`, ...foldersOf(items).map((d) => `mkdir "${tmp}\\${win(d)}"`), ...items.map((it) => `put "${it.src}" "${tmp}\\${win(it.rel)}"`)];
	// In batches, so a backup with many stored files doesn't make one enormous command line.
	for (let k = 0; k < steps.length; k += 200) await smbclient(t, workDir, [...cd, ...steps.slice(k, k + 200)]);
	await smbclient(t, workDir, [...cd, `rename "${tmp}" "${folder}"`]);
	// Old backups: folders by the time in their name, and files from before 0.13.1.
	const listing = await smbclient(t, workDir, [...cd, "ls"]);
	const oldDirs: string[] = [];
	const oldFiles: string[] = [];
	for (const line of listing.split("\n")) {
		const e = parseSmbLs(line);
		if (!e || e.name === folder) continue;
		const at = e.dir ? folderTime(e.name) : DUMP_RE.test(e.name) ? dumpTime(e.name) : null;
		if (at !== null && now - at > t.keep_days * 86_400_000) (e.dir ? oldDirs : oldFiles).push(e.name);
	}
	if (oldDirs.length + oldFiles.length > 0) await smbclient(t, workDir, [...cd, ...oldDirs.map((d) => `deltree "${d}"`), ...oldFiles.map((f) => `del "${f}"`)]);
	return `Saved ${folder} to ${shareLabel(t)}${oldDirs.length ? `; removed ${oldDirs.length} older than ${t.keep_days} days` : ""}.`;
}

// A directory mounted into the container.

/** Checks the directory exists and is writable; reports free space. */
async function testFolder(p: string): Promise<{ ok: boolean; message: string; free_bytes: number | null }> {
	const err = new ValidationError();
	const dir = checkSharePath(p, err, "path");
	err.throwIfAny();
	const parent = path.dirname(dir);
	const info = await fsp.stat(dir).catch(() => null);
	if (!info) {
		const pinfo = await fsp.stat(parent).catch(() => null);
		if (!pinfo) return { ok: false, message: `${parent} does not exist. Is the share mounted into the container?`, free_bytes: null };
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

async function listFolderDumps(dir: string, limit = 10): Promise<BackupEntry[]> {
	const names = await fsp.readdir(dir).catch(() => [] as string[]);
	const out: BackupEntry[] = [];
	for (const n of names) {
		const st = await fsp.stat(path.join(dir, n)).catch(() => null);
		if (!st) continue;
		if (st.isDirectory() && FOLDER_RE.test(n)) {
			let size = 0;
			for (const f of await fsp.readdir(path.join(dir, n)).catch(() => [] as string[])) size += (await fsp.stat(path.join(dir, n, f)).catch(() => null))?.size ?? 0;
			out.push({ name: n, size_bytes: size, modified_at: st.mtime.toISOString() });
		} else if (st.isFile() && DUMP_RE.test(n) && n.endsWith(".dump")) {
			out.push({ name: n, size_bytes: st.size, modified_at: st.mtime.toISOString() });
		}
	}
	return newestFirst(out).slice(0, limit);
}

async function copyToFolder(folder: string, items: BackupItem[], t: ShareTarget, now: number): Promise<string> {
	await fsp.mkdir(t.path, { recursive: true });
	const tmp = path.join(t.path, `.${folder}.tmp`);
	try {
		await fsp.rm(tmp, { recursive: true, force: true });
		for (const it of items) {
			await fsp.mkdir(path.dirname(path.join(tmp, it.rel)), { recursive: true });
			await fsp.copyFile(it.src, path.join(tmp, it.rel));
		}
		// A backup started in the same second (by hand, twice) replaces the first.
		await fsp.rm(path.join(t.path, folder), { recursive: true, force: true });
		await fsp.rename(tmp, path.join(t.path, folder));
	} catch (e) {
		await fsp.rm(tmp, { recursive: true, force: true });
		throw e;
	}
	let removed = 0;
	for (const n of await fsp.readdir(t.path)) {
		if (n === folder) continue;
		const isFolder = FOLDER_RE.test(n);
		if (!isFolder && !DUMP_RE.test(n)) continue;
		const st = await fsp.stat(path.join(t.path, n)).catch(() => null);
		const at = isFolder ? folderTime(n) : st?.mtimeMs ?? null;
		if (st && at !== null && now - at > t.keep_days * 86_400_000) {
			await fsp.rm(path.join(t.path, n), { recursive: true, force: true });
			if (isFolder) removed++;
		}
	}
	return `Saved ${folder} to ${t.path}${removed ? `; removed ${removed} older than ${t.keep_days} days` : ""}.`;
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

/** Uploads one file into a Drive folder (resumable upload, one PUT). */
async function uploadFileToDrive(file: string, parent: string, token: string, ep: GoogleEndpoints, name = path.basename(file)): Promise<void> {
	const size = (await fsp.stat(file)).size;
	const start = await fetch(`${ep.api}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": name.endsWith(".csv") ? "text/csv" : "application/octet-stream",
			"X-Upload-Content-Length": String(size),
		},
		body: JSON.stringify({ name, parents: [parent], description: name.endsWith(".dump") ? "Ledger database backup (pg_dump custom format)" : "Ledger backup, CSV copy" }),
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
		throw new Error(`upload of ${name} failed (${put.status}): ${googleError(j, put.statusText)}`);
	}
}

/** Uploads a backup folder as a subfolder of "Ledger backups"; keeps the newest keep_count backups. */
async function uploadToDrive(folder: string, items: BackupItem[], g: GoogleTarget, ep: GoogleEndpoints): Promise<string> {
	if (!g.refresh_token || !g.folder_id) throw new Error("Google Drive is not connected; connect it under Settings → Backups");
	const token = await accessToken(g, ep);
	const created = (await driveJson(ep, token, "POST", "/drive/v3/files?fields=id", {
		name: folder,
		mimeType: "application/vnd.google-apps.folder",
		parents: [g.folder_id],
	}).catch((e: Error) => {
		throw new Error(/404/.test(e.message) ? `the "${FOLDER_NAME}" folder is gone from Google Drive; connect again to recreate it` : e.message);
	})) as { id: string };
	try {
		const ids = new Map<string, string>([["", created.id]]);
		for (const d of foldersOf(items)) {
			const parent = ids.get(d.split("/").slice(0, -1).join("/"))!;
			const sub = (await driveJson(ep, token, "POST", "/drive/v3/files?fields=id", { name: d.split("/").at(-1), mimeType: "application/vnd.google-apps.folder", parents: [parent] })) as { id: string };
			ids.set(d, sub.id);
		}
		for (const it of items) await uploadFileToDrive(it.src, ids.get(it.rel.split("/").slice(0, -1).join("/"))!, token, ep, it.rel.split("/").at(-1)!);
	} catch (e) {
		// Leave no half-uploaded backup behind.
		await driveJson(ep, token, "DELETE", `/drive/v3/files/${encodeURIComponent(created.id)}`).catch(() => {});
		throw e;
	}
	// Keep the newest keep_count backup folders (deleting a folder deletes what's in it);
	// files from before 0.13.1 go once they're older than the oldest folder kept.
	const q = encodeURIComponent(`'${g.folder_id}' in parents and trashed = false`);
	const list = (await driveJson(ep, token, "GET", `/drive/v3/files?q=${q}&pageSize=1000&fields=files(id,name)`)) as { files?: { id: string; name: string }[] };
	const folders = (list.files ?? []).filter((f) => FOLDER_RE.test(f.name)).sort((a, b) => folderTime(b.name)! - folderTime(a.name)!);
	const old = folders.slice(g.keep_count);
	const oldestKept = folders.length >= g.keep_count ? folderTime(folders[Math.min(g.keep_count, folders.length) - 1]!.name)! : null;
	const legacy = oldestKept === null ? [] : (list.files ?? []).filter((f) => DUMP_RE.test(f.name) && (dumpTime(f.name) ?? Infinity) < oldestKept);
	for (const f of [...old, ...legacy]) await driveJson(ep, token, "DELETE", `/drive/v3/files/${encodeURIComponent(f.id)}`);
	return `Uploaded ${folder} to Google Drive (${g.account || "connected account"}, folder "${FOLDER_NAME}")${old.length ? `; removed ${old.length} older` : ""}.`;
}

// ---------------------------------------------------------------------------
// Running a backup
// ---------------------------------------------------------------------------

/**
 * Writes CSV copies of one database into a backup folder: <prefix>general-ledger.csv
 * and every table of each module's schema as <prefix><module>[-<table>].csv
 * (prefix "" for the main books, "<database>-" for another organization's).
 * Read in one consistent snapshot. Returns the files written.
 */
export async function writeCsvCopies(databaseUrl: string, dir: string, prefix: string, modulesDirPath: string): Promise<string[]> {
	const base = path.join(dir, prefix.replace(/-$/, ""));
	const named = (rest: string) => (prefix ? `${base}-${rest}` : path.join(dir, rest));
	const names = new Map<string, string>(); // schema → module id
	for (const m of await scanInstalled(modulesDirPath).catch(() => [])) names.set(`mod_${m.manifest.id.replaceAll("-", "_")}`, m.manifest.id);
	const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, types: { getTypeParser } as pg.CustomTypesConfig });
	await client.connect();
	const out: string[] = [];
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		const gl = named("general-ledger.csv");
		const fh = await fsp.open(gl, "w", 0o600);
		try {
			await writeGeneralLedger(client, (chunk) => fh.write(chunk).then(() => undefined));
		} finally {
			await fh.close();
		}
		out.push(gl);
		const tables = (
			await client.query<{ schema: string; table: string }>(
				`SELECT table_schema AS schema, table_name AS table FROM information_schema.tables
				  WHERE table_schema LIKE 'mod\\_%' AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
			)
		).rows;
		const bySchema = new Map<string, string[]>();
		for (const t of tables) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t.table]);
		const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
		for (const [schema, list] of bySchema) {
			const id = slug(names.get(schema) ?? schema.slice(4));
			for (const table of list) {
				const file = named(`${id}${list.length > 1 ? `-${slug(table)}` : ""}.csv`);
				const q = (x: string) => `"${x.replaceAll('"', '""')}"`;
				// Binary columns (a module's stored files) are noted, not copied: the .dump has them, and a
				// spreadsheet can't use base64. Rows are read in batches through a cursor and written as they
				// come, so a large table neither fills memory nor overruns the longest string V8 can hold.
				const cell = (v: unknown) =>
					v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `(binary, ${v.length} bytes; in the .dump)` : typeof v === "object" ? JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) : String(v);
				// int2/4/8, float4/8 and numeric stay as numbers; text gets the spreadsheet-formula guard.
				const numeric = new Set([20, 21, 23, 700, 701, 1700]);
				await client.query(`DECLARE csv_rows NO SCROLL CURSOR FOR SELECT * FROM ${q(schema)}.${q(table)}`);
				const th = await fsp.open(file, "w", 0o600);
				try {
					for (let first = true; ; first = false) {
						const r = await client.query("FETCH 500 FROM csv_rows");
						let text = first ? csvRecord(r.fields.map((f) => f.name)) : "";
						for (const row of r.rows) {
							text += csvRecord(r.fields.map((f) => {
								const v = cell((row as Record<string, unknown>)[f.name]);
								return numeric.has(f.dataTypeID) ? v : csvText(v);
							}));
						}
						if (text) await th.write(text);
						if (r.rows.length < 500) break;
					}
				} finally {
					await th.close();
					await client.query("CLOSE csv_rows");
				}
				out.push(file);
			}
		}
		await client.query("COMMIT");
		return out;
	} catch (err) {
		for (const f of out) await fsp.rm(f, { force: true });
		throw new Error(`CSV copies: ${(err as Error).message}`, { cause: err });
	} finally {
		await client.end().catch(() => {});
	}
}

/** Runs a command and returns its output (stdout and stderr together); rejects on a non-zero exit or after 10 minutes. */
function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
		let out = "";
		const add = (d: Buffer) => (out = (out + d.toString()).slice(-200_000));
		p.stdout.on("data", add);
		p.stderr.on("data", add);
		p.on("error", reject);
		p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${out.trim().split("\n").slice(-2).join(" / ")}`))));
	});
}

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
	/** Installed modules, to name their CSV copies (default: /var/lib/ledger/modules). */
	modulesDir?: string;
	/** The data share (CSV_DIR), where modules keep their files (ctx.storage). */
	csvDir?: string;
	/** Writes a database's CSV copies (tests make it fail). */
	csvCopies?: typeof writeCsvCopies;
	/** Writes a database's dump (tests replace pg_dump). */
	dump?: (file: string, databaseUrl: string) => Promise<void>;
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

		const name = backupFolderName(now(), config.schedule.timezone);
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

		const targets = [config.share.enabled && "share", config.google.enabled && "google"].filter(Boolean) as ("share" | "google")[];
		const workDir = path.join(o.dir, "tmp");
		const localDir = path.join(workDir, name);
		try {
			if (targets.length === 0) throw new Error("no backup destination is turned on; choose a network share or Google Drive under Settings → Backups");
			await fsp.mkdir(localDir, { recursive: true, mode: 0o700 });
			// The main database, then each other organization's.
			const orgs = await client
				.query<{ db_name: string }>(`SELECT db_name FROM organizations WHERE id <> 1 AND status = 'ready' ORDER BY id`)
				.then((r) => r.rows.map((x) => x.db_name), () => [] as string[]);
			const dumps = [
				{ file: path.join(localDir, "ledger.dump"), prefix: "", url: o.databaseUrl },
				...orgs.map((d) => ({ file: path.join(localDir, `${d}.dump`), prefix: `${d}-`, url: withDatabase(o.databaseUrl, d) })),
			];
			status.size_bytes = 0;
			const csvs: string[] = [];
			const csvProblems: string[] = [];
			for (const d of dumps) {
				await (o.dump ?? ((f, url) => run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", `--file=${f}`, url])))(d.file, d.url);
				if (!o.dump) await run("pg_restore", ["--list", d.file]); // the archive must be readable
				status.size_bytes += (await fsp.stat(d.file)).size;
				if (config.include_csv) {
					// The CSV copies are a convenience; the dump is the backup, so it goes out even if they fail.
					try {
						csvs.push(...(await (o.csvCopies ?? writeCsvCopies)(d.url, localDir, d.prefix, o.modulesDir ?? modulesDir())));
					} catch (e) {
						csvProblems.push((e as Error).message);
						log.error("backup CSV copies failed", { file: path.basename(d.file), err: (e as Error).message });
					}
				}
			}
			// What goes in the folder: the dumps and CSVs made here, and the files modules keep
			// (from the data share: files/<module>/… for the main books, <database>-files/<module>/… for others).
			const items: BackupItem[] = (await listTree(localDir)).map((f) => ({ src: f.full, rel: f.rel }));
			const csvDir = o.csvDir ?? (process.env.CSV_DIR || "/app/csv_data");
			const stored: BackupItem[] = [];
			for (const d of dumps) {
				const root = path.join(d.prefix ? path.join(csvDir, ".orgs", d.prefix.slice(0, -1)) : csvDir, ".modules");
				for (const f of await listTree(root)) stored.push({ src: f.full, rel: `${d.prefix}files/${f.rel}` });
			}
			items.push(...stored);
			for (const t of targets) {
				try {
					const messages = [t === "share" ? await copyToShare(name, items, config.share, now(), workDir) : await uploadToDrive(name, items, config.google, o.google ?? googleEndpoints())];
					const parts = [dumps.length === 1 ? "the database dump" : `${dumps.length} database dumps`];
					if (csvs.length) parts.push(`${csvs.length} CSV ${csvs.length === 1 ? "copy" : "copies"} (general ledger${csvs.length > dumps.length ? " and modules" : ""})`);
					if (stored.length) parts.push(`${stored.length} file${stored.length === 1 ? "" : "s"} kept by modules`);
					if (parts.length > 1) messages.push(`It holds ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`);
					status.results.push({ target: t, ok: true, message: messages.join(" ") });
					status.last_ok[t] = new Date(now()).toISOString();
				} catch (e) {
					status.results.push({ target: t, ok: false, message: (e as Error).message });
				}
			}
			const okCount = status.results.filter((r) => r.ok).length;
			status.state = okCount === targets.length ? "ok" : okCount > 0 ? "warning" : "error";
			const label = (t: string) => (t === "share" ? "the network share" : "Google Drive");
			status.message =
				status.state === "ok"
					? `Backed up to ${status.results.map((r) => label(r.target)).join(" and ")}.`
					: status.results
							.filter((r) => !r.ok)
							.map((r) => `${label(r.target)}: ${r.message}`)
							.join(" ");
			if (csvProblems.length > 0) {
				// The dump went out; say the CSV copies didn't, and why.
				if (status.state === "ok") status.state = "warning";
				status.message += ` The CSV copies couldn't be made: ${csvProblems.join(" ")}`;
			}
		} catch (e) {
			status.state = "error";
			status.message = (e as Error).message;
		} finally {
			await fsp.rm(localDir, { recursive: true, force: true });
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
