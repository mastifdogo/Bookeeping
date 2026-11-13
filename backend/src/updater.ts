// `ledger update run`: the root updater, started by ledger-update.timer
// (every 5 minutes) and ledger-update.path (when the app asks for a check).
// It exits at once unless a "check now" request is waiting or a scheduled
// slot is due. Otherwise it:
//
//   1. asks GitHub for the latest release of LEDGER_UPDATE_REPO
//   2. if it is newer: downloads the tarball and SHA256SUMS into a root-only
//      cache, verifies the checksum, backs up the database, keeps a copy of
//      the installed program, runs the release's install.sh and restarts
//      the service; if the health check fails it restores the copy
//   3. reboots the container according to the schedule's policy.
//
// Progress and the outcome go to status.json, which the app shows.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import pg from "pg";
import { log } from "./log.ts";
import { postLedgerNotice } from "./dashboard.ts";
import { MODULES_RUN_NOW_FILE, modulesDir } from "./modules.ts";
import { migrateInstalled, moduleOps, multiDbOps, syncModules, type ModuleOps } from "./module-installer.ts";
import { withDatabase } from "./db.ts";
import { ORGS_RUN_NOW_FILE } from "./orgs.ts";
import { performRestore, restoreOps } from "./restore.ts";
import { backupStateDir } from "./backup.ts";
import { parseListenAddr } from "./config.ts";
import { repoIdentity } from "./github.ts";
import {
	EMPTY_STATUS,
	RUN_NOW_FILE,
	baseUpdateRepo,
	readUpdateRepo,
	STATUS_FILE,
	dueSlot,
	isNewer,
	readSchedule,
	readStatus,
	writeFileAtomic,
	type UpdateDirs,
	type UpdateSchedule,
	type UpdateStatus,
} from "./update.ts";

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TAG_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const MAX_DOWNLOAD_BYTES = 300 << 20;

/** What the updater does to the system; replaced by fakes in tests. */
export interface SystemOps {
	/** Runs the nightly database backup now. */
	backup(): Promise<void>;
	/** Copies the installed program aside, for rollback. */
	snapshot(): Promise<void>;
	/** Runs <releaseDir>/deploy/install.sh. */
	install(releaseDir: string): Promise<void>;
	/** Restarts ledger.service (after daemon-reload). */
	restart(): Promise<void>;
	/** Whether /api/v1/health answers ok within a minute. */
	healthy(): Promise<boolean>;
	/** Restores the snapshot taken before install. */
	rollback(): Promise<void>;
	reboot(): Promise<void>;
}

export interface UpdaterOptions {
	dirs: UpdateDirs;
	/** Root-only working directory for downloads. */
	cacheDir: string;
	repo: string;
	apiBase: string;
	arch: string;
	currentVersion: string;
	now?: () => number;
	sys: SystemOps;
	/** Module syncing (omitted: modules are left alone). */
	modules?: { dir: string; ops: ModuleOps };
	/**
	 * A file that exists from the first run after the container starts until
	 * it stops (under /run, which is emptied at every boot): its absence
	 * means this is the first run since the start.
	 */
	bootMarker?: string;
	/** Posts the outcome of a Ledger update to the dashboard (best effort). */
	notify?: (n: { title: string; body: string; level: "success" | "danger" }) => Promise<void>;
}

export interface UpdateOutcome {
	ran: boolean;
	installed: string | null;
	rebooted: boolean;
}

/** Writes status.json readable by the status directory's group (the app's user). */
async function writeStatus(dirs: UpdateDirs, s: UpdateStatus): Promise<void> {
	const { gid } = await fsp.stat(dirs.status);
	await writeFileAtomic(path.join(dirs.status, STATUS_FILE), JSON.stringify(s, null, 2) + "\n", 0o640, gid);
}

interface Release {
	tag: string;
	tarball: string;
	sums: string;
}

async function latestRelease(o: UpdaterOptions): Promise<Release> {
	const res = await fetch(`${o.apiBase}/repos/${o.repo}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "ledger-updater" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release of ${o.repo}`);
	const body = (await res.json()) as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };
	const tag = typeof body.tag_name === "string" ? body.tag_name : "";
	if (!TAG_RE.test(tag)) throw new Error(`unexpected release tag ${JSON.stringify(tag)}`);
	const asset = (name: string) => {
		const a = (body.assets ?? []).find((x) => x.name === name);
		const url = typeof a?.browser_download_url === "string" ? a.browser_download_url : "";
		if (!/^https?:\/\//.test(url)) throw new Error(`release ${tag} has no ${name}`);
		return url;
	};
	return { tag, tarball: asset(`ledger-${tag}-linux-${o.arch}.tar.gz`), sums: asset("SHA256SUMS") };
}

async function download(url: string, file: string): Promise<void> {
	const res = await fetch(url, { headers: { "User-Agent": "ledger-updater" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
	if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`);
	let size = 0;
	const limit = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, ctl) {
			size += chunk.byteLength;
			if (size > MAX_DOWNLOAD_BYTES) ctl.error(new Error(`download larger than ${MAX_DOWNLOAD_BYTES} bytes`));
			else ctl.enqueue(chunk);
		},
	});
	await pipeline(Readable.fromWeb(res.body.pipeThrough(limit) as import("node:stream/web").ReadableStream), createWriteStream(file, { mode: 0o600 }));
}

async function sha256(file: string): Promise<string> {
	const h = createHash("sha256");
	await pipeline(createReadStream(file), h);
	return h.digest("hex");
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
		p.on("error", reject);
		p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (${signal ?? code})`))));
	});
}

/** Downloads, verifies and unpacks a release; returns the unpacked directory. */
async function fetchRelease(o: UpdaterOptions, rel: Release): Promise<string> {
	const work = path.join(o.cacheDir, rel.tag);
	await fsp.rm(work, { recursive: true, force: true });
	await fsp.mkdir(work, { recursive: true, mode: 0o700 });
	const name = `ledger-${rel.tag}-linux-${o.arch}.tar.gz`;
	const tarball = path.join(work, name);
	const sumsFile = path.join(work, "SHA256SUMS");
	await download(rel.sums, sumsFile);
	await download(rel.tarball, tarball);
	const sums = await fsp.readFile(sumsFile, "utf8");
	const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[1] === name)?.[0];
	const got = await sha256(tarball);
	if (!want || want !== got) throw new Error(`checksum mismatch for ${name}`);
	await run("tar", ["-xzf", tarball, "-C", work, "--no-same-owner"]);
	const dir = path.join(work, `ledger-${rel.tag}-linux-${o.arch}`);
	for (const f of ["bin/ledger", "lib/ledger/ledger.mjs", "lib/ledger/node", "deploy/install.sh"]) {
		await fsp.access(path.join(dir, f)).catch(() => {
			throw new Error(`the release is missing ${f}`);
		});
	}
	return dir;
}

/** The core update: check, download, install, verify. */
async function runCore(
	o: UpdaterOptions,
	trigger: "manual" | "scheduled" | "startup",
	now: number,
	slot: number | null,
	prev: UpdateStatus,
): Promise<{ ok: boolean; installed: string | null; save: (patch: Partial<UpdateStatus>) => Promise<void>; status: UpdateStatus }> {
	const status: UpdateStatus = {
		...prev,
		state: "running",
		trigger,
		message: "Checking GitHub for a new release…",
		started_at: new Date(now).toISOString(),
		finished_at: null,
		installed_version: null,
		last_scheduled_for: slot !== null ? new Date(slot).toISOString() : prev.last_scheduled_for,
	};
	const save = async (patch: Partial<UpdateStatus>) => {
		Object.assign(status, patch);
		log.info("update", { state: status.state, message: status.message });
		await writeStatus(o.dirs, status);
	};
	await save({});

	try {
		const rel = await latestRelease(o);
		status.latest_version = rel.tag;
		if (!isNewer(rel.tag, o.currentVersion)) {
			await save({ message: `Up to date (${o.currentVersion}).` });
			return { ok: true, installed: null, save, status };
		}
		await save({ message: `Downloading ${rel.tag}…` });
		const dir = await fetchRelease(o, rel);
		await save({ message: `Backing up the database before installing ${rel.tag}…` });
		await o.sys.backup();
		await o.sys.snapshot();
		await save({ message: `Installing ${rel.tag}…` });
		await o.sys.install(dir);
		await o.sys.restart();
		if (!(await o.sys.healthy())) {
			await o.sys.rollback();
			await o.sys.restart();
			throw new Error(`${rel.tag} did not start correctly; restored ${o.currentVersion}`);
		}
		await fsp.rm(path.join(o.cacheDir, rel.tag), { recursive: true, force: true });
		await save({ installed_version: rel.tag, message: `Installed ${rel.tag} (was ${o.currentVersion}).` });
		return { ok: true, installed: rel.tag, save, status };
	} catch (err) {
		if (status.latest_version) await fsp.rm(path.join(o.cacheDir, status.latest_version), { recursive: true, force: true }).catch(() => {});
		await save({ state: "error", finished_at: new Date().toISOString(), message: `Update failed: ${(err as Error).message}` });
		return { ok: false, installed: null, save, status };
	}
}

/**
 * Runs one update if one is requested or due, and syncs modules. Never
 * throws: failures are recorded in the status files.
 *
 *   run-now          ("Check for updates now"): Ledger, then modules
 *   modules-run-now  (a module was added or removed): modules only
 *   a due slot       (the schedule): Ledger, then modules, then the reboot policy
 */
export async function runUpdater(o: UpdaterOptions): Promise<UpdateOutcome> {
	const now = (o.now ?? Date.now)();
	const take = (name: string) =>
		fsp.rm(path.join(o.dirs.config, name)).then(
			() => true,
			() => false,
		);
	const manual = await take(RUN_NOW_FILE);
	const modulesRequested = await take(MODULES_RUN_NOW_FILE);
	const schedule: UpdateSchedule = await readSchedule(o.dirs);
	// The first run after the container starts: checks once if "on startup" is on.
	const firstSinceBoot = o.bootMarker ? await markBooted(o.bootMarker) : false;
	const startup = firstSinceBoot && schedule.on_startup;
	const prev = (await readStatus(o.dirs)) ?? { ...EMPTY_STATUS };
	const slot = dueSlot(schedule, now, prev.last_scheduled_for);
	const core = manual || startup || slot !== null;
	if (!core && !modulesRequested) return { ran: false, installed: null, rebooted: false };

	const trigger = manual ? "manual" : slot !== null ? "scheduled" : "startup";
	const result = core ? await runCore(o, trigger, now, slot, prev) : null;
	const installed = result?.installed ?? null;

	if (o.modules) {
		try {
			await syncModules({
				dirs: o.dirs,
				modulesDir: o.modules.dir,
				cacheDir: o.cacheDir,
				apiBase: o.apiBase,
				ledgerVersion: installed ?? o.currentVersion,
				ops: o.modules.ops,
			});
		} catch (err) {
			log.error("module sync failed", { err: (err as Error).message });
		}
	}

	const notify = async (n: { title: string; body: string; level: "success" | "danger" }) => {
		await o.notify?.(n).catch((err: Error) => log.warn("could not post the update to the dashboard", { err: err.message }));
	};
	if (result && !result.ok) await notify({ title: "Update failed", body: result.status.message, level: "danger" });
	if (!result || !result.ok) return { ran: true, installed: null, rebooted: false };
	if (installed) await notify({ title: `Ledger updated to ${installed}`, body: result.status.message, level: "success" });
	// Manual and startup checks reboot only to finish an install; scheduled runs follow the policy.
	const reboot = schedule.reboot === "always" ? trigger === "scheduled" || installed !== null : schedule.reboot === "after_update" && installed !== null;
	await result.save({
		state: "ok",
		finished_at: new Date().toISOString(),
		message: result.status.message + (reboot ? " Rebooting the container." : ""),
	});
	if (reboot) await o.sys.reboot();
	return { ran: true, installed, rebooted: reboot };
}

/** Creates the boot marker; true if it didn't exist (the first run since the container started). */
async function markBooted(file: string): Promise<boolean> {
	try {
		await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fsp.writeFile(file, new Date().toISOString() + "\n", { flag: "wx", mode: 0o600 });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") log.warn("could not record the boot", { err: (err as Error).message });
		return false;
	}
}

// ---------------------------------------------------------------------------
// The real system (systemd, install.sh)
// ---------------------------------------------------------------------------

const LIB = "/usr/local/lib/ledger";
const BIN = "/usr/local/bin/ledger";

export function systemOps(cacheDir: string, httpAddr: string): SystemOps {
	const prevLib = path.join(cacheDir, "previous-lib");
	const prevBin = path.join(cacheDir, "previous-bin");
	const { host, port } = parseListenAddr(httpAddr);
	const healthHost = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
	return {
		async backup() {
			try {
				await run("systemctl", ["start", "ledger-backup.service"]);
			} catch {
				// Say why: the last lines the backup wrote to the journal.
				const why = await new Promise<string>((resolve) => {
					const p = spawn("journalctl", ["-u", "ledger-backup.service", "-n", "3", "-o", "cat", "--no-pager"], { stdio: ["ignore", "pipe", "ignore"] });
					let out = "";
					p.stdout.on("data", (d: Buffer) => (out += d.toString()));
					p.on("error", () => resolve(""));
					p.on("exit", () => resolve(out.trim().split("\n").filter(Boolean).slice(-2).join(" / ")));
				});
				throw new Error(`the database backup failed, so nothing was installed${why ? `: ${why}` : ""} (see journalctl -u ledger-backup)`);
			}
		},
		async snapshot() {
			await fsp.rm(prevLib, { recursive: true, force: true });
			await run("cp", ["-a", LIB, prevLib]);
			await fsp.copyFile(BIN, prevBin);
		},
		install: (dir) => run("sh", [path.join(dir, "deploy", "install.sh")], { cwd: dir }),
		async restart() {
			await run("systemctl", ["daemon-reload"]);
			await run("systemctl", ["restart", "ledger.service"]);
		},
		async healthy() {
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				const ok = await fetch(`http://${healthHost}:${port}/api/v1/health`, { signal: AbortSignal.timeout(3000) })
					.then((r) => r.ok)
					.catch(() => false);
				if (ok) return true;
			}
			return false;
		},
		async rollback() {
			await fsp.rm(`${LIB}.failed`, { recursive: true, force: true });
			await fsp.rename(LIB, `${LIB}.failed`);
			await run("cp", ["-a", prevLib, LIB]);
			await fsp.copyFile(prevBin, BIN);
			await fsp.rm(`${LIB}.failed`, { recursive: true, force: true });
		},
		reboot: () => run("systemctl", ["reboot"]),
	};
}

// ---------------------------------------------------------------------------
// `ledger update run`
// ---------------------------------------------------------------------------

/**
 * The repository to update from. A name saved in the app (after a rename) is
 * used only if GitHub says it is the same repository as the one Ledger was
 * installed from: this runs as root, so the web app can't point it at
 * someone else's code.
 */
export async function chooseUpdateRepo(base: string, saved: string | null, apiBase: string): Promise<string> {
	if (!saved || saved === base) return base;
	try {
		const [a, b] = await Promise.all([repoIdentity(apiBase, base), repoIdentity(apiBase, saved)]);
		if (a.id === b.id) return saved;
		log.warn("ignoring the update repository saved in the app: it is a different repository", { saved, base });
	} catch (err) {
		log.warn("could not check the update repository saved in the app; using the installed one", { saved, base, err: (err as Error).message });
	}
	return base;
}

// ---------------------------------------------------------------------------
// PostgreSQL major-version upgrade (deploy/pg-upgrade.sh)
// ---------------------------------------------------------------------------

export const PG_UPGRADE_FILE = "pg-upgrade.json";

export interface PgUpgradeRecord {
	/** The Ledger version that tried. */
	ledger_version: string;
	ok: boolean;
	message: string;
	at: string;
}

export interface PgUpgradeOptions {
	/** deploy/pg-upgrade.sh as installed. */
	script: string;
	statusDir: string;
	currentVersion: string;
	/** Try even if this Ledger version already failed (the manual command). */
	force?: boolean;
	/** Backs up every organization first; the upgrade doesn't start if this fails. */
	backup: () => Promise<void>;
	/** Runs the script; returns its exit code and the end of its output. */
	exec?: (script: string, args: string[]) => Promise<{ code: number; out: string }>;
	notify?: (n: { title: string; body: string; level: "success" | "danger" }) => Promise<void>;
	now?: () => number;
}

function execCapture(script: string, args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn("sh", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const add = (d: Buffer) => {
			process.stderr.write(d);
			out = (out + d.toString()).slice(-6000);
		};
		p.stdout.on("data", add);
		p.stderr.on("data", add);
		p.on("error", (e) => resolve({ code: 127, out: e.message }));
		p.on("exit", (code) => resolve({ code: code ?? 1, out }));
	});
}

/**
 * Moves the server's PostgreSQL to the version this Ledger release is built
 * for, when it is older: after a backup, with deploy/pg-upgrade.sh (which
 * keeps the old cluster and puts it back if Ledger doesn't come up). Tried
 * once per Ledger version; LEDGER_PG_UPGRADE=off in ledger.env turns it off.
 */
export async function maybeUpgradePostgres(o: PgUpgradeOptions): Promise<"none" | "skipped" | "done" | "failed"> {
	if (!o.force && (process.env.LEDGER_PG_UPGRADE ?? "").toLowerCase() === "off") return "none";
	if (!(await fsp.stat(o.script).catch(() => null))?.isFile()) return "none";
	const exec = o.exec ?? execCapture;
	const check = await exec(o.script, ["--check"]);
	if (check.code !== 10) return "none"; // already there (0), or not something this script handles
	const file = path.join(o.statusDir, PG_UPGRADE_FILE);
	let prev: PgUpgradeRecord | null = null;
	try {
		prev = JSON.parse(await fsp.readFile(file, "utf8")) as PgUpgradeRecord;
	} catch {
		prev = null;
	}
	if (!o.force && prev && !prev.ok && prev.ledger_version === o.currentVersion) return "skipped";

	const last = (out: string) => out.trim().split("\n").filter(Boolean).slice(-3).join(" ").replaceAll("pg-upgrade: ", "").slice(0, 900);
	let ok = false;
	let message: string;
	try {
		await o.backup();
		log.info("upgrading PostgreSQL");
		const r = await exec(o.script, []);
		ok = r.code === 0;
		message = last(r.out) || (ok ? "PostgreSQL was upgraded." : `The upgrade script failed (exit ${r.code}).`);
	} catch (err) {
		message = `The database was not upgraded: ${(err as Error).message}`;
	}
	const rec: PgUpgradeRecord = { ledger_version: o.currentVersion, ok, message, at: new Date((o.now ?? Date.now)()).toISOString() };
	await writeFileAtomic(file, JSON.stringify(rec, null, 2) + "\n", 0o644).catch((e: Error) => log.warn("could not record the PostgreSQL upgrade", { err: e.message }));
	log[ok ? "info" : "error"]("postgresql upgrade", { ok, message });
	await o
		.notify?.(ok ? { title: "Database upgraded to PostgreSQL 18", body: message, level: "success" } : { title: "The database upgrade to PostgreSQL 18 did not go through", body: `${message} Ledger keeps running on the previous version; it will try again after the next Ledger update, or run \`ledger update pg-upgrade\` on the server.`, level: "danger" })
		.catch((e: Error) => log.warn("could not post the PostgreSQL upgrade to the dashboard", { err: e.message }));
	return ok ? "done" : "failed";
}

export const UPDATE_USAGE = `usage:
  ledger update run          check for and install a release if requested or due
                             (run by ledger-update.service as root)
  ledger update pg-upgrade   move the database to PostgreSQL 18 now (as root)`;

export async function runUpdateCommand(args: string[], currentVersion: string, dirs: UpdateDirs): Promise<void> {
	if (args.length !== 1 || (args[0] !== "run" && args[0] !== "pg-upgrade")) throw new Error(UPDATE_USAGE);
	if (process.getuid?.() !== 0) throw new Error("ledger update must run as root (it is started by ledger-update.service)");
	const pgUpgrade = (force: boolean, backup: () => Promise<void>) =>
		maybeUpgradePostgres({
			script: process.env.LEDGER_PG_UPGRADE_SCRIPT || "/usr/local/share/ledger/pg-upgrade.sh",
			statusDir: dirs.status,
			currentVersion,
			force,
			backup,
			notify: process.env.DATABASE_URL ? (n) => postUpdateNotice(process.env.DATABASE_URL!, { ...n, key: "pg-upgrade" }) : undefined,
		});
	if (args[0] === "pg-upgrade") {
		const sys0 = systemOps(process.env.LEDGER_UPDATE_CACHE || "/var/cache/ledger-update", process.env.HTTP_ADDR || ":8080");
		const r = await pgUpgrade(true, sys0.backup);
		process.stdout.write(r === "none" ? "nothing to do\n" : `${r}\n`);
		if (r === "failed") process.exitCode = 1;
		return;
	}
	const base = baseUpdateRepo();
	if (!REPO_RE.test(base)) throw new Error(`LEDGER_UPDATE_REPO must look like owner/name, got ${JSON.stringify(base)}`);
	const apiBase = process.env.LEDGER_UPDATE_API || "https://api.github.com";
	const repo = await chooseUpdateRepo(base, await readUpdateRepo(dirs), apiBase);
	const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
	if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
	const cacheDir = process.env.LEDGER_UPDATE_CACHE || "/var/cache/ledger-update";
	await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });
	await fsp.chmod(cacheDir, 0o700);
	const sys = systemOps(cacheDir, process.env.HTTP_ADDR || ":8080");
	const databaseUrl = process.env.DATABASE_URL ?? "";
	// Once after an update: the database moves to the PostgreSQL version this release is built for.
	await pgUpgrade(false, sys.backup).catch((err: Error) => log.error("postgresql upgrade", { err: err.message }));
	let modules: UpdaterOptions["modules"];
	if (databaseUrl) {
		const base = { restart: sys.restart, healthy: sys.healthy };
		// A restore the app asked for (Settings → Backups) comes before anything else.
		const csvDir = process.env.CSV_DIR || "/app/csv_data";
		await performRestore({
			backupDir: backupStateDir(),
			configDir: dirs.config,
			databaseUrl,
			csvDir,
			ops: restoreOps({
				databaseUrl,
				dataDir: csvDir,
				migrateModules: (db) => migrateInstalled(modulesDir(), moduleOps(withDatabase(databaseUrl, db), base)),
				service: { stop: () => run("systemctl", ["stop", "ledger.service"]), start: () => run("systemctl", ["start", "ledger.service"]), healthy: sys.healthy },
			}),
			notify: (db, n) => withClient(withDatabase(databaseUrl, db), (c) => postLedgerNotice(c, { key: "restore", ...n, link: "/settings/backups" })),
		}).catch((err: Error) => log.error("restore", { err: err.message }));
		await provisionOrganizations(databaseUrl, dirs, base).catch((err: Error) => log.error("create organizations' databases", { err: err.message }));
		// Modules' migrations go to every organization's database.
		const orgDbs = await readyOrgDatabases(databaseUrl).catch(() => [] as string[]);
		modules = { dir: modulesDir(), ops: multiDbOps([moduleOps(databaseUrl, base), ...orgDbs.map((d) => moduleOps(withDatabase(databaseUrl, d), base))]) };
	}
	await runUpdater({
		dirs,
		cacheDir,
		repo,
		apiBase,
		arch,
		currentVersion,
		sys,
		modules,
		notify: databaseUrl ? (n) => postUpdateNotice(databaseUrl, n) : undefined,
		bootMarker: process.env.LEDGER_BOOT_MARKER || "/run/ledger-update/booted",
	});
}

async function withClient<T>(databaseUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => {});
	}
}

async function readyOrgDatabases(databaseUrl: string): Promise<string[]> {
	return withClient(databaseUrl, async (c) => (await c.query<{ db_name: string }>(`SELECT db_name FROM organizations WHERE id <> 1 AND status = 'ready' ORDER BY id`)).rows.map((r) => r.db_name));
}

/**
 * Creates the databases of organizations the app has asked for
 * (deploy/create-org-db.sh, then installed modules' migrations), and marks
 * each ready, or failed with the reason.
 */
async function provisionOrganizations(databaseUrl: string, dirs: UpdateDirs, base: Pick<ModuleOps, "restart" | "healthy">): Promise<void> {
	await fsp.rm(path.join(dirs.config, ORGS_RUN_NOW_FILE), { force: true });
	const pending = await withClient(databaseUrl, async (c) => (await c.query<{ id: string; db_name: string }>(`SELECT id::text, db_name FROM organizations WHERE status = 'pending' ORDER BY id`)).rows);
	if (pending.length === 0) return;
	const appRole = decodeURIComponent(new URL(databaseUrl).username) || "ledger_app";
	const script = process.env.LEDGER_CREATE_ORG_DB || "/usr/local/share/ledger/create-org-db.sh";
	for (const o of pending) {
		let message = "";
		try {
			if (!/^[a-z_][a-z0-9_]{0,62}$/.test(o.db_name)) throw new Error(`invalid database name ${o.db_name}`);
			await run("sh", [script], { env: { ...process.env, DB_NAME: o.db_name, APP_ROLE: appRole } });
			await migrateInstalled(modulesDir(), moduleOps(withDatabase(databaseUrl, o.db_name), base));
			log.info("organization database created", { org: o.id, db: o.db_name });
		} catch (err) {
			message = (err as Error).message.slice(0, 500);
			log.error("create organization database", { org: o.id, db: o.db_name, err: message });
		}
		await withClient(databaseUrl, (c) =>
			c.query(`UPDATE organizations SET status = $2, message = $3 WHERE id = $1`, [o.id, message ? "error" : "ready", message]),
		);
	}
}

/** One notification, key "update", replaced by each outcome. */
async function postUpdateNotice(databaseUrl: string, n: { title: string; body: string; level: "success" | "danger"; key?: string }): Promise<void> {
	const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
	await client.connect();
	try {
		await postLedgerNotice(client, { ...n, key: n.key ?? "update", link: "/settings/updates" });
	} finally {
		await client.end();
	}
}
