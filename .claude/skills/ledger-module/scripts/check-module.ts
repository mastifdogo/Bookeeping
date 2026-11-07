// Checks a Ledger module the way Ledger will treat it, then (with a database)
// runs it inside a real Ledger and calls its endpoints.
//
//   node .claude/skills/ledger-module/scripts/check-module.ts <module-dir>
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node .claude/skills/ledger-module/scripts/check-module.ts <module-dir> [--version v0.9.1] [--serve 8099]
//
// --serve keeps the module running afterwards on that port so its UI can be
// opened (e.g. with Playwright): it prints the session cookie to send.
//
// Run from anywhere inside the Ledger checkout; backend dependencies must be
// installed (cd backend && npm ci). Exits non-zero if anything fails.

import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const src = (f: string) => path.join(repo, "backend", "src", f);
const { validateManifest, compatible } = await import(src("modules.ts"));

const args = process.argv.slice(2);
const vi = args.indexOf("--version");
const si = args.indexOf("--serve");
const servePort = si >= 0 ? Number(args[si + 1]) : 0;
const dir = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--version" && args[i - 1] !== "--serve")[0];
// Default: the checkout's latest release tag ("dev" accepts any "ledger" requirement).
const ledgerVersion =
	vi >= 0
		? args[vi + 1]!
		: (() => {
				try {
					return execFileSync("git", ["-C", repo, "describe", "--tags", "--abbrev=0"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
				} catch {
					return "dev";
				}
			})();
if (!dir) {
	console.error("usage: check-module.ts <module-dir> [--version vX.Y.Z]");
	process.exit(2);
}
const mdir = path.resolve(dir);

let failures = 0;
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const fail = (msg: string) => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const warn = (msg: string) => console.log(`  warn  ${msg}`);
const exists = async (p: string, kind: "file" | "dir") => {
	const s = await stat(p).catch(() => null);
	return kind === "file" ? !!s?.isFile() : !!s?.isDirectory();
};

console.log(`Checking ${mdir} (against Ledger ${ledgerVersion})`);

// 1. The manifest, exactly as Ledger validates it.
let m: any;
try {
	m = validateManifest(JSON.parse(await readFile(path.join(mdir, "ledger-module.json"), "utf8")));
	ok(`ledger-module.json: ${m.id} ${m.version}`);
} catch (e: any) {
	fail(`ledger-module.json: ${e.message}${e.details ? " " + JSON.stringify(e.details) : ""}`);
	process.exit(1);
}
if (!m.ledger) warn('no "ledger" minimum version; set one (e.g. ">=0.9.1") so older Ledgers refuse it cleanly');
if (!compatible(m, ledgerVersion)) warn(`needs Ledger ${m.ledger}; checking against ${ledgerVersion} anyway`);

// 2. Referenced files.
if (m.server) {
	const f = path.join(mdir, m.server);
	if (!(await exists(f, "file"))) fail(`server file ${m.server} is missing`);
	else {
		try {
			execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
			ok(`${m.server} parses`);
		} catch (e: any) {
			fail(`${m.server} has a syntax error:\n${String(e.stderr).trim()}`);
		}
		// Only Node built-ins exist at runtime: no npm install happens.
		const code = await readFile(f, "utf8");
		const specs = [...code.matchAll(/(?:^|[^\w.])(?:import\s[^"'`]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!);
		const bad = specs.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && !s.startsWith("../"));
		if (bad.length) fail(`${m.server} imports packages that won't be installed: ${bad.join(", ")} (use node:* built-ins or bundle them into the repo)`);
		if (/innerHTML\s*=/.test(code)) warn(`${m.server} assigns innerHTML`);
	}
}
if (m.ui) {
	if (!(await exists(path.join(mdir, m.ui, "index.html"), "file"))) fail(`${m.ui}/index.html is missing`);
	else ok(`${m.ui}/index.html exists`);
	for (const f of await readdir(path.join(mdir, m.ui), { recursive: true }).catch(() => [] as string[])) {
		if (!String(f).endsWith(".html")) continue;
		const html = await readFile(path.join(mdir, m.ui, String(f)), "utf8");
		if (/<script[^>]+src=["']https?:/i.test(html) || /<link[^>]+href=["']https?:/i.test(html)) warn(`${m.ui}/${f} loads files from the internet; keep the UI self-contained`);
		// The page plus the local stylesheets and scripts it loads (<link href="app.css">, <script src="app.js">).
		const local = async (re: RegExp) => {
			let text = "";
			for (const [, ref] of html.matchAll(re)) {
				if (/^[a-z]+:|^\/\//i.test(ref!)) continue;
				text += await readFile(path.join(mdir, m.ui!, path.dirname(String(f)), ref!.split(/[?#]/)[0]!), "utf8").catch(() => "");
			}
			return text;
		};
		const css = html + (await local(/<link[^>]+href=["']([^"']+\.css)[^"']*["']/gi));
		const js = html + (await local(/<script[^>]+src=["']([^"']+)["']/gi));
		if (/\.innerHTML\s*=/.test(js)) warn(`${m.ui}/${f} (or a script it loads) assigns innerHTML; use textContent for data`);
		if (!/prefers-color-scheme:\s*dark/.test(css)) warn(`${m.ui}/${f} has no dark mode (prefers-color-scheme)`);
	}
}
if (m.nav?.icon_file && !(await exists(path.join(mdir, m.ui, m.nav.icon_file), "file"))) fail(`icon file ${m.ui}/${m.nav.icon_file} is missing`);
if (m.settings?.page && !(await exists(path.join(mdir, m.ui, m.settings.page), "file"))) fail(`settings page ${m.ui}/${m.settings.page} is missing`);
let migrations: string[] = [];
if (m.migrations) {
	const all = await readdir(path.join(mdir, m.migrations)).catch(() => null);
	if (!all) fail(`migrations directory ${m.migrations} is missing`);
	else {
		migrations = all.filter((f) => f.endsWith(".sql")).sort();
		for (const f of migrations) {
			if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(f)) fail(`migration ${f} must be named NNN_name.sql`);
			// Comments removed, so notes like "no GRANT needed" don't count.
			const sql = (await readFile(path.join(mdir, m.migrations, f), "utf8")).replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
			if (/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(sql)) fail(`${f}: no BEGIN/COMMIT (each migration already runs in a transaction)`);
			if (/\bCREATE\s+SCHEMA\b|\bGRANT\b|\bSET\s+search_path\b/i.test(sql)) fail(`${f}: no CREATE SCHEMA, GRANT or SET search_path (Ledger does those)`);
			if (/\bpublic\./i.test(sql)) fail(`${f}: don't touch Ledger's tables (public.*)`);
		}
		ok(`${migrations.length} migration(s)`);
	}
}

// 3. Run it inside Ledger.
const adminURL = process.env.TEST_DATABASE_URL;
if (!adminURL) {
	warn("TEST_DATABASE_URL not set: skipped running the module inside Ledger");
} else {
	console.log("Running inside Ledger");
	const pg = (await import(path.join(repo, "backend", "node_modules", "pg", "lib", "index.js"))).default;
	const { connectDB } = await import(src("db.ts"));
	const { newApp } = await import(src("app.ts"));
	const { createHandler } = await import(src("http.ts"));
	const { createUser, login, SESSION_COOKIE } = await import(src("auth.ts"));
	const { ModuleHost } = await import(src("module-host.ts"));
	// Ledger's request log is noise here; keep the module's own lines and all errors.
	const { log } = await import(src("log.ts"));
	for (const level of ["info", "warn", "error"] as const) {
		log[level] = (msg: string, attrs: Record<string, unknown> = {}) => {
			if (level === "info" && attrs.module === undefined) return;
			if (msg === "module loaded") return;
			console.log(`        [${level}] ${msg} ${JSON.stringify(attrs)}`);
		};
	}

	const admin = new pg.Client({ connectionString: adminURL });
	await admin.connect();
	const dbName = `ledger_modcheck_${process.pid}`;
	await admin.query(`CREATE DATABASE ${dbName}`);
	const url = new URL(adminURL);
	url.pathname = "/" + dbName;
	const db = await connectDB({ databaseUrl: url.toString(), dbMaxConns: 4 });
	const work = await mkdtemp(path.join(tmpdir(), "ledger-modcheck-"));
	const server = createServer();
	try {
		await db.query(await readFile(path.join(repo, "db", "schema.sql"), "utf8"));
		for (const f of (await readdir(path.join(repo, "db", "migrations"))).filter((f) => f.endsWith(".sql")).sort()) {
			await db.query(await readFile(path.join(repo, "db", "migrations", f), "utf8"));
		}
		// The module's migrations, in its own schema, as the installer applies them.
		const schema = "mod_" + m.id.replaceAll("-", "_");
		await db.query(`CREATE SCHEMA ${schema}`);
		for (const f of migrations) {
			try {
				await db.query(`BEGIN; SET LOCAL search_path = ${schema}; ${await readFile(path.join(mdir, m.migrations, f), "utf8")}\n; COMMIT;`);
				ok(`migration ${f} applies`);
			} catch (e: any) {
				await db.query("ROLLBACK").catch(() => {});
				fail(`migration ${f}: ${e.message}`);
			}
		}
		await cp(mdir, path.join(work, "modules", m.id), { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) && !s.includes("node_modules") });
		const app = newApp(db, { csvDir: work, cookieSecure: "auto", webDir: path.join(repo, "frontend", "build"), version: ledgerVersion });
		app.modules = new ModuleHost(path.join(work, "modules"));
		await app.modules.loadAll(app);
		const loaded = app.modules.modules.get(m.id);
		if (!loaded || loaded.error) fail(`register(ctx) failed: ${loaded?.error ?? "not loaded"}`);
		else ok(`loaded; routes: ${loaded.routes.map((r: any) => `${r.method} /${r.segments.join("/")}`).join(", ") || "none"}`);

		await createUser(app, "checker", "check-password-1");
		const { token } = await login(app, "checker", "check-password-1");
		server.on("request", createHandler(app));
		await new Promise<void>((r) => server.listen(servePort, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		const call = (method: string, p: string, body?: unknown) =>
			new Promise<{ status: number; text: string }>((resolve, reject) => {
				const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port,
						method,
						path: p,
						headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
					},
					(res) => {
						let t = "";
						res.on("data", (c) => (t += c));
						res.on("end", () => resolve({ status: res.statusCode!, text: t }));
					},
				);
				req.on("error", reject);
				req.end(payload);
			});

		if (loaded && !loaded.error) {
			// Every GET route without parameters must answer without a server error.
			for (const r of loaded.routes.filter((r: any) => r.method === "GET" && !r.segments.some((s: string) => s.startsWith(":")))) {
				const p = `/api/v1/m/${m.id}/${r.segments.join("/")}`;
				const res = await call("GET", p);
				if (res.status >= 500) fail(`GET ${p} → ${res.status} ${res.text.slice(0, 200)}`);
				else ok(`GET ${p} → ${res.status}`);
			}
			// An empty POST must be refused cleanly (4xx), not crash.
			for (const r of loaded.routes.filter((r: any) => r.method === "POST" && !r.segments.some((s: string) => s.startsWith(":")))) {
				const p = `/api/v1/m/${m.id}/${r.segments.join("/")}`;
				const res = await call("POST", p, {});
				if (res.status >= 500) fail(`POST ${p} with {} → ${res.status} (validate input and answer 4xx) ${res.text.slice(0, 200)}`);
				else ok(`POST ${p} with {} → ${res.status}`);
			}
			if (m.ui) {
				const res = await call("GET", `/m/${m.id}/`);
				if (res.status !== 200) fail(`GET /m/${m.id}/ → ${res.status}`);
				else ok(`UI served at /m/${m.id}/`);
			}
			if (m.settings) {
				const res = await call("GET", `/api/v1/modules/${m.id}/settings`);
				if (res.status !== 200) fail(`settings → ${res.status} ${res.text.slice(0, 200)}`);
				else ok(`settings form: ${JSON.parse(res.text).fields.length} field(s)`);
			}
			const nav = app.modules.nav().find((n: any) => n.id === m.id);
			if (m.nav) ok(`sidebar entry "${nav?.label}" (${nav?.icon_path ? "drawn icon" : nav?.icon_url ? "file icon" : (nav?.icon ?? "generic icon")})`);
		}
		if (servePort) {
			console.log(`\nServing http://127.0.0.1:${servePort}/m/${m.id}/ (API under /api/v1/m/${m.id}/)`);
			console.log(`Send the cookie ${SESSION_COOKIE}=${token} (user "checker"). Ctrl-C to stop.`);
			console.log(failures ? `${failures} problem(s) found above.` : "All checks passed.");
			await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()).once("SIGTERM", () => resolve()));
		}
	} finally {
		await new Promise((r) => (server.listening ? server.close(r) : r(undefined)));
		await db.end();
		await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
		await admin.end();
		await rm(work, { recursive: true, force: true });
	}
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
