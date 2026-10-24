// Automatic updates: the schedule (set in the web app), the status written
// by the root updater (updater.ts), and the shared logic for deciding when a
// scheduled run is due.
//
// Two directories keep the privileges apart:
//   /var/lib/ledger/update-config  owned by ledger: the app writes schedule.json
//                                  and the run-now request file here
//   /var/lib/ledger/update-status  owned by root, readable by the ledger group:
//                                  the updater writes status.json here
// The updater (root) only ever reads the config directory, and validates
// what it reads; it downloads and installs from a root-only cache directory.

import { constants, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { ValidationError } from "./errors.ts";

export const SCHEDULE_FILE = "schedule.json";
export const RUN_NOW_FILE = "run-now";
export const STATUS_FILE = "status.json";

export interface UpdateDirs {
	config: string;
	status: string;
}

export function updateDirs(): UpdateDirs {
	return {
		config: process.env.UPDATE_CONFIG_DIR || "/var/lib/ledger/update-config",
		status: process.env.UPDATE_STATUS_DIR || "/var/lib/ledger/update-status",
	};
}

export type RebootPolicy = "never" | "after_update" | "always";
const REBOOT_POLICIES: readonly RebootPolicy[] = ["never", "after_update", "always"];

export interface UpdateSchedule {
	/** Whether scheduled runs happen at all ("Check now" always works). */
	enabled: boolean;
	/** Days of the week, 0 = Sunday ... 6 = Saturday. */
	days: number[];
	/** Local time of day, "HH:MM" (24-hour). */
	time: string;
	/** IANA time zone for days and time, e.g. "America/Winnipeg". */
	timezone: string;
	/** When to reboot the container after a scheduled run. */
	reboot: RebootPolicy;
}

export const DEFAULT_SCHEDULE: UpdateSchedule = {
	enabled: false,
	days: [0],
	time: "03:30",
	timezone: "UTC",
	reboot: "always",
};

export type UpdateState = "idle" | "running" | "ok" | "error";

export interface UpdateStatus {
	state: UpdateState;
	/** What started the last run. */
	trigger: "scheduled" | "manual" | null;
	message: string;
	started_at: string | null;
	finished_at: string | null;
	/** Latest release seen on GitHub at the last check. */
	latest_version: string | null;
	/** Set when the last run installed a new release. */
	installed_version: string | null;
	/** The scheduled time the last scheduled run was for (ISO 8601). */
	last_scheduled_for: string | null;
}

export const EMPTY_STATUS: UpdateStatus = {
	state: "idle",
	trigger: null,
	message: "",
	started_at: null,
	finished_at: null,
	latest_version: null,
	installed_version: null,
	last_scheduled_for: null,
};

// ---------------------------------------------------------------------------
// Validation (the same checks run in the app and, on what it reads, in the
// root updater)
// ---------------------------------------------------------------------------

const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function isTimeZone(tz: string): boolean {
	if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Validates an unknown value as a schedule; throws ValidationError. */
export function validateSchedule(v: unknown): UpdateSchedule {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) {
		if (!["enabled", "days", "time", "timezone", "reboot"].includes(k)) err.add(k, "unknown field");
	}
	if (typeof o.enabled !== "boolean") err.add("enabled", "must be true or false");
	const days = o.days;
	if (!Array.isArray(days) || days.length === 0 || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
		err.add("days", "must list one or more days of the week, 0 (Sunday) to 6 (Saturday)");
	} else if (new Set(days).size !== days.length) {
		err.add("days", "must not repeat a day");
	}
	if (typeof o.time !== "string" || !TIME_RE.test(o.time)) err.add("time", 'must be a 24-hour time such as "03:30"');
	if (typeof o.timezone !== "string" || !isTimeZone(o.timezone)) err.add("timezone", "must be a time zone such as America/Toronto");
	if (typeof o.reboot !== "string" || !REBOOT_POLICIES.includes(o.reboot as RebootPolicy)) {
		err.add("reboot", "must be never, after_update or always");
	}
	err.throwIfAny();
	return {
		enabled: o.enabled as boolean,
		days: [...(days as number[])].sort((a, b) => a - b),
		time: o.time as string,
		timezone: o.timezone as string,
		reboot: o.reboot as RebootPolicy,
	};
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 64 << 10;

/** Reads a small regular file without following symlinks; null if missing or unusable. */
export async function readSmallFile(file: string): Promise<string | null> {
	let fh;
	try {
		fh = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		const info = await fh.stat();
		if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
		return await fh.readFile("utf8");
	} finally {
		await fh.close();
	}
}

/**
 * Writes a file atomically (temp file + rename, which never follows a
 * symlink at the target). With gid, the file gets that group (the root
 * updater uses it so the app's group can read its status).
 */
export async function writeFileAtomic(file: string, content: string, mode: number, gid?: number): Promise<void> {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${randomInt(2 ** 32)}.tmp`);
	const fh = await fsp.open(tmp, "wx", mode);
	try {
		await fh.writeFile(content);
		if (gid !== undefined) await fh.chown(-1, gid);
		await fh.chmod(mode);
		await fh.sync();
	} finally {
		await fh.close();
	}
	try {
		await fsp.rename(tmp, file);
	} catch (err) {
		await fsp.rm(tmp, { force: true });
		throw err;
	}
}

/** The saved schedule, or the default when none is saved or it is invalid. */
export async function readSchedule(dirs: UpdateDirs): Promise<UpdateSchedule> {
	const text = await readSmallFile(path.join(dirs.config, SCHEDULE_FILE));
	if (text === null) return { ...DEFAULT_SCHEDULE };
	try {
		return validateSchedule(JSON.parse(text));
	} catch {
		return { ...DEFAULT_SCHEDULE };
	}
}

export async function writeSchedule(dirs: UpdateDirs, s: UpdateSchedule): Promise<void> {
	await writeFileAtomic(path.join(dirs.config, SCHEDULE_FILE), JSON.stringify(s, null, 2) + "\n", 0o640);
}

export async function readStatus(dirs: UpdateDirs): Promise<UpdateStatus | null> {
	const text = await readSmallFile(path.join(dirs.status, STATUS_FILE));
	if (text === null) return null;
	try {
		const v = JSON.parse(text) as Partial<UpdateStatus>;
		return { ...EMPTY_STATUS, ...v };
	} catch {
		return null;
	}
}

/** Whether the root updater is installed (its directories exist). */
export async function updaterInstalled(dirs: UpdateDirs): Promise<boolean> {
	const ok = async (d: string) => (await fsp.stat(d).catch(() => null))?.isDirectory() ?? false;
	return (await ok(dirs.config)) && (await ok(dirs.status));
}

/** Asks the updater to run now (picked up by ledger-update.path). */
export async function requestRunNow(dirs: UpdateDirs): Promise<void> {
	await writeFileAtomic(path.join(dirs.config, RUN_NOW_FILE), new Date().toISOString() + "\n", 0o640);
}

/** The installed release version (lib/ledger/VERSION), or "dev". */
export function installedVersion(programDir: string): string {
	try {
		const v = readFileSync(path.join(programDir, "VERSION"), "utf8").trim();
		return /^[0-9A-Za-z.+_-]{1,64}$/.test(v) ? v : "dev";
	} catch {
		return "dev";
	}
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Parses "v1.2.3" (optionally "-pre"); null for anything else (dev builds, git describe output). */
export function parseVersion(v: string): [number, number, number, string] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(v);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Whether release `latest` is newer than the installed `current`. Unknown current versions are older. */
export function isNewer(latest: string, current: string): boolean {
	const l = parseVersion(latest);
	if (!l) return false;
	const c = parseVersion(current);
	if (!c) return true;
	for (let i = 0; i < 3; i++) if (l[i] !== c[i]) return (l[i] as number) > (c[i] as number);
	// Same x.y.z: a release beats a pre-release; pre-releases compare as text.
	if (l[3] === c[3]) return false;
	if (l[3] === "") return true;
	if (c[3] === "") return false;
	return l[3] > c[3];
}

// ---------------------------------------------------------------------------
// When is a scheduled run due?
// ---------------------------------------------------------------------------

/** Offset of tz from UTC at instant t, in milliseconds. */
function tzOffset(t: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(t));
	const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUTC - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of wall-clock time y-m-d hh:mm in tz. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
	const guess = Date.UTC(y, m, d, hh, mm);
	const first = guess - tzOffset(guess, tz);
	return guess - tzOffset(first, tz); // second pass settles DST transitions
}

/** The calendar date (y, m, d, weekday) in tz at instant t. */
function zonedDate(t: number, tz: string): { y: number; m: number; d: number } {
	const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
	const [y, m, d] = s.split("-").map(Number) as [number, number, number];
	return { y, m: m - 1, d };
}

/** The most recent scheduled instant at or before now (within the last 8 days), or null. */
export function lastScheduledTime(s: UpdateSchedule, now: number): number | null {
	const [hh, mm] = s.time.split(":").map(Number) as [number, number];
	for (let back = 0; back <= 8; back++) {
		const { y, m, d } = zonedDate(now - back * 86_400_000, s.timezone);
		const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();
		if (!s.days.includes(weekday)) continue;
		const t = zonedToUtc(y, m, d, hh, mm, s.timezone);
		if (t <= now) return t;
	}
	return null;
}

/** The next scheduled instant after now, or null when disabled. */
export function nextScheduledTime(s: UpdateSchedule, now: number): number | null {
	if (!s.enabled) return null;
	const [hh, mm] = s.time.split(":").map(Number) as [number, number];
	for (let ahead = 0; ahead <= 8; ahead++) {
		const { y, m, d } = zonedDate(now + ahead * 86_400_000, s.timezone);
		const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();
		if (!s.days.includes(weekday)) continue;
		const t = zonedToUtc(y, m, d, hh, mm, s.timezone);
		if (t > now) return t;
	}
	return null;
}

/** A run missed by more than this (container off, say) is skipped until the next slot. */
export const CATCH_UP_MS = 6 * 3600_000;

/**
 * The scheduled instant a run is due for now, or null. A slot is due once:
 * after it has passed, if no run was recorded for it, and if it was missed
 * by less than CATCH_UP_MS.
 */
export function dueSlot(s: UpdateSchedule, now: number, lastScheduledFor: string | null): number | null {
	if (!s.enabled) return null;
	const slot = lastScheduledTime(s, now);
	if (slot === null || now - slot > CATCH_UP_MS) return null;
	const last = lastScheduledFor ? Date.parse(lastScheduledFor) : NaN;
	if (!Number.isNaN(last) && last >= slot) return null;
	return slot;
}
