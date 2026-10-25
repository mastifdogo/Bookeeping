import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
	DEFAULT_SCHEDULE,
	dueSlot,
	isNewer,
	lastScheduledTime,
	nextScheduledTime,
	readStatus,
	validateSchedule,
	writeSchedule,
	type UpdateSchedule,
} from "../src/update.ts";
import { runUpdater, type SystemOps } from "../src/updater.ts";

const sched = (over: Partial<UpdateSchedule> = {}): UpdateSchedule => ({ ...DEFAULT_SCHEDULE, enabled: true, ...over });

test("validateSchedule", () => {
	assert.deepEqual(validateSchedule({ enabled: true, days: [3, 1], time: "23:59", timezone: "America/Winnipeg", reboot: "after_update" }), {
		enabled: true,
		days: [1, 3],
		time: "23:59",
		timezone: "America/Winnipeg",
		reboot: "after_update",
	});
	for (const bad of [
		{ ...DEFAULT_SCHEDULE, days: [] },
		{ ...DEFAULT_SCHEDULE, days: [7] },
		{ ...DEFAULT_SCHEDULE, days: [1, 1] },
		{ ...DEFAULT_SCHEDULE, days: [1.5] },
		{ ...DEFAULT_SCHEDULE, time: "24:00" },
		{ ...DEFAULT_SCHEDULE, time: "3:30" },
		{ ...DEFAULT_SCHEDULE, timezone: "Mars/Olympus" },
		{ ...DEFAULT_SCHEDULE, timezone: "../../etc" },
		{ ...DEFAULT_SCHEDULE, reboot: "sometimes" },
		{ ...DEFAULT_SCHEDULE, enabled: "yes" },
		{ ...DEFAULT_SCHEDULE, extra: 1 },
		null,
	]) {
		assert.throws(() => validateSchedule(bad), Error, JSON.stringify(bad));
	}
});

test("isNewer", () => {
	assert.equal(isNewer("v0.6.0", "v0.5.9"), true);
	assert.equal(isNewer("v0.10.0", "v0.9.0"), true);
	assert.equal(isNewer("v0.6.0", "v0.6.0"), false);
	assert.equal(isNewer("v0.5.0", "v0.6.0"), false);
	assert.equal(isNewer("v0.6.0", "v0.6.0-rc.1"), true);
	assert.equal(isNewer("v0.6.0-rc.1", "v0.6.0"), false);
	assert.equal(isNewer("v0.6.0", "dev"), true); // unknown installed version
	assert.equal(isNewer("v0.6.0", "v0.5.0-3-gabc123"), true);
	assert.equal(isNewer("garbage", "v0.1.0"), false);
});

test("schedule slots honour the time zone and DST", () => {
	// Winnipeg is UTC-5 in summer (CDT) and UTC-6 in winter (CST).
	const s = sched({ days: [0], time: "03:30", timezone: "America/Winnipeg" }); // Sundays 03:30
	// Saturday 2026-10-24 12:00 UTC -> previous slot Sunday 2026-10-18 03:30 CDT = 08:30 UTC.
	assert.equal(new Date(lastScheduledTime(s, Date.parse("2026-10-24T12:00:00Z"))!).toISOString(), "2026-10-18T08:30:00.000Z");
	assert.equal(new Date(nextScheduledTime(s, Date.parse("2026-10-24T12:00:00Z"))!).toISOString(), "2026-10-25T08:30:00.000Z");
	// After DST ends (2026-11-01), 03:30 CST = 09:30 UTC.
	assert.equal(new Date(nextScheduledTime(s, Date.parse("2026-11-03T00:00:00Z"))!).toISOString(), "2026-11-08T09:30:00.000Z");
	assert.equal(nextScheduledTime({ ...s, enabled: false }, Date.now()), null);
});

test("dueSlot runs each slot once, within the catch-up window", () => {
	const s = sched({ days: [0, 1, 2, 3, 4, 5, 6], time: "03:00", timezone: "UTC" });
	const slot = Date.parse("2026-10-24T03:00:00Z");
	assert.equal(dueSlot(s, slot - 60_000, null), null); // yesterday's slot is past the catch-up window
	assert.equal(dueSlot(s, slot + 60_000, null), slot);
	assert.equal(dueSlot(s, slot + 60_000, new Date(slot).toISOString()), null); // already ran
	assert.equal(dueSlot(s, slot + 5 * 3600_000, "2026-10-23T03:00:00.000Z"), slot); // late but in the window
	assert.equal(dueSlot(s, slot + 7 * 3600_000, "2026-10-23T03:00:00.000Z"), null); // missed: wait for the next one
	assert.equal(dueSlot({ ...s, enabled: false }, slot + 60_000, null), null);
});

// ---------------------------------------------------------------------------
// The updater against a fake GitHub
// ---------------------------------------------------------------------------

interface Fake {
	dirs: { config: string; status: string };
	cacheDir: string;
	apiBase: string;
	calls: string[];
	sys: SystemOps;
	setLatest(tag: string, opts?: { corrupt?: boolean }): Promise<void>;
	healthy: boolean;
}

async function fakeWorld(t: import("node:test").TestContext): Promise<Fake> {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-update-"));
	const dirs = { config: path.join(root, "config"), status: path.join(root, "status") };
	const cacheDir = path.join(root, "cache");
	const assets = path.join(root, "assets");
	for (const d of [dirs.config, dirs.status, cacheDir, assets]) await mkdir(d, { recursive: true });
	let release: object = {};
	const server: Server = createServer(async (req, res) => {
		if (req.url === "/repos/o/r/releases/latest") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(release));
			return;
		}
		const file = path.join(assets, path.basename(req.url ?? ""));
		try {
			res.writeHead(200);
			res.end(await readFile(file));
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(async () => {
		await new Promise((r) => server.close(r));
		await rm(root, { recursive: true, force: true });
	});

	const fake: Fake = {
		dirs,
		cacheDir,
		apiBase: base,
		calls: [],
		healthy: true,
		sys: {
			backup: async () => void fake.calls.push("backup"),
			snapshot: async () => void fake.calls.push("snapshot"),
			install: async (dir) => {
				await access(path.join(dir, "deploy", "install.sh"));
				fake.calls.push("install " + path.basename(dir));
			},
			restart: async () => void fake.calls.push("restart"),
			healthy: async () => (fake.calls.push("health"), fake.healthy),
			rollback: async () => void fake.calls.push("rollback"),
			reboot: async () => void fake.calls.push("reboot"),
		},
		async setLatest(tag, opts = {}) {
			const name = `ledger-${tag}-linux-amd64`;
			const stage = path.join(root, "stage", name);
			for (const d of ["bin", "lib/ledger", "deploy"]) await mkdir(path.join(stage, d), { recursive: true });
			for (const f of ["bin/ledger", "lib/ledger/ledger.mjs", "lib/ledger/node", "deploy/install.sh"]) await writeFile(path.join(stage, f), "x");
			execFileSync("tar", ["-czf", path.join(assets, `${name}.tar.gz`), "-C", path.join(root, "stage"), name]);
			const sum = createHash("sha256").update(await readFile(path.join(assets, `${name}.tar.gz`))).digest("hex");
			await writeFile(path.join(assets, "SHA256SUMS"), `${opts.corrupt ? "0".repeat(64) : sum}  ${name}.tar.gz\n`);
			release = {
				tag_name: tag,
				assets: [
					{ name: `${name}.tar.gz`, browser_download_url: `${base}/${name}.tar.gz` },
					{ name: "SHA256SUMS", browser_download_url: `${base}/SHA256SUMS` },
				],
			};
		},
	};
	return fake;
}

const opts = (f: Fake, currentVersion: string, now: number) => ({
	dirs: f.dirs,
	cacheDir: f.cacheDir,
	repo: "o/r",
	apiBase: f.apiBase,
	arch: "amd64",
	currentVersion,
	now: () => now,
	sys: f.sys,
});

test("updater: nothing due, nothing done", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.7.0");
	const out = await runUpdater(opts(f, "v0.6.0", Date.now()));
	assert.equal(out.ran, false);
	assert.deepEqual(f.calls, []);
	assert.equal(await readStatus(f.dirs), null);
});

test("updater: scheduled run installs, then reboots", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.7.0");
	const s = sched({ days: [0, 1, 2, 3, 4, 5, 6], time: "03:00", timezone: "UTC", reboot: "always" });
	await writeSchedule(f.dirs, s);
	const now = Date.parse("2026-10-24T03:02:00Z");
	const out = await runUpdater(opts(f, "v0.6.0", now));
	assert.deepEqual(out, { ran: true, installed: "v0.7.0", rebooted: true });
	assert.deepEqual(f.calls, ["backup", "snapshot", "install ledger-v0.7.0-linux-amd64", "restart", "health", "reboot"]);
	const st = (await readStatus(f.dirs))!;
	assert.equal(st.state, "ok");
	assert.equal(st.installed_version, "v0.7.0");
	// status.json takes the status directory's group, so the app can read it.
	assert.equal((await stat(path.join(f.dirs.status, "status.json"))).gid, (await stat(f.dirs.status)).gid);
	assert.equal(st.last_scheduled_for, "2026-10-24T03:00:00.000Z");
	// The same slot does not run twice.
	f.calls.length = 0;
	assert.equal((await runUpdater(opts(f, "v0.7.0", now + 5 * 60_000))).ran, false);
});

test("updater: up to date; reboot policy decides", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.6.0");
	const s = sched({ days: [6], time: "03:00", timezone: "UTC", reboot: "after_update" });
	await writeSchedule(f.dirs, s);
	let out = await runUpdater(opts(f, "v0.6.0", Date.parse("2026-10-24T03:01:00Z"))); // a Saturday
	assert.deepEqual(out, { ran: true, installed: null, rebooted: false });
	assert.match((await readStatus(f.dirs))!.message, /Up to date/);

	await writeSchedule(f.dirs, { ...s, reboot: "always" });
	out = await runUpdater(opts(f, "v0.6.0", Date.parse("2026-10-31T03:01:00Z")));
	assert.deepEqual(out, { ran: true, installed: null, rebooted: true });

	// A manual check does not reboot when nothing was installed, even with "always".
	f.calls.length = 0;
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	out = await runUpdater(opts(f, "v0.6.0", Date.parse("2026-11-01T12:00:00Z")));
	assert.deepEqual(out, { ran: true, installed: null, rebooted: false });
	await assert.rejects(access(path.join(f.dirs.config, "run-now")), Error, "request file removed");
	assert.equal((await readStatus(f.dirs))!.trigger, "manual");
});

test("updater: bad checksum installs nothing", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.7.0", { corrupt: true });
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	const out = await runUpdater(opts(f, "v0.6.0", Date.now()));
	assert.deepEqual(out, { ran: true, installed: null, rebooted: false });
	assert.deepEqual(f.calls, []);
	const st = (await readStatus(f.dirs))!;
	assert.equal(st.state, "error");
	assert.match(st.message, /checksum mismatch/);
});

test("updater: a release that fails its health check is rolled back", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.7.0");
	f.healthy = false;
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	const out = await runUpdater(opts(f, "v0.6.0", Date.now()));
	assert.deepEqual(out, { ran: true, installed: null, rebooted: false });
	assert.deepEqual(f.calls, ["backup", "snapshot", "install ledger-v0.7.0-linux-amd64", "restart", "health", "rollback", "restart"]);
	assert.match((await readStatus(f.dirs))!.message, /did not start correctly; restored v0.6.0/);
});

test("updater: an invalid schedule file is ignored", async (t) => {
	const f = await fakeWorld(t);
	await f.setLatest("v0.7.0");
	await writeFile(path.join(f.dirs.config, "schedule.json"), '{"enabled":true,"days":[0,1,2,3,4,5,6],"time":"03:00","timezone":"$(reboot)","reboot":"always"}');
	const out = await runUpdater(opts(f, "v0.6.0", Date.parse("2026-10-24T03:01:00Z")));
	assert.equal(out.ran, false);
});

test("updater: posts the outcome to the dashboard", async (t) => {
	const f = await fakeWorld(t);
	const notices: { title: string; level: string }[] = [];
	const notify = async (n: { title: string; level: string }) => {
		notices.push({ title: n.title, level: n.level });
	};
	await f.setLatest("v0.7.0");
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	await runUpdater({ ...opts(f, "v0.6.0", Date.now()), notify });
	assert.deepEqual(notices, [{ title: "Ledger updated to v0.7.0", level: "success" }]);

	// Up to date: nothing to say. A failure is posted; a failing notify is ignored.
	notices.length = 0;
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	await runUpdater({ ...opts(f, "v0.7.0", Date.now()), notify });
	assert.deepEqual(notices, []);
	await f.setLatest("v0.8.0", { corrupt: true });
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	await runUpdater({ ...opts(f, "v0.7.0", Date.now()), notify });
	assert.deepEqual(notices, [{ title: "Update failed", level: "danger" }]);
	await writeFile(path.join(f.dirs.config, "run-now"), "x");
	const out = await runUpdater({ ...opts(f, "v0.7.0", Date.now()), notify: () => Promise.reject(new Error("no db")) });
	assert.equal(out.ran, true);
});
