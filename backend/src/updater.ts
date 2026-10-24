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
import { log } from "./log.ts";
import { parseListenAddr } from "./config.ts";
import {
	EMPTY_STATUS,
	RUN_NOW_FILE,
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

/**
 * Runs one update if one is requested or due. Never throws: failures are
 * recorded in status.json.
 */
export async function runUpdater(o: UpdaterOptions): Promise<UpdateOutcome> {
	const now = (o.now ?? Date.now)();
	const runNow = path.join(o.dirs.config, RUN_NOW_FILE);
	const manual = await fsp.rm(runNow).then(
		() => true,
		() => false,
	);
	const schedule: UpdateSchedule = await readSchedule(o.dirs);
	const prev = (await readStatus(o.dirs)) ?? { ...EMPTY_STATUS };
	const slot = dueSlot(schedule, now, prev.last_scheduled_for);
	if (!manual && slot === null) return { ran: false, installed: null, rebooted: false };

	const status: UpdateStatus = {
		...prev,
		state: "running",
		trigger: manual ? "manual" : "scheduled",
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

	let installed: string | null = null;
	try {
		const rel = await latestRelease(o);
		status.latest_version = rel.tag;
		if (!isNewer(rel.tag, o.currentVersion)) {
			await save({ message: `Up to date (${o.currentVersion}).` });
		} else {
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
			installed = rel.tag;
			await fsp.rm(path.join(o.cacheDir, rel.tag), { recursive: true, force: true });
			await save({ installed_version: rel.tag, message: `Installed ${rel.tag} (was ${o.currentVersion}).` });
		}
	} catch (err) {
		if (status.latest_version) await fsp.rm(path.join(o.cacheDir, status.latest_version), { recursive: true, force: true }).catch(() => {});
		await save({ state: "error", finished_at: new Date().toISOString(), message: `Update failed: ${(err as Error).message}` });
		return { ran: true, installed: null, rebooted: false };
	}

	// Manual checks reboot only to finish an install; scheduled runs follow the policy.
	const reboot = schedule.reboot === "always" ? !manual || installed !== null : schedule.reboot === "after_update" && installed !== null;
	await save({
		state: "ok",
		finished_at: new Date().toISOString(),
		message: status.message + (reboot ? " Rebooting the container." : ""),
	});
	if (reboot) await o.sys.reboot();
	return { ran: true, installed, rebooted: reboot };
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
		backup: () => run("systemctl", ["start", "ledger-backup.service"]),
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

export const UPDATE_USAGE = `usage:
  ledger update run    check for and install a release if requested or due
                       (run by ledger-update.service as root)`;

export async function runUpdateCommand(args: string[], currentVersion: string, dirs: UpdateDirs): Promise<void> {
	if (args.length !== 1 || args[0] !== "run") throw new Error(UPDATE_USAGE);
	if (process.getuid?.() !== 0) throw new Error("ledger update run must run as root (it is started by ledger-update.service)");
	const repo = process.env.LEDGER_UPDATE_REPO || "mastifdogo/Bookeeping";
	if (!REPO_RE.test(repo)) throw new Error(`LEDGER_UPDATE_REPO must look like owner/name, got ${JSON.stringify(repo)}`);
	const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
	if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
	const cacheDir = process.env.LEDGER_UPDATE_CACHE || "/var/cache/ledger-update";
	await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });
	await fsp.chmod(cacheDir, 0o700);
	await runUpdater({
		dirs,
		cacheDir,
		repo,
		apiBase: process.env.LEDGER_UPDATE_API || "https://api.github.com",
		arch,
		currentVersion,
		sys: systemOps(cacheDir, process.env.HTTP_ADDR || ":8080"),
	});
}
