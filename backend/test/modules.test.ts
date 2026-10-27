import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatible, normalizeRepo, scanInstalled, validateDesired, validateManifest, writeDesired } from "../src/modules.ts";
import { syncModules, type ModuleOps } from "../src/module-installer.ts";
import { fakeGitHub } from "./fake-github.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const HELLO = path.join(repoRoot, "examples", "modules", "hello");

test("the example module's manifest is valid", async () => {
	const m = validateManifest(JSON.parse(await readFile(path.join(HELLO, "ledger-module.json"), "utf8")));
	assert.equal(m.id, "hello");
	assert.equal(m.nav!.label, "Hello");
	assert.match(m.nav!.icon_path!, /^M4 5h16/);
});

test("nav icons", () => {
	const base = { id: "sales", name: "Sales", version: "0.1.0", ui: "ui" };
	const nav = (icon: unknown) => validateManifest({ ...base, nav: { label: "Sales", icon } }).nav;
	const none = { label: "Sales", icon: null, icon_path: null, icon_fill: false, icon_file: null };
	assert.deepEqual(nav("hammer"), { ...none, icon: "hammer" });
	// Names from newer Ledger versions are accepted (and shown as the generic icon).
	assert.deepEqual(nav("rocket-ship"), { ...none, icon: "rocket-ship" });
	assert.deepEqual(validateManifest({ ...base, nav: { label: "Sales" } }).nav, none);
	// Drawn: a 24x24 path, stroked or filled.
	assert.deepEqual(nav({ path: "M4 4h16v16H4z" }), { ...none, icon_path: "M4 4h16v16H4z" });
	assert.deepEqual(nav({ path: "m12 2 3 7h7l-6 5 2 8-6-5-6 5 2-8-6-5h7z", fill: true }), {
		...none,
		icon_path: "m12 2 3 7h7l-6 5 2 8-6-5-6 5 2-8-6-5h7z",
		icon_fill: true,
	});
	// From a file in ui/.
	assert.deepEqual(nav({ file: "img/icon.svg" }), { ...none, icon_file: "img/icon.svg" });
	for (const bad of [
		{ path: "<script>" },
		{ path: "M1 1\" onload=\"x" },
		{ path: "" },
		{ path: "M1 1", file: "a.svg" },
		{ file: "icon.png" },
		{ file: "../icon.svg" },
		{ file: "a.svg", fill: true },
		{ path: "M1 1", colour: "red" },
		"Not A Name",
		42,
	]) {
		assert.throws(() => nav(bad), /validation failed/, JSON.stringify(bad));
	}
	assert.throws(() => validateManifest({ ...base, ui: undefined, nav: { label: "Sales" } }), /validation failed/);
});

test("validateManifest rejects bad manifests", () => {
	const ok = { id: "budget", name: "Budget", version: "1.0.0" };
	assert.equal(validateManifest(ok).server, null);
	for (const bad of [
		{ ...ok, id: "Budget" },
		{ ...ok, id: "x" },
		{ ...ok, id: "../etc" },
		{ ...ok, version: "latest" },
		{ ...ok, server: "../../etc/passwd" },
		{ ...ok, server: "/abs.mjs" },
		{ ...ok, ui: ".hidden" },
		{ ...ok, nav: { label: "Budget" } }, // nav needs ui
		{ ...ok, ui: "ui", nav: { label: "Budget", icon: "Bad Icon" } },
		{ ...ok, ui: "ui", nav: { label: "Budget", icon: 3 } },
		{ ...ok, ui: "ui", nav: { label: "Budget", colour: "red" } },
		{ ...ok, ledger: "^1.0.0" },
		{ ...ok, extra: true },
		{ name: "No id", version: "1.0.0" },
	]) {
		assert.throws(() => validateManifest(bad), Error, JSON.stringify(bad));
	}
});

test("normalizeRepo and compatible", () => {
	assert.equal(normalizeRepo("someone/ledger-invoicing"), "someone/ledger-invoicing");
	assert.equal(normalizeRepo("https://github.com/someone/ledger-invoicing"), "someone/ledger-invoicing");
	assert.equal(normalizeRepo("https://github.com/someone/ledger-invoicing.git"), "someone/ledger-invoicing");
	assert.equal(normalizeRepo("github.com/someone/repo/"), "someone/repo");
	assert.equal(normalizeRepo("https://evil.example/someone/repo"), null);
	assert.equal(normalizeRepo("not a repo"), null);
	const m = validateManifest({ id: "budget", name: "Budget", version: "1.0.0", ledger: ">=0.6.0" });
	assert.equal(compatible(m, "v0.6.0"), true);
	assert.equal(compatible(m, "v0.7.1"), true);
	assert.equal(compatible(m, "v0.5.0"), false);
	assert.equal(compatible(m, "dev"), true);
	assert.throws(() => validateDesired([{ repo: "x" }]));
	assert.deepEqual(validateDesired([{ repo: "o/r", id: null }]), [{ repo: "o/r", id: null }]);
});

function fakeOps() {
	const applied = new Map<string, string[]>();
	const calls: string[] = [];
	const ops: ModuleOps & { healthyResult: boolean; calls: string[]; applied: Map<string, string[]> } = {
		healthyResult: true,
		calls,
		applied,
		appliedMigrations: async (id) => new Set(applied.get(id) ?? []),
		applyMigrations: async (id, files) => {
			calls.push(`migrate ${id} ${files.map((f) => f.name).join(",")}`);
			applied.set(id, [...(applied.get(id) ?? []), ...files.map((f) => f.name)]);
		},
		restart: async () => void calls.push("restart"),
		healthy: async () => ops.healthyResult,
	};
	return ops;
}

test("scanInstalled follows a symlinked module directory", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-mods-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const modulesDir = path.join(root, "modules");
	await mkdir(modulesDir);
	await symlink(HELLO, path.join(modulesDir, "hello"), "dir");
	// A link to a file is not a module.
	await writeFile(path.join(root, "file"), "");
	await symlink(path.join(root, "file"), path.join(modulesDir, "notadir"));
	const installed = await scanInstalled(modulesDir);
	assert.deepEqual(installed.map((i) => i.manifest.id), ["hello"]);
	assert.equal(installed[0]!.dir, path.join(modulesDir, "hello"));
});

async function world(t: import("node:test").TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-mods-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dirs = { config: path.join(root, "config"), status: path.join(root, "status") };
	for (const d of [dirs.config, dirs.status]) await mkdir(d);
	const gh = await fakeGitHub(t);
	const ops = fakeOps();
	const opts = { dirs, modulesDir: path.join(root, "modules"), cacheDir: path.join(root, "cache"), apiBase: gh.base, ledgerVersion: "v0.10.0", ops };
	return { root, dirs, gh, ops, opts };
}

test("syncModules installs, updates and removes", async (t) => {
	const { dirs, gh, ops, opts } = await world(t);
	await gh.publish("o/hello", "v1.0.0", HELLO);
	await writeDesired(dirs, [{ repo: "o/hello", id: "hello" }]);

	let r = await syncModules(opts);
	assert.equal(r.changed, true);
	assert.equal(r.results[0]!.state, "installed", r.results[0]!.message);
	assert.deepEqual(ops.calls, ["migrate hello 001_notes.sql", "restart"]);
	let installed = await scanInstalled(opts.modulesDir);
	assert.equal(installed.length, 1);
	assert.equal(installed[0]!.source?.repo, "o/hello");
	assert.equal(installed[0]!.source?.tag, "v1.0.0");
	assert.ok((await stat(path.join(opts.modulesDir, "hello", "ui", "index.html"))).isFile());

	// Nothing new: nothing happens.
	ops.calls.length = 0;
	r = await syncModules(opts);
	assert.equal(r.changed, false);
	assert.equal(r.results[0]!.state, "unchanged");
	assert.deepEqual(ops.calls, []);

	// A new release with a second migration applies only that one.
	await gh.publish("o/hello", "v1.1.0", HELLO, async (stage) => {
		await writeFile(path.join(stage, "migrations", "002_more.sql"), "ALTER TABLE notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;");
		const m = JSON.parse(await readFile(path.join(stage, "ledger-module.json"), "utf8"));
		await writeFile(path.join(stage, "ledger-module.json"), JSON.stringify({ ...m, version: "1.4.0" }));
	});
	r = await syncModules(opts);
	assert.equal(r.results[0]!.state, "updated");
	assert.deepEqual(ops.calls, ["migrate hello 002_more.sql", "restart"]);
	installed = await scanInstalled(opts.modulesDir);
	assert.equal(installed[0]!.manifest.version, "1.4.0");

	// Taken off the list: removed (no hidden leftovers).
	ops.calls.length = 0;
	await writeDesired(dirs, []);
	r = await syncModules(opts);
	assert.equal(r.results[0]!.state, "removed");
	assert.deepEqual(await readdir(opts.modulesDir), []);
	const status = JSON.parse(await readFile(path.join(dirs.status, "modules.json"), "utf8"));
	assert.equal(status[0].state, "removed");
});

test("syncModules undoes a change Ledger cannot start with", async (t) => {
	const { dirs, gh, ops, opts } = await world(t);
	await gh.publish("o/hello", "v1.0.0", HELLO);
	await writeDesired(dirs, [{ repo: "o/hello", id: "hello" }]);
	await syncModules(opts);
	await gh.publish("o/hello", "v2.0.0", HELLO, async (stage) => {
		const m = JSON.parse(await readFile(path.join(stage, "ledger-module.json"), "utf8"));
		await writeFile(path.join(stage, "ledger-module.json"), JSON.stringify({ ...m, version: "2.0.0" }));
	});
	ops.healthyResult = false;
	ops.calls.length = 0;
	const r = await syncModules(opts);
	assert.equal(r.results[0]!.state, "error");
	assert.match(r.results[0]!.message, /undone/);
	assert.deepEqual(ops.calls, ["restart", "restart"]);
	const installed = await scanInstalled(opts.modulesDir);
	assert.equal(installed[0]!.manifest.version, "1.3.0"); // the previous copy (the example as published) is back
	assert.equal(installed[0]!.source?.tag, "v1.0.0");
});

test("syncModules refuses bad releases", async (t) => {
	const { dirs, gh, ops, opts } = await world(t);
	// Missing server file.
	await gh.publish("o/broken", "v1.0.0", HELLO, async (stage) => {
		await rm(path.join(stage, "server.mjs"));
	});
	// Incompatible with this Ledger.
	await gh.publish("o/future", "v1.0.0", HELLO, async (stage) => {
		const m = JSON.parse(await readFile(path.join(stage, "ledger-module.json"), "utf8"));
		await writeFile(path.join(stage, "ledger-module.json"), JSON.stringify({ ...m, id: "future", ledger: ">=9.0.0" }));
	});
	await writeDesired(dirs, [
		{ repo: "o/broken", id: "hello" },
		{ repo: "o/future", id: "future" },
		{ repo: "o/missing", id: null },
	]);
	const r = await syncModules(opts);
	assert.equal(r.changed, false);
	assert.deepEqual(
		r.results.map((x) => x.state),
		["error", "error", "error"],
	);
	assert.match(r.results[0]!.message, /server file server\.mjs is missing/);
	assert.match(r.results[1]!.message, /needs Ledger >=9\.0\.0/);
	assert.match(r.results[2]!.message, /not found on GitHub/);
	assert.deepEqual(ops.calls, []);
	assert.deepEqual((await readdir(opts.modulesDir)).filter((n) => !n.startsWith(".")), []);
});

test("two repositories cannot install the same module id", async (t) => {
	const { dirs, gh, opts } = await world(t);
	await gh.publish("o/hello", "v1.0.0", HELLO);
	await gh.publish("x/hello-copy", "v1.0.0", HELLO);
	await writeDesired(dirs, [{ repo: "o/hello", id: "hello" }]);
	await syncModules(opts);
	await writeDesired(dirs, [
		{ repo: "o/hello", id: "hello" },
		{ repo: "x/hello-copy", id: "hello" },
	]);
	const r = await syncModules(opts);
	assert.equal(r.results[1]!.state, "error");
	assert.match(r.results[1]!.message, /already used by o\/hello/);
});

test("manifest settings are validated", () => {
	const base = { id: "llm", name: "LLM", version: "1.0.0" };
	const m = validateManifest({
		...base,
		ui: "ui",
		settings: {
			page: "settings.html",
			fields: [
				{ key: "api_key", label: "API key", type: "secret", required: true },
				{ key: "model", type: "select", options: ["a", { value: "b", label: "Bee" }], default: "b" },
				{ key: "temp", type: "number", min: 0, max: 2, default: 0.7 },
				{ key: "notes", type: "textarea" },
			],
		},
	});
	assert.equal(m.settings!.page, "settings.html");
	assert.deepEqual(
		m.settings!.fields.map((f) => [f.key, f.type, f.default]),
		[
			["api_key", "secret", null],
			["model", "select", "b"],
			["temp", "number", 0.7],
			["notes", "textarea", null],
		],
	);
	assert.equal(validateManifest(base).settings, null);
	for (const settings of [
		{ fields: [{ key: "Bad Key" }] },
		{ fields: [{ key: "a" }, { key: "a" }] },
		{ fields: [{ key: "a", type: "colour" }] },
		{ fields: [{ key: "a", type: "select" }] },
		{ fields: [{ key: "a", type: "select", options: ["x"], default: "y" }] },
		{ fields: [{ key: "a", type: "number", min: 5, default: 1 }] },
		{ fields: [{ key: "a", type: "secret", default: "sk" }] },
		{ fields: [{ key: "a", min: 1 }] },
		{ fields: [{ key: "a", extra: 1 }] },
		{ page: "settings.html" }, // needs ui
		{ page: "../x.html" },
		"nope",
	]) {
		assert.throws(() => validateManifest({ ...base, settings }), /validation failed/, JSON.stringify(settings));
	}
});
