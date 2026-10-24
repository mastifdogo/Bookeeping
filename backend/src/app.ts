import type { Pool } from "./db.ts";
import type { CookieSecure } from "./config.ts";
import { LOGIN_MAX_FAILURES_PER_USER, LoginLimiter } from "./limiter.ts";
import { updateDirs, type UpdateDirs } from "./update.ts";

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
}

export function newApp(
	db: Pool,
	cfg: { csvDir: string; cookieSecure: CookieSecure; webDir: string; version?: string; update?: UpdateDirs },
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
	};
}
