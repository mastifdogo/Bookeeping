// Restoring from a backup (Settings → Backups → Restore).
//
// Replaces everything in Ledger with what a backup folder holds: the main
// database, each other organization's database, and the files modules keep.
// It takes two processes, because the app's database role can't replace a
// database:
//
//   the app (user ledger)   backs up what is there now, fetches the chosen
//                           backup into <backup dir>/restore/<name>, checks
//                           the dumps and leaves a request for root
//   `ledger update run`     (root, started by ledger-update.path) restores
//                           each dump into a new database beside the live
//                           one, brings it up to this version's schema, then
//                           stops Ledger, swaps the databases and module
//                           files in, and starts it; if Ledger doesn't come
//                           up healthy, everything is swapped back
//
// A dump is restored through a temporary role that can do only what the
// database's owner can, so a tampered dump can't run statements as the
// PostgreSQL superuser.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { log } from "./log.ts";
import { readSmallFile, writeFileAtomic } from "./update.ts";
import { checkDump, fetchDriveBackup, fetchShareBackup, isBackupFolder, readConfig, runBackup, type GoogleEndpoints } from "./backup.ts";

export const RESTORE_RUN_NOW_FILE = "restore-run-now";
export const RESTORE_STATUS_FILE = "restore-status.json";
/** What the user types to confirm. */
export const RESTORE_CONFIRM = "RESTORE";

export interface RestoreStatus {
	state: "idle" | "running" | "ok" | "error";
	/** What is happening now, while running. */
	phase: "" | "backup" | "fetch" | "waiting" | "restore" | "swap";
	message: string;
	/** The backup folder being restored. */
	backup: string;
	source: "" | "share" | "google";
	started_at: string | null;
	finished_at: string | null;
	requested_by: string;
}

export const EMPTY_RESTORE: RestoreStatus = { state: "idle", phase: "", message: "", backup: "", source: "", started_at: null, finished_at: null, requested_by: "" };

export async function readRestoreStatus(dir: string): Promise<RestoreStatus> {
	const text = await readSmallFile(path.join(dir, RESTORE_STATUS_FILE));
	if (text === null) return { ...EMPTY_RESTORE };
	try {
		return { ...EMPTY_RESTORE, ...(JSON.parse(text) as Partial<RestoreStatus>) };
	} catch {
		return { ...EMPTY_RESTORE };
	}
}

/** Writes the status; when root writes it, the file is handed to the directory's owner so the app can read it. */
export async function writeRestoreStatus(dir: string, s: RestoreStatus): Promise<void> {
	const file = path.join(dir, RESTORE_STATUS_FILE);
	await writeFileAtomic(file, JSON.stringify(s, null, 2) + "\n", 0o600);
	if (process.getuid?.() === 0) {
		const st = await fsp.stat(dir);
		await fsp.chown(file, st.uid, st.gid).catch(() => {});
	}
}

export const restoreStagingDir = (backupDir: string, name: string) => path.join(backupDir, "restore", name);

export interface RestoreRequest {
	backup: string;
	source: RestoreStatus["source"];
	requested_by: string;
	started_at: string;
}

// ---------------------------------------------------------------------------
// The app's side
// ---------------------------------------------------------------------------

export interface PrepareOptions {
	backupDir: string;
	configDir: string;
	databaseUrl: string;
	csvDir: string;
	google: GoogleEndpoints;
	source: "share" | "google";
	backup: string;
	requestedBy: string;
	now?: () => number;
}

/**
 * Backs up the current data, fetches and checks the chosen backup, and asks
 * root to switch to it. Never throws: the outcome is in the status file.
 */
export async function prepareRestore(o: PrepareOptions): Promise<RestoreStatus> {
	const now = o.now ?? Date.now;
	const status: RestoreStatus = {
		state: "running",
		phase: "backup",
		message: "Backing up the current data first…",
		backup: o.backup,
		source: o.source,
		started_at: new Date(now()).toISOString(),
		finished_at: null,
		requested_by: o.requestedBy,
	};
	const staging = restoreStagingDir(o.backupDir, o.backup);
	try {
		await writeRestoreStatus(o.backupDir, status);
		const saved = await runBackup({ dir: o.backupDir, databaseUrl: o.databaseUrl, trigger: "manual", google: o.google, csvDir: o.csvDir, now: o.now });
		if (!saved.ok) throw new Error(`the backup of the current data failed (${saved.status.message})`);
		if (saved.status.file === o.backup) throw new Error("that is the backup that was just made");

		status.phase = "fetch";
		status.message = `Current data saved as ${saved.status.file}. Fetching ${o.backup}…`;
		await writeRestoreStatus(o.backupDir, status);
		const config = await readConfig(o.backupDir);
		await fsp.rm(path.join(o.backupDir, "restore"), { recursive: true, force: true });
		if (o.source === "google") await fetchDriveBackup(config.google, o.google, o.backup, staging);
		else await fetchShareBackup(config.share, path.join(o.backupDir, "tmp"), o.backup, staging);
		const dumps = (await fsp.readdir(staging)).filter((n) => n.endsWith(".dump"));
		if (!dumps.includes("ledger.dump")) throw new Error(`${o.backup} has no ledger.dump`);
		for (const d of dumps) {
			await checkDump(path.join(staging, d)).catch(() => {
				throw new Error(`${d} in ${o.backup} is damaged or not a database dump`);
			});
		}

		status.phase = "waiting";
		status.message = `Current data saved as ${saved.status.file}. Ledger will stop for a moment while it switches to ${o.backup}…`;
		await writeRestoreStatus(o.backupDir, status);
		const req: RestoreRequest = { backup: o.backup, source: o.source, requested_by: o.requestedBy, started_at: status.started_at! };
		await writeFileAtomic(path.join(o.configDir, RESTORE_RUN_NOW_FILE), JSON.stringify(req) + "\n", 0o640);
	} catch (err) {
		status.state = "error";
		status.phase = "";
		status.message = `Nothing was changed: ${(err as Error).message}`;
		status.finished_at = new Date(now()).toISOString();
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
		await writeRestoreStatus(o.backupDir, status).catch(() => {});
		log.error("restore not started", { backup: o.backup, err: (err as Error).message });
	}
	return status;
}

// ---------------------------------------------------------------------------
// Root's side
// ---------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const qi = (s: string) => `"${s.replaceAll('"', '""')}"`;
const ql = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** What root's restore does to the system; tests replace the service calls. */
export interface RestoreOps {
	/** Runs SQL as the PostgreSQL superuser in a database; returns the unaligned, tuples-only output. */
	psql(db: string, sql: string): Promise<string>;
	/** Restores a dump into a database, connecting as `role` (a member of the owner role). */
	pgRestore(db: string, dump: string, role: string, password: string, ownerRole: string): Promise<void>;
	/** Applies Ledger's migrations newer than the dump, and the app role's grants (deploy/migrate-db.sh). */
	migrate(db: string): Promise<void>;
	/** Applies installed modules' migrations the dump doesn't have. */
	migrateModules(db: string): Promise<void>;
	/** Names of this version's migrations (db/migrations). */
	knownMigrations(): Promise<Set<string>>;
	stop(): Promise<void>;
	start(): Promise<void>;
	healthy(): Promise<boolean>;
	/** Runs a shell script as the user who owns the data share (never as root: the share is writable by the app). */
	asDataOwner(script: string, env: Record<string, string>): Promise<void>;
}

export interface RestoreOptions {
	backupDir: string;
	/** Where the app leaves the request (the update-config directory). */
	configDir: string;
	databaseUrl: string;
	csvDir: string;
	ownerRole?: string;
	ops: RestoreOps;
	now?: () => number;
	/** Posts the outcome to the dashboard of the (restored) main books. */
	notify?: (n: { title: string; body: string; level: "success" | "danger" }) => Promise<void>;
}

/** After a restore, module schemas belong to their own roles again and the app role can use them. */
function moduleOwnershipSql(appRole: string): string {
	return `
DO $fix$
DECLARE s text; r record; app text := ${ql(appRole)};
BEGIN
	FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^mod_[a-z0-9_]+$' LOOP
		IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = s) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', s); END IF;
		EXECUTE format('ALTER SCHEMA %I OWNER TO %I', s, s);
		FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		          WHERE n.nspname = s AND c.relkind IN ('r','p','v','m','f','S') ORDER BY (c.relkind = 'S') LOOP
			BEGIN
				EXECUTE format('ALTER %s %I.%I OWNER TO %I',
					CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
					s, r.relname, s);
			EXCEPTION WHEN OTHERS THEN NULL; -- a column's own sequence follows its table
			END;
		END LOOP;
		FOR r IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = s LOOP
			EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, s);
		END LOOP;
		FOR r IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
		          LEFT JOIN pg_class c ON c.oid = t.typrelid
		          WHERE n.nspname = s AND (t.typtype IN ('e','d','r') OR (t.typtype = 'c' AND c.relkind = 'c')) LOOP
			EXECUTE format('ALTER %s %I.%I OWNER TO %I', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, s, r.typname, s);
		END LOOP;
		EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), s);
		EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
		EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', s, app);
		EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', s, app);
		EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', s, s, app);
		EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', s, s, app);
	END LOOP;
	IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ledger_modules') THEN
		EXECUTE format('ALTER SCHEMA ledger_modules OWNER TO %I', current_user);
		REVOKE ALL ON SCHEMA ledger_modules FROM PUBLIC;
		EXECUTE format('GRANT USAGE ON SCHEMA ledger_modules TO %I', app);
		IF to_regclass('ledger_modules.migrations') IS NOT NULL THEN
			EXECUTE format('ALTER TABLE ledger_modules.migrations OWNER TO %I', current_user);
			EXECUTE format('GRANT SELECT ON ledger_modules.migrations TO %I', app);
		END IF;
	END IF;
END $fix$;`;
}

const lines = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Carries out a restore the app has asked for. Returns false when there is
 * no request. Never throws for a failed restore: the outcome is in the
 * status file.
 */
export async function performRestore(o: RestoreOptions): Promise<boolean> {
	const now = o.now ?? Date.now;
	const reqFile = path.join(o.configDir, RESTORE_RUN_NOW_FILE);
	const text = await readSmallFile(reqFile);
	if (text === null) return false;
	await fsp.rm(reqFile, { force: true });
	let req: RestoreRequest;
	try {
		req = JSON.parse(text) as RestoreRequest;
	} catch {
		log.error("restore request is not valid JSON; ignored");
		return true;
	}
	const { ops } = o;
	const status: RestoreStatus = {
		...EMPTY_RESTORE,
		state: "running",
		phase: "restore",
		message: "Restoring the databases…",
		backup: String(req.backup),
		source: req.source === "google" ? "google" : "share",
		started_at: typeof req.started_at === "string" ? req.started_at : new Date(now()).toISOString(),
		requested_by: String(req.requested_by ?? "").slice(0, 100),
	};
	const url = new URL(o.databaseUrl);
	const mainDb = decodeURIComponent(url.pathname.slice(1)) || "ledger";
	const appRole = decodeURIComponent(url.username) || "ledger_app";
	const ownerRole = o.ownerRole ?? (process.env.OWNER_ROLE || "ledger_owner");
	const staging = restoreStagingDir(o.backupDir, status.backup);
	const TMP = "_restoring";
	const OLD = "_before_restore";
	const made: string[] = []; // new databases (without the suffix)
	const retired: string[] = []; // live databases set aside
	const swappedIn: string[] = [];
	const fileSwaps: { dir: string; src: string }[] = [];
	let stopped = false;
	const exists = async (db: string) => (await ops.psql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${ql(db)}`)).trim() === "1";
	const drop = (db: string) => ops.psql("postgres", `DROP DATABASE IF EXISTS ${qi(db)} WITH (FORCE)`);

	const restoreOne = async (db: string, dump: string) => {
		if (!IDENT.test(db) || db.length > 48) throw new Error(`can't restore into a database named ${db}`);
		const st = await fsp.lstat(dump).catch(() => null);
		if (!st?.isFile()) throw new Error(`${path.basename(dump)} is missing from the backup`);
		const tmp = db + TMP;
		await drop(tmp);
		made.push(db);
		await ops.psql("postgres", `CREATE DATABASE ${qi(tmp)} OWNER ${qi(ownerRole)} ENCODING 'UTF8' TEMPLATE template0`);
		await ops.psql(
			tmp,
			`REVOKE ALL ON DATABASE ${qi(tmp)} FROM PUBLIC;
			 GRANT CONNECT ON DATABASE ${qi(tmp)} TO ${qi(appRole)};
			 ALTER SCHEMA public OWNER TO ${qi(ownerRole)};
			 REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
		);
		const role = `ledger_restore_${randomBytes(4).toString("hex")}`;
		const password = randomBytes(24).toString("hex");
		await ops.psql("postgres", `CREATE ROLE ${qi(role)} LOGIN PASSWORD ${ql(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE ${qi(ownerRole)} VALID UNTIL ${ql(new Date(now() + 6 * 3600_000).toISOString())}`);
		try {
			await ops.pgRestore(tmp, dump, role, password, ownerRole);
		} finally {
			await ops.psql("postgres", `DROP ROLE IF EXISTS ${qi(role)}`).catch((e: Error) => log.warn("could not drop the temporary restore role", { role, err: e.message }));
		}
		await ops.psql(tmp, moduleOwnershipSql(appRole));
		// A backup from a newer Ledger has tables this version doesn't know how to use.
		const known = await ops.knownMigrations();
		const has = (await ops.psql(tmp, `SELECT to_regclass('public.schema_migrations') IS NOT NULL`)).trim() === "t";
		const applied = has ? lines(await ops.psql(tmp, `SELECT name FROM public.schema_migrations`)) : [];
		const unknown = applied.filter((n) => !known.has(n));
		if (unknown.length > 0) throw new Error(`this backup was made by a newer version of Ledger (it has ${unknown[0]}); update Ledger first, then restore`);
		if ((await ops.psql(tmp, `SELECT to_regclass('public.journal_entries') IS NOT NULL`)).trim() !== "t") throw new Error(`${path.basename(dump)} is not a Ledger database`);
		await ops.migrate(tmp);
		await ops.migrateModules(tmp);
	};

	const undo = async () => {
		// Put back whatever was swapped, newest change first.
		for (const f of fileSwaps.reverse()) {
			await ops.asDataOwner(`rm -rf -- "$DIR"; if [ -e "$DIR.before-restore" ]; then mv -- "$DIR.before-restore" "$DIR"; fi`, { DIR: f.dir }).catch((e: Error) => log.error("restore: could not put module files back", { dir: f.dir, err: e.message }));
		}
		for (const db of swappedIn) await ops.psql("postgres", `ALTER DATABASE ${qi(db)} RENAME TO ${qi(db + TMP)}`).catch((e: Error) => log.error("restore undo", { db, err: e.message }));
		for (const db of retired) await ops.psql("postgres", `ALTER DATABASE ${qi(db + OLD)} RENAME TO ${qi(db)}`).catch((e: Error) => log.error("restore undo", { db, err: e.message }));
		for (const db of made) await drop(db + TMP).catch(() => {});
	};

	try {
		await writeRestoreStatus(o.backupDir, status);
		if (!isBackupFolder(status.backup)) throw new Error(`${status.backup} is not a backup folder`);
		const dir = await fsp.lstat(staging).catch(() => null);
		if (!dir?.isDirectory()) throw new Error("the backup's files were not fetched");

		// 1. Every database, restored beside the live ones.
		await restoreOne(mainDb, path.join(staging, "ledger.dump"));
		const orgRows = lines(await ops.psql(mainDb + TMP, `SELECT db_name FROM organizations WHERE id <> 1 AND status = 'ready' ORDER BY id`));
		const orgDbs: string[] = [];
		for (const db of orgRows) {
			const dump = path.join(staging, `${db}.dump`);
			if (IDENT.test(db) && (await fsp.lstat(dump).catch(() => null))?.isFile()) {
				await restoreOne(db, dump);
				orgDbs.push(db);
			} else {
				await ops.psql(mainDb + TMP, `UPDATE organizations SET status = 'error', message = 'These books were not in the backup that was restored.' WHERE db_name = ${ql(db)}`);
			}
		}

		// 2. Which live databases go: the main one and every organization's, restored or not.
		const live = [mainDb];
		const liveOrgs = lines(await ops.psql(mainDb, `SELECT db_name FROM organizations WHERE id <> 1`).catch(() => ""));
		for (const db of new Set([...liveOrgs, ...orgDbs])) if (IDENT.test(db) && db !== mainDb && (await exists(db))) live.push(db);

		// 3. The swap, with Ledger stopped.
		status.phase = "swap";
		status.message = "Switching to the restored data…";
		await writeRestoreStatus(o.backupDir, status);
		stopped = true;
		await ops.stop();
		for (const db of live) {
			await drop(db + OLD);
			await ops.psql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${ql(db)} AND pid <> pg_backend_pid()`);
			await ops.psql("postgres", `ALTER DATABASE ${qi(db)} RENAME TO ${qi(db + OLD)}`);
			retired.push(db);
		}
		for (const db of [mainDb, ...orgDbs]) {
			await ops.psql("postgres", `ALTER DATABASE ${qi(db + TMP)} RENAME TO ${qi(db)}`);
			swappedIn.push(db);
		}
		// Files modules keep: only what the backup holds.
		const swaps = [{ dir: path.join(o.csvDir, ".modules"), src: path.join(staging, "files") }, ...[...new Set([...liveOrgs, ...orgDbs])].filter((d) => IDENT.test(d)).map((d) => ({ dir: path.join(o.csvDir, ".orgs", d, ".modules"), src: path.join(staging, `${d}-files`) }))];
		for (const f of swaps) {
			fileSwaps.push(f);
			await ops.asDataOwner(
				`rm -rf -- "$DIR.before-restore"
				 if [ -e "$DIR" ]; then mv -- "$DIR" "$DIR.before-restore"; fi
				 if [ -d "$SRC" ] && [ ! -L "$SRC" ]; then mkdir -p -- "$(dirname "$DIR")" && cp -R -P -- "$SRC" "$DIR" && chmod -R u+rwX,g+rX,o-rwx -- "$DIR"; fi`,
				{ DIR: f.dir, SRC: f.src },
			);
		}
		await ops.start();
		if (!(await ops.healthy())) throw new Error("Ledger did not start with the restored data, so the previous data was put back");

		// 4. Done: the previous data goes (it is in the backup made just before).
		stopped = false;
		for (const db of retired) await drop(db + OLD).catch((e: Error) => log.warn("restore: could not drop the previous database", { db, err: e.message }));
		for (const f of fileSwaps) await ops.asDataOwner(`rm -rf -- "$DIR.before-restore"`, { DIR: f.dir }).catch(() => {});
		await fsp.rm(staging, { recursive: true, force: true });
		status.state = "ok";
		status.message = `Restored from ${status.backup}: ${orgDbs.length ? `${orgDbs.length + 1} sets of books` : "the books"} and the files modules keep. Everything is as it was when that backup was made.`;
	} catch (err) {
		status.state = "error";
		status.message = `Nothing was changed: ${(err as Error).message}`;
		log.error("restore failed", { backup: status.backup, err: (err as Error).message });
		await undo();
		if (stopped) await ops.start().catch((e: Error) => log.error("restore: could not start Ledger again", { err: e.message }));
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
	}
	status.phase = "";
	status.finished_at = new Date(now()).toISOString();
	await writeRestoreStatus(o.backupDir, status).catch((e: Error) => log.error("restore: could not write the status", { err: e.message }));
	log.info("restore", { state: status.state, backup: status.backup });
	await o
		.notify?.(status.state === "ok" ? { title: "Restored from a backup", body: status.message, level: "success" } : { title: "Restore failed", body: status.message, level: "danger" })
		.catch((e: Error) => log.warn("could not post the restore to the dashboard", { err: e.message }));
	return true;
}

// ---------------------------------------------------------------------------
// The real system
// ---------------------------------------------------------------------------

function exec(cmd: string, args: string[], opts: { input?: string; stdinFile?: string; env?: NodeJS.ProcessEnv; uid?: number; gid?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: [opts.input !== undefined || opts.stdinFile ? "pipe" : "ignore", "pipe", "pipe"], env: opts.env ?? process.env, uid: opts.uid, gid: opts.gid });
		let out = "";
		let err = "";
		p.stdout!.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-1_000_000)));
		p.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
		p.on("error", reject);
		p.on("exit", (code, signal) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} failed (${signal ?? code}): ${err.trim().split("\n").slice(-3).join(" / ")}`))));
		if (opts.stdinFile) {
			p.stdin!.on("error", () => {});
			createReadStream(opts.stdinFile).on("error", reject).pipe(p.stdin!);
		} else if (opts.input !== undefined) {
			p.stdin!.on("error", () => {});
			p.stdin!.end(opts.input);
		}
	});
}

export interface RealRestoreConfig {
	databaseUrl: string;
	/** How to run psql as the PostgreSQL superuser, e.g. ["runuser", "-u", "postgres", "--", "psql"]. */
	psql?: string[];
	/** Extra environment for psql, pg_restore and migrate-db.sh (tests: PGHOST, PGUSER, PGPASSWORD). */
	env?: NodeJS.ProcessEnv;
	/** deploy/migrate-db.sh and the directory with grants.sql and migrations/. */
	migrateScript?: string;
	sqlDir?: string;
	ownerRole?: string;
	/** The user the data share's files belong to (default: the owner of dataDir). */
	dataDir: string;
	migrateModules: (db: string) => Promise<void>;
	service: Pick<RestoreOps, "stop" | "start" | "healthy">;
}

/** psql, pg_restore and migrate-db.sh on this machine. */
export function restoreOps(c: RealRestoreConfig): RestoreOps {
	const url = new URL(c.databaseUrl);
	const psqlCmd = c.psql ?? (process.env.LEDGER_PSQL ? process.env.LEDGER_PSQL.split(" ") : ["runuser", "-u", "postgres", "--", "psql"]);
	const env = { ...process.env, ...c.env };
	const sqlDir = c.sqlDir ?? (process.env.SQL_DIR || "/usr/local/share/ledger");
	const migrateScript = c.migrateScript ?? "/usr/local/share/ledger/migrate-db.sh";
	const appRole = decodeURIComponent(url.username) || "ledger_app";
	const ownerRole = c.ownerRole ?? (process.env.OWNER_ROLE || "ledger_owner");
	return {
		...c.service,
		psql: (db, sql) => exec(psqlCmd[0]!, [...psqlCmd.slice(1), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", db], { input: sql, env }),
		pgRestore: async (db, dump, role, password, owner) => {
			await exec(
				"pg_restore",
				["-h", url.hostname || "127.0.0.1", "-p", url.port || "5432", "-U", role, "-d", db, `--role=${owner}`, "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"],
				{ stdinFile: dump, env: { ...env, PGPASSWORD: password, PGUSER: role, PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer" } },
			);
		},
		migrate: async (db) => {
			await exec("sh", [migrateScript], { env: { ...env, DB_NAME: db, OWNER_ROLE: ownerRole, APP_ROLE: appRole, SQL_DIR: sqlDir, PSQL: psqlCmd.join(" ") } });
		},
		migrateModules: c.migrateModules,
		knownMigrations: async () => new Set((await fsp.readdir(path.join(sqlDir, "migrations")).catch(() => [] as string[])).filter((n) => /^\d.*\.sql$/.test(n))),
		asDataOwner: async (script, vars) => {
			const st = await fsp.stat(c.dataDir);
			const asOther = process.getuid?.() === 0 && st.uid !== 0;
			await exec("sh", ["-c", `set -eu\n${script}`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...vars }, ...(asOther ? { uid: st.uid, gid: st.gid } : {}) });
		},
	};
}
