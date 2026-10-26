import type { Pool } from "./db.ts";
import type { CookieSecure } from "./config.ts";
import { LOGIN_MAX_FAILURES_PER_USER, LoginLimiter } from "./limiter.ts";
import { updateDirs, type UpdateDirs } from "./update.ts";
import { ModuleHost } from "./module-host.ts";
import { modulesDir } from "./modules.ts";
import { backupStateDir, googleEndpoints, type DeviceCode, type GoogleEndpoints } from "./backup.ts";

/** Shared dependencies for handlers and ledger operations. */
export interface App {
	db: Pool;
	csvDir: string;
	cookieSecure: CookieSecure;
	webDir: string;
	logins: LoginLimiter;
	userLogins: LoginLimiter;
	/** Installed release version ("dev" for a checkout). */
	version: string;
	update: UpdateDirs;
	/** Installed modules running in this process. */
	modules: ModuleHost;
	/** Backups: settings/status directory, database URL for pg_dump, Google endpoints. */
	backup: { dir: string; databaseUrl: string; google: GoogleEndpoints; device: DeviceCode | null; running: Promise<unknown> | null };
}

export function newApp(
	db: Pool,
	cfg: {
		csvDir: string;
		cookieSecure: CookieSecure;
		webDir: string;
		version?: string;
		update?: UpdateDirs;
		modulesDir?: string;
		databaseUrl?: string;
		backupDir?: string;
		google?: GoogleEndpoints;
	},
): App {
	return {
		db,
		csvDir: cfg.csvDir,
		cookieSecure: cfg.cookieSecure,
		webDir: cfg.webDir,
		logins: new LoginLimiter(),
		userLogins: new LoginLimiter(LOGIN_MAX_FAILURES_PER_USER),
		version: cfg.version ?? "dev",
		update: cfg.update ?? updateDirs(),
		modules: new ModuleHost(cfg.modulesDir ?? modulesDir()),
		backup: { dir: cfg.backupDir ?? backupStateDir(), databaseUrl: cfg.databaseUrl ?? "", google: cfg.google ?? googleEndpoints(), device: null, running: null },
	};
}
