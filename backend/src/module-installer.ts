// Root side of modules: makes /var/lib/ledger/modules match the list of
// modules chosen in the app. For each wanted repository it installs or
// updates to the latest release (source archive), applies new migrations in
// the module's own schema, and removes modules taken off the list. If
// anything changed it restarts Ledger and checks its health; when the
// restart fails, the module directories are put back as they were.
//
// Migrations run as the module's own database role (mod_<id>, which owns
// only schema mod_<id>), connected with a one-off password, never as a
// superuser: a module's SQL cannot reach the ledger's own tables. Removing
// a module keeps its schema and data.

import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { log } from "./log.ts";
import { latestModuleRelease } from "./github.ts";
import {
	MANIFEST_FILE,
	MODULES_STATUS_FILE,
	SOURCE_FILE,
	compatible,
	readDesired,
	scanInstalled,
	validateManifest,
	type ModuleManifest,
	type ModuleResult,
	type ModuleSource,
} from "./modules.ts";
import { writeFileAtomic, type UpdateDirs } from "./update.ts";

const MIGRATION_RE = /^\d+[_-][A-Za-z0-9_.-]*\.sql$/;
const MAX_DOWNLOAD_BYTES = 50 << 20;

export interface ModuleOps {
	/** Names of the migrations already applied for a module. */
	appliedMigrations(id: string): Promise<Set<string>>;
	/** Applies migrations in order in the module's schema, recording each. */
	applyMigrations(id: string, files: { name: string; sql: string }[]): Promise<void>;
	restart(): Promise<void>;
	healthy(): Promise<boolean>;
}

export interface ModuleSyncOptions {
	dirs: UpdateDirs;
	modulesDir: string;
	cacheDir: string;
	apiBase: string;
	ledgerVersion: string;
	ops: ModuleOps;
}

export function schemaFor(id: string): string {
	return `mod_${id.replaceAll("-", "_")}`;
}

function run(cmd: string, args: string[], opts: { input?: string; capture?: boolean } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: [opts.input === undefined ? "ignore" : "pipe", opts.capture ? "pipe" : "inherit", "pipe"] });
		let out = "";
		let errText = "";
		p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		p.stderr?.on("data", (d: Buffer) => (errText += d.toString()));
		p.on("error", reject);
		p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${errText.trim() || `exit ${code}`}`))));
		if (opts.input !== undefined) p.stdin!.end(opts.input);
	});
}

async function download(url: string, file: string): Promise<void> {
	const res = await fetch(url, { headers: { "User-Agent": "ledger" }, redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
	if (!res.ok) throw new Error(`download failed (${res.status})`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`module archive larger than ${MAX_DOWNLOAD_BYTES} bytes`);
	await fsp.writeFile(file, buf, { mode: 0o600 });
}

/** Unpacks a GitHub source archive (one top-level directory) into dest. */
async function unpack(tarball: string, dest: string): Promise<void> {
	const tmp = `${dest}.unpack`;
	await fsp.rm(tmp, { recursive: true, force: true });
	await fsp.mkdir(tmp, { recursive: true, mode: 0o755 });
	await run("tar", ["-xzf", tarball, "-C", tmp, "--no-same-owner", "--no-same-permissions"]);
	const tops = await fsp.readdir(tmp);
	if (tops.length !== 1) throw new Error("the archive must contain exactly one top-level directory");
	await fsp.rename(path.join(tmp, tops[0]!), dest);
	await fsp.rm(tmp, { recursive: true, force: true });
	// Root-owned, read-only for everyone else, no setuid bits or symlinks out.
	await run("chmod", ["-R", "u=rwX,go=rX", dest]);
	await run("find", [dest, "-type", "l", "-delete"]);
}

async function readManifest(dir: string): Promise<ModuleManifest> {
	let text: string;
	try {
		text = await fsp.readFile(path.join(dir, MANIFEST_FILE), "utf8");
	} catch {
		throw new Error(`the release has no ${MANIFEST_FILE}`);
	}
	try {
		return validateManifest(JSON.parse(text));
	} catch (err) {
		throw new Error(`${MANIFEST_FILE} is invalid: ${(err as Error).message.replace(/^validation failed: /, "")}`);
	}
}

async function migrationsOf(dir: string, m: ModuleManifest): Promise<{ name: string; sql: string }[]> {
	if (!m.migrations) return [];
	const mdir = path.join(dir, m.migrations);
	const names = (await fsp.readdir(mdir).catch(() => {
		throw new Error(`migrations directory ${m.migrations} is missing`);
	})).filter((n) => MIGRATION_RE.test(n));
	names.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	return Promise.all(names.map(async (name) => ({ name, sql: await fsp.readFile(path.join(mdir, name), "utf8") })));
}

async function checkFiles(dir: string, m: ModuleManifest): Promise<void> {
	for (const [what, rel] of [
		["server", m.server],
		["ui", m.ui ? path.join(m.ui, "index.html") : null],
	] as const) {
		if (rel && !(await fsp.stat(path.join(dir, rel)).catch(() => null))) throw new Error(`${what} file ${rel} is missing`);
	}
}

interface Change {
	id: string;
	/** Where the previous copy was moved, or null when there was none. */
	backup: string | null;
	installed: boolean;
}

/**
 * Brings installed modules in line with the wanted list. Never throws;
 * returns whether anything changed and the per-module results.
 */
export async function syncModules(o: ModuleSyncOptions): Promise<{ changed: boolean; results: ModuleResult[] }> {
	const now = () => new Date().toISOString();
	const desired = await readDesired(o.dirs);
	const installed = await scanInstalled(o.modulesDir);
	const work = path.join(o.cacheDir, "modules");
	await fsp.mkdir(work, { recursive: true, mode: 0o700 });
	await fsp.mkdir(o.modulesDir, { recursive: true, mode: 0o755 });
	const results: ModuleResult[] = [];
	const changes: Change[] = [];
	const backupOf = (id: string) => path.join(o.modulesDir, `.old-${id}`);

	for (const d of desired) {
		const inst = installed.find((i) => i.source?.repo === d.repo) ?? installed.find((i) => d.id !== null && i.manifest.id === d.id && !i.source);
		const result: ModuleResult = { repo: d.repo, id: inst?.manifest.id ?? d.id, state: "unchanged", version: inst?.manifest.version ?? null, message: "", at: now() };
		results.push(result);
		const stage = path.join(o.modulesDir, `.stage-${d.repo.replace("/", "--")}`);
		try {
			const rel = await latestModuleRelease(o.apiBase, d.repo);
			if (inst?.source?.tag === rel.tag) {
				result.message = `Up to date (${rel.tag}).`;
				continue;
			}
			const tarball = path.join(work, `${d.repo.replace("/", "--")}-${rel.tag}.tar.gz`);
			await download(rel.tarball, tarball);
			await fsp.rm(stage, { recursive: true, force: true });
			await unpack(tarball, stage);
			await fsp.rm(tarball, { force: true });
			const m = await readManifest(stage);
			const other = installed.find((i) => i.manifest.id === m.id && i !== inst);
			if (other) throw new Error(`the id "${m.id}" is already used by ${other.source?.repo ?? "another module"}`);
			if (inst && inst.manifest.id !== m.id) throw new Error(`the module's id changed from "${inst.manifest.id}" to "${m.id}"; remove it and add it again`);
			if (!compatible(m, o.ledgerVersion)) throw new Error(`needs Ledger ${m.ledger} (this is ${o.ledgerVersion})`);
			await checkFiles(stage, m);
			const migrations = await migrationsOf(stage, m);
			const applied = await o.ops.appliedMigrations(m.id);
			const pending = migrations.filter((x) => !applied.has(x.name));
			if (pending.length > 0) await o.ops.applyMigrations(m.id, pending);

			const source: ModuleSource = { repo: d.repo, tag: rel.tag, installed_at: now() };
			await fsp.writeFile(path.join(stage, SOURCE_FILE), JSON.stringify(source, null, 2) + "\n", { mode: 0o644 });
			const target = path.join(o.modulesDir, m.id);
			let backup: string | null = null;
			if (await fsp.stat(target).catch(() => null)) {
				backup = backupOf(m.id);
				await fsp.rm(backup, { recursive: true, force: true });
				await fsp.rename(target, backup);
			}
			await fsp.rename(stage, target);
			changes.push({ id: m.id, backup, installed: true });
			Object.assign(result, {
				id: m.id,
				state: inst ? "updated" : "installed",
				version: m.version,
				message: `${inst ? "Updated" : "Installed"} ${m.name} ${rel.tag}${pending.length ? ` (${pending.length} migration${pending.length > 1 ? "s" : ""})` : ""}.`,
			});
		} catch (err) {
			await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
			Object.assign(result, { state: "error", message: (err as Error).message });
		}
	}

	// Modules taken off the list.
	for (const inst of installed) {
		const wanted = desired.some((d) => inst.source?.repo === d.repo || (d.id !== null && d.id === inst.manifest.id && !inst.source));
		if (wanted) continue;
		const backup = backupOf(inst.manifest.id);
		await fsp.rm(backup, { recursive: true, force: true });
		await fsp.rename(inst.dir, backup);
		changes.push({ id: inst.manifest.id, backup, installed: false });
		results.push({ repo: inst.source?.repo ?? "", id: inst.manifest.id, state: "removed", version: inst.manifest.version, message: `Removed ${inst.manifest.name} (its data was kept).`, at: now() });
	}

	if (changes.length > 0) {
		log.info("modules changed; restarting Ledger", { changes: changes.map((c) => c.id) });
		let ok = false;
		try {
			await o.ops.restart();
			ok = await o.ops.healthy();
		} catch (err) {
			log.error("restart after module changes failed", { err: (err as Error).message });
		}
		if (!ok) {
			for (const c of changes) {
				const target = path.join(o.modulesDir, c.id);
				if (c.installed) await fsp.rm(target, { recursive: true, force: true });
				if (c.backup) await fsp.rename(c.backup, target).catch(() => {});
			}
			await o.ops.restart().catch(() => {});
			for (const r of results) {
				if (r.state === "installed" || r.state === "updated" || r.state === "removed") {
					Object.assign(r, { state: "error", message: `Ledger did not start correctly with this change; it was undone. (${r.message})` });
				}
			}
		} else {
			for (const c of changes) if (c.backup) await fsp.rm(c.backup, { recursive: true, force: true });
		}
	}

	const { gid } = await fsp.stat(o.dirs.status);
	await writeFileAtomic(path.join(o.dirs.status, MODULES_STATUS_FILE), JSON.stringify(results, null, 2) + "\n", 0o640, gid);
	return { changed: changes.length > 0, results };
}

// ---------------------------------------------------------------------------
// The real database operations (run as root inside the container)
// ---------------------------------------------------------------------------

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
const quoteLit = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function moduleOps(databaseUrl: string, base: Pick<ModuleOps, "restart" | "healthy">): ModuleOps {
	const url = new URL(databaseUrl);
	const dbName = decodeURIComponent(url.pathname.slice(1)) || "ledger";
	const appRole = decodeURIComponent(url.username) || "ledger_app";
	// Superuser statements go through the local `postgres` account (peer authentication).
	const asSuperuser = (sql: string, capture = false) =>
		run("runuser", ["-u", "postgres", "--", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", ...(capture ? ["-A", "-t"] : []), "-d", dbName], { input: sql, capture });
	const bootstrap = `
		CREATE SCHEMA IF NOT EXISTS ledger_modules;
		REVOKE ALL ON SCHEMA ledger_modules FROM PUBLIC;
		CREATE TABLE IF NOT EXISTS ledger_modules.migrations (
			module_id  text        NOT NULL,
			name       text        NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (module_id, name)
		);`;

	return {
		...base,
		async appliedMigrations(id) {
			const out = await asSuperuser(`${bootstrap}\nSELECT name FROM ledger_modules.migrations WHERE module_id = ${quoteLit(id)};`, true);
			return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
		},
		async applyMigrations(id, files) {
			const role = schemaFor(id);
			const password = randomBytes(24).toString("hex");
			// The module's role owns only its schema; the app role may use what it creates.
			await asSuperuser(`${bootstrap}
				DO $$ BEGIN
					IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLit(role)}) THEN
						CREATE ROLE ${quoteIdent(role)} NOLOGIN;
					END IF;
				END $$;
				CREATE SCHEMA IF NOT EXISTS ${quoteIdent(role)} AUTHORIZATION ${quoteIdent(role)};
				GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(role)};
				GRANT USAGE ON SCHEMA ${quoteIdent(role)} TO ${quoteIdent(appRole)};
				ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(role)} IN SCHEMA ${quoteIdent(role)}
					GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(appRole)};
				ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(role)} IN SCHEMA ${quoteIdent(role)}
					GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quoteIdent(appRole)};
				ALTER ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLit(password)};`);
			try {
				const client = new pg.Client({
					host: url.hostname || "127.0.0.1",
					port: Number(url.port || 5432),
					database: dbName,
					user: role,
					password,
					options: `-c search_path=${role}`,
				});
				await client.connect();
				try {
					for (const f of files) {
						await client.query("BEGIN");
						try {
							await client.query(f.sql);
							await client.query("COMMIT");
						} catch (err) {
							await client.query("ROLLBACK").catch(() => {});
							throw new Error(`migration ${f.name} failed: ${(err as Error).message}`);
						}
						await asSuperuser(`INSERT INTO ledger_modules.migrations (module_id, name) VALUES (${quoteLit(id)}, ${quoteLit(f.name)});`);
					}
					// Tables created before default privileges existed (or by hand).
					await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdent(role)} TO ${quoteIdent(appRole)}`);
					await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${quoteIdent(role)} TO ${quoteIdent(appRole)}`);
				} finally {
					await client.end().catch(() => {});
				}
			} finally {
				await asSuperuser(`ALTER ROLE ${quoteIdent(role)} NOLOGIN PASSWORD NULL;`).catch((err: Error) =>
					log.error("could not lock the module's database role again", { module: id, err: err.message }),
				);
			}
		},
	};
}
