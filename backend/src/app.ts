import type { Pool } from "./db.ts";
import type { CookieSecure } from "./config.ts";
import { LOGIN_MAX_FAILURES_PER_USER, LoginLimiter } from "./limiter.ts";
import { updateDirs, type UpdateDirs } from "./update.ts";
import { ModuleHost } from "./module-host.ts";
import { modulesDir } from "./modules.ts";
import { integrationsDir } from "./integrations.ts";
import { gmailEndpoints, type GoogleEndpoints as GmailEndpoints, type PendingAuth } from "./gmail.ts";
import { OrgPools, routedPool } from "./orgs.ts";
import { backupStateDir, googleEndpoints, type DeviceCode, type GoogleEndpoints } from "./backup.ts";

/** Shared dependencies for handlers and ledger operations. */
export interface App {
	/** The current organization's database (see orgs.ts); the main books outside a request. */
	db: Pool;
	/** The main database: users, sessions, organizations, server settings. */
	main: Pool;
	orgs: OrgPools;
	/** Creates an organization's database directly (development, tests); otherwise root does it. */
	provisionOrg: ((dbName: string) => Promise<void>) | null;
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
	/** AI and Gmail settings (integrationsDir), Gmail endpoints and a pending OAuth attempt. */
	integrations: { dir: string; gmail: GmailEndpoints; pendingGmail: PendingAuth | null };
	/** Backups: settings/status directory, database URL for pg_dump, Google endpoints. */
	backup: { dir: string; databaseUrl: string; google: GoogleEndpoints; device: DeviceCode | null; running: Promise<unknown> | null; restoring: Promise<unknown> | null };
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
		integrationsDir?: string;
		gmail?: GmailEndpoints;
		provisionOrg?: (dbName: string) => Promise<void>;
	},
): App {
	const orgs = new OrgPools(db, cfg.databaseUrl ?? "");
	return {
		db: routedPool(orgs),
		main: db,
		orgs,
		provisionOrg: cfg.provisionOrg ?? null,
		csvDir: cfg.csvDir,
		cookieSecure: cfg.cookieSecure,
		webDir: cfg.webDir,
		logins: new LoginLimiter(),
		userLogins: new LoginLimiter(LOGIN_MAX_FAILURES_PER_USER),
		version: cfg.version ?? "dev",
		update: cfg.update ?? updateDirs(),
		modules: new ModuleHost(cfg.modulesDir ?? modulesDir()),
		integrations: { dir: cfg.integrationsDir ?? integrationsDir(), gmail: cfg.gmail ?? gmailEndpoints(), pendingGmail: null },
		backup: { dir: cfg.backupDir ?? backupStateDir(), databaseUrl: cfg.databaseUrl ?? "", google: cfg.google ?? googleEndpoints(), device: null, running: null, restoring: null },
	};
}
