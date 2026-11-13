// Restoring from a backup (Settings → Backups → Restore).
//
// Replaces one organization's books with what one of its backup folders
// holds: its database (entries, accounts, module data and settings) and the
// files its modules keep. Other organizations are not touched, and neither
// are the server's users, passwords, sign-ins, organizations and who may
// open which books: those stay as they are, also when the main books (whose
// database holds them) are restored. It takes two processes, because the
// app's database role can't replace a database:
//
//   the app (user ledger)   backs up what is there now, fetches the chosen
//                           backup into <backup dir>/restore/<name>, checks
//                           the dumps and leaves a request for root
//   `ledger update run`     (root, started by ledger-update.path) restores
//                           the dump into a new database beside the live
//                           one, brings it up to this version's schema,
//                           copies the server's users and sign-ins into it
//                           (main books), then stops Ledger, swaps the
//                           database and module files in, and starts it; if
//                           Ledger doesn't come up healthy, it is all
//                           swapped back
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
import { type OrgSettingsFile, checkDump, fetchDriveBackup, fetchShareBackup, isBackupFolder, orgBackupDir, readOrgConfig, runBackup, type GoogleEndpoints } from "./backup.ts";

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
	/** The organization's database ("" for the main books). */
	db: string;
	backup: string;
	source: RestoreStatus["source"];
	requested_by: string;
	started_at: string;
}

// ---------------------------------------------------------------------------
// The app's side
// ---------------------------------------------------------------------------

export interface PrepareOptions {
	/** The server's backup state directory, and the organization's database ("" for the main books). */
	baseDir: string;
	db: string;
	configDir: string;
	/** The organization's database and files directory. */
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
	const backupDir = orgBackupDir(o.baseDir, o.db);
	const staging = restoreStagingDir(backupDir, o.backup);
	const reqFile = path.join(o.configDir, RESTORE_RUN_NOW_FILE);
	try {
		await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
		if ((await readSmallFile(reqFile)) !== null) throw new Error("another restore is waiting for the server; try again in a few minutes");
		await writeRestoreStatus(backupDir, status);
		const config = await readOrgConfig(o.baseDir, o.db);
		const saved = await runBackup({ dir: backupDir, config, databaseUrl: o.databaseUrl, trigger: "manual", google: o.google, csvDir: o.csvDir, now: o.now });
		if (!saved.ok) throw new Error(`the backup of the current data failed (${saved.status.message})`);
		if (saved.status.file === o.backup) throw new Error("that is the backup that was just made");

		status.phase = "fetch";
		status.message = `Current data saved as ${saved.status.file}. Fetching ${o.backup}…`;
		await writeRestoreStatus(backupDir, status);
		await fsp.rm(path.join(backupDir, "restore"), { recursive: true, force: true });
		if (o.source === "google") await fetchDriveBackup(config.google, o.google, o.backup, staging);
		else await fetchShareBackup(config.share, path.join(backupDir, "tmp"), o.backup, staging);
		if (!(await fsp.lstat(path.join(staging, "ledger.dump")).catch(() => null))?.isFile()) throw new Error(`${o.backup} has no ledger.dump`);
		await checkDump(path.join(staging, "ledger.dump")).catch(() => {
			throw new Error(`ledger.dump in ${o.backup} is damaged or not a database dump`);
		});

		status.phase = "waiting";
		status.message = `Current data saved as ${saved.status.file}. Ledger will stop for a moment while it switches to ${o.backup}…`;
		await writeRestoreStatus(backupDir, status);
		const req: RestoreRequest = { db: o.db, backup: o.backup, source: o.source, requested_by: o.requestedBy, started_at: status.started_at! };
		await writeFileAtomic(reqFile, JSON.stringify(req) + "\n", 0o640);
	} catch (err) {
		status.state = "error";
		status.phase = "";
		status.message = `Nothing was changed: ${(err as Error).message}`;
		status.finished_at = new Date(now()).toISOString();
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
		await writeRestoreStatus(backupDir, status).catch(() => {});
		log.error("restore not started", { backup: o.backup, err: (err as Error).message });
	}
	return status;
}

/** Reads and checks a fetched settings backup. */
export async function readSettingsFile(file: string): Promise<OrgSettingsFile> {
	const text = await readSmallFile(file);
	let v: OrgSettingsFile;
	try {
		v = JSON.parse(text ?? "") as OrgSettingsFile;
	} catch {
		throw new Error("the settings file is missing or damaged");
	}
	const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
	if (!isObj(v) || v.ledger_settings !== 1 || !isObj(v.modules)) throw new Error("that is not a Ledger settings file");
	for (const [id, values] of Object.entries(v.modules)) {
		if (!/^[a-z][a-z0-9-]{1,31}$/.test(id) || !isObj(values)) throw new Error(`the settings file has invalid settings for ${id}`);
	}
	return v;
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
	/** The server's backup state directory (organizations' directories are inside it). */
	backupDir: string;
	/** Where the app leaves the request (the update-config directory). */
	configDir: string;
	databaseUrl: string;
	csvDir: string;
	ownerRole?: string;
	ops: RestoreOps;
	now?: () => number;
	/** Posts the outcome to the dashboard of the organization (its database) whose books were restored. */
	notify?: (db: string, n: { title: string; body: string; level: "success" | "danger" }) => Promise<void>;
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
 * Tables of the main database that belong to the server, not to the main
 * books: a restore keeps them as they are now.
 */
export const SERVER_TABLES = ["users", "sessions", "organizations", "memberships", "user_settings"] as const;

/** An organization's settings in its database: kept by a restore of its books, saved and restored separately. */
export const ORG_SETTINGS_TABLES = ["module_settings"] as const;

/** SQL (for the restored main database) that makes a server table hold the rows in `json` (users: added or updated, never removed, since the books refer to them). */
function loadServerTableSql(table: string, json: string): string {
	const tag = `$j${randomBytes(6).toString("hex")}$`;
	if (json.includes(tag)) throw new Error("unexpected data");
	return `
DO $load$
DECLARE cols text; sets text; seq text; rows json := ${tag}${json}${tag}::json;
BEGIN
	IF to_regclass('public.${table}') IS NULL THEN RETURN; END IF;
	SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg(format('%I = EXCLUDED.%I', attname, attname), ', ' ORDER BY attnum) FILTER (WHERE attname <> 'id')
	  INTO cols, sets FROM pg_attribute
	 WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
	${table === "users" ? "" : `DELETE FROM public.${table};`}
	EXECUTE format('INSERT INTO public.${table} (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM json_populate_recordset(NULL::public.${table}, $1)%s', cols, cols,
		${table === "users" ? `' ON CONFLICT (id) DO UPDATE SET ' || sets` : "''"}) USING rows;
	IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attname = 'id' AND NOT attisdropped) THEN
		seq := pg_get_serial_sequence('public.${table}', 'id');
	END IF;
	IF seq IS NOT NULL THEN
		EXECUTE format('SELECT setval(%L, greatest((SELECT coalesce(max(id), 1) FROM public.${table}), (SELECT last_value FROM %s)))', seq, seq);
	END IF;
END $load$;`;
}

/**
 * Carries out a restore the app has asked for. Returns false when there is
 * no request. Never throws for a failed restore: the outcome is in the
 * organization's status file.
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
		if (typeof req.db !== "string" || (req.db !== "" && !IDENT.test(req.db))) throw new Error("bad database name");
	} catch {
		log.error("restore request is not valid; ignored");
		return true;
	}
	const { ops } = o;
	const status: RestoreStatus = {
		...EMPTY_RESTORE,
		state: "running",
		phase: "restore",
		message: "Restoring the books…",
		backup: String(req.backup),
		source: req.source === "google" ? "google" : "share",
		started_at: typeof req.started_at === "string" ? req.started_at : new Date(now()).toISOString(),
		requested_by: String(req.requested_by ?? "").slice(0, 100),
	};
	const url = new URL(o.databaseUrl);
	const mainDb = decodeURIComponent(url.pathname.slice(1)) || "ledger";
	const appRole = decodeURIComponent(url.username) || "ledger_app";
	const ownerRole = o.ownerRole ?? (process.env.OWNER_ROLE || "ledger_owner");
	const isMain = req.db === "" || req.db === mainDb;
	const db = isMain ? mainDb : req.db;
	const backupDir = orgBackupDir(o.backupDir, isMain ? "" : db);
	const staging = restoreStagingDir(backupDir, status.backup);
	const filesDir = path.join(isMain ? o.csvDir : path.join(o.csvDir, ".orgs", db), ".modules");
	const tmp = db + "_restoring";
	const old = db + "_before_restore";
	let made = false;
	let retired = false;
	let swappedIn = false;
	let filesSwapped = false;
	let stopped = false;
	const drop = (name: string) => ops.psql("postgres", `DROP DATABASE IF EXISTS ${qi(name)} WITH (FORCE)`);

	try {
		await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 }).catch(() => {});
		await writeRestoreStatus(backupDir, status);
		if (!isBackupFolder(status.backup)) throw new Error(`${status.backup} is not a backup folder`);
		if (!IDENT.test(db) || db.length > 48) throw new Error(`can't restore into a database named ${db}`);
		// Only the books of an organization this server has.
		if (!isMain && (await ops.psql(mainDb, `SELECT 1 FROM organizations WHERE id <> 1 AND status = 'ready' AND db_name = ${ql(db)}`)).trim() !== "1") throw new Error("these books are not an organization on this server");
		const dump = path.join(staging, "ledger.dump");
		if (!(await fsp.lstat(staging).catch(() => null))?.isDirectory() || !(await fsp.lstat(dump).catch(() => null))?.isFile()) throw new Error("the backup's files were not fetched");

		// 1. The dump, restored into a new database beside the live one.
		await drop(tmp);
		made = true;
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
		const unknown = (has ? lines(await ops.psql(tmp, `SELECT name FROM public.schema_migrations`)) : []).filter((n) => !known.has(n));
		if (unknown.length > 0) throw new Error(`this backup was made by a newer version of Ledger (it has ${unknown[0]}); update Ledger first, then restore`);
		if ((await ops.psql(tmp, `SELECT to_regclass('public.journal_entries') IS NOT NULL`)).trim() !== "t") throw new Error("ledger.dump is not a Ledger database");
		await ops.migrate(tmp);
		await ops.migrateModules(tmp);

		// 2. The swap, with Ledger stopped so nothing is written meanwhile.
		status.phase = "swap";
		status.message = "Switching to the restored books…";
		await writeRestoreStatus(backupDir, status);
		stopped = true;
		await ops.stop();
		{
			// What stays as it is now: the organization's settings (they have their own rolling
			// backup) and, in the main database, users, passwords, sign-ins, organizations and
			// who may open which books.
			for (const t of isMain ? [...SERVER_TABLES, ...ORG_SETTINGS_TABLES] : ORG_SETTINGS_TABLES) {
				const json = (await ops.psql(mainDb, `SELECT coalesce(json_agg(t), '[]') FROM public.${t} t`)).trim() || "[]";
				await ops.psql(tmp, `SET session_replication_role = replica;\n${loadServerTableSql(t, json)}`);
			}
		}
		await drop(old);
		await ops.psql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${ql(db)} AND pid <> pg_backend_pid()`);
		await ops.psql("postgres", `ALTER DATABASE ${qi(db)} RENAME TO ${qi(old)}`);
		retired = true;
		await ops.psql("postgres", `ALTER DATABASE ${qi(tmp)} RENAME TO ${qi(db)}`);
		swappedIn = true;
		// Files modules keep: only what the backup holds.
		filesSwapped = true;
		await ops.asDataOwner(
			`rm -rf -- "$DIR.before-restore"
			 if [ -e "$DIR" ]; then mv -- "$DIR" "$DIR.before-restore"; fi
			 if [ -d "$SRC" ] && [ ! -L "$SRC" ]; then mkdir -p -- "$(dirname "$DIR")" && cp -R -P -- "$SRC" "$DIR" && chmod -R u+rwX,g+rX,o-rwx -- "$DIR"; fi`,
			{ DIR: filesDir, SRC: path.join(staging, "files") },
		);
		await ops.start();
		if (!(await ops.healthy())) throw new Error("Ledger did not start with the restored books, so the previous ones were put back");

		// 3. Done: the previous books go (they are in the backup made just before).
		stopped = false;
		await drop(old).catch((e: Error) => log.warn("restore: could not drop the previous database", { db: old, err: e.message }));
		await ops.asDataOwner(`rm -rf -- "$DIR.before-restore"`, { DIR: filesDir }).catch(() => {});
		await fsp.rm(staging, { recursive: true, force: true });
		status.state = "ok";
		status.message = `Restored from ${status.backup}. These books, their module data and the files modules keep are as they were when that backup was made. Settings, users and sign-ins were left as they are.`;
	} catch (err) {
		status.state = "error";
		status.message = `Nothing was changed: ${(err as Error).message}`;
		log.error("restore failed", { db, backup: status.backup, err: (err as Error).message });
		// Put back whatever was swapped.
		if (filesSwapped) {
			await ops.asDataOwner(`rm -rf -- "$DIR"; if [ -e "$DIR.before-restore" ]; then mv -- "$DIR.before-restore" "$DIR"; fi`, { DIR: filesDir }).catch((e: Error) => log.error("restore: could not put module files back", { err: e.message }));
		}
		if (swappedIn) await ops.psql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${ql(db)} AND pid <> pg_backend_pid(); ALTER DATABASE ${qi(db)} RENAME TO ${qi(tmp)}`).catch((e: Error) => log.error("restore undo", { err: e.message }));
		if (retired) await ops.psql("postgres", `ALTER DATABASE ${qi(old)} RENAME TO ${qi(db)}`).catch((e: Error) => log.error("restore undo", { err: e.message }));
		if (made) await drop(tmp).catch(() => {});
		if (stopped) await ops.start().catch((e: Error) => log.error("restore: could not start Ledger again", { err: e.message }));
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
	}
	status.phase = "";
	status.finished_at = new Date(now()).toISOString();
	await writeRestoreStatus(backupDir, status).catch((e: Error) => log.error("restore: could not write the status", { err: e.message }));
	log.info("restore", { state: status.state, db, backup: status.backup });
	await o
		.notify?.(db, status.state === "ok" ? { title: "Restored from a backup", body: status.message, level: "success" } : { title: "Restore failed", body: status.message, level: "danger" })
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
