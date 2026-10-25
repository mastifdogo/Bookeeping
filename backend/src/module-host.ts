// Runs installed modules inside the Ledger server. At startup each module's
// server file is imported and its `register(ctx)` called; the context lets
// it add API routes under /api/v1/m/<id>/, query the database (as the app's
// restricted role, plus full access to its own schema mod_<id>), and use the
// ledger's own functions. Its UI directory is served at /m/<id>/.
//
// A module that fails to load is reported on the Modules page and skipped;
// the rest of Ledger keeps running.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "./app.ts";
import { HttpError } from "./errors.ts";
import { log } from "./log.ts";
import { compatible, scanInstalled, type InstalledModule, type ModuleManifest } from "./modules.ts";
import { createAccount, getAccount, getAccountLedger, getTrialBalance, listAccounts } from "./accounts.ts";
import { createJournalEntry, getJournalEntry, listJournalEntries, reverseJournalEntry } from "./ledger.ts";
import { getBalanceSheet, getIncomeStatement } from "./reports.ts";
import { listBySource, postItem, removeByKey, setClosedByKey, type ItemInput, type ItemKind } from "./dashboard.ts";
import { isCurrency, publicUser, type AccountCreate, type Currency, type JournalEntryCreate, type User } from "./types.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** What a module's route handler receives. */
export interface ModuleRequest {
	method: Method;
	/** Path below /api/v1/m/<id>, e.g. "/invoices/7". */
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	/** Parsed JSON body (undefined when there is none). */
	body: unknown;
	/** The logged-in user. */
	user: { username: string };
}

/** Return this from a handler to choose the status code. */
export class ModuleResponse {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, body?: unknown) {
		this.status = status;
		this.body = body;
	}
}

type Handler = (req: ModuleRequest) => unknown;

interface ModuleRoute {
	method: Method;
	segments: string[];
	handler: Handler;
}

export interface LoadedModule {
	manifest: ModuleManifest;
	dir: string;
	repo: string | null;
	tag: string | null;
	routes: ModuleRoute[];
	/** Why the module is not running (load error, incompatible version); null when it runs. */
	error: string | null;
}

/** Amounts from modules may be numbers, bigints or digit strings; they become exact bigint cents. */
function toCents(v: unknown, field: string): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
	if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
	if (v === undefined || v === null) return 0n;
	throw new HttpError(400, `${field} must be a whole number of cents`);
}

function toEntry(e: unknown): JournalEntryCreate {
	const o = (e ?? {}) as Record<string, unknown>;
	const lines = Array.isArray(o.lines) ? o.lines : [];
	return {
		entry_date: typeof o.entry_date === "string" ? o.entry_date : "",
		description: typeof o.description === "string" ? o.description : "",
		reference: typeof o.reference === "string" ? o.reference : "",
		lines: lines.map((l, i) => {
			const x = (l ?? {}) as Record<string, unknown>;
			return {
				account_code: typeof x.account_code === "string" ? x.account_code : "",
				debit_cents: toCents(x.debit_cents, `lines[${i}].debit_cents`),
				credit_cents: toCents(x.credit_cents, `lines[${i}].credit_cents`),
				memo: typeof x.memo === "string" ? x.memo : "",
			};
		}),
	};
}

const cur = (c: string | null | undefined): Currency | null => (c && isCurrency(c.toUpperCase()) ? (c.toUpperCase() as Currency) : null);

// Users passed to modules: the internal id stays out of reach of the module's
// JSON, but the host can still attribute entries to the right person.
const userIds = new WeakMap<object, number>();
function moduleUser(u: User): { username: string } {
	const pub = { username: publicUser(u).username };
	userIds.set(pub, u.id);
	return pub;
}
function actorOf(u: unknown): number | null {
	return u && typeof u === "object" ? (userIds.get(u) ?? null) : null;
}

/** The API given to a module's register(ctx). Documented in docs/MODULES.md. */
function makeContext(app: App, m: LoadedModule) {
	const id = m.manifest.id;
	const prefix = { module: id };
	return {
		id,
		name: m.manifest.name,
		version: m.manifest.version,
		dir: m.dir,
		/** The module's own database schema (created by its migrations). */
		schema: `mod_${id.replaceAll("-", "_")}`,
		ledgerVersion: app.version,
		log: {
			info: (msg: string, attrs: Record<string, unknown> = {}) => log.info(msg, { ...prefix, ...attrs }),
			warn: (msg: string, attrs: Record<string, unknown> = {}) => log.warn(msg, { ...prefix, ...attrs }),
			error: (msg: string, attrs: Record<string, unknown> = {}) => log.error(msg, { ...prefix, ...attrs }),
		},
		db: {
			query: async (sql: string, params: unknown[] = []) => {
				const r = await app.db.query(sql, params);
				return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 };
			},
		},
		route(method: Method, routePath: string, handler: Handler) {
			if (!METHODS.includes(method)) throw new Error(`route: unsupported method ${method}`);
			if (!/^\/[A-Za-z0-9_\-/:.]*$/.test(routePath)) throw new Error(`route: invalid path ${routePath}`);
			if (typeof handler !== "function") throw new Error("route: handler must be a function");
			m.routes.push({ method, segments: routePath.split("/").slice(1), handler });
		},
		/** Notifications and to-dos on Ledger's dashboard, owned by this module. */
		dashboard: {
			/** Posts a notification. Posting the same key again updates it (and shows it again if its text changed). */
			notify: (n: ItemInput) => postItem(app, id, "notification", n),
			/** Adds or updates a to-do; key is required. */
			todo: (t: ItemInput & { key: string }) => postItem(app, id, "todo", t),
			/** Marks a to-do done. Returns false if there is no such to-do. */
			complete: (key: string) => setClosedByKey(app, id, "todo", String(key), true),
			/** Marks a to-do not done again. */
			reopen: (key: string) => setClosedByKey(app, id, "todo", String(key), false),
			/** Hides a notification, as if the user had dismissed it. */
			dismiss: (key: string) => setClosedByKey(app, id, "notification", String(key), true),
			/** Deletes an item outright. */
			remove: (key: string, kind: ItemKind = "todo") => removeByKey(app, id, kind === "notification" ? "notification" : "todo", String(key)),
			/** This module's items, newest first. */
			list: (opts: { kind?: ItemKind; open?: boolean } = {}) => listBySource(app, id, opts),
		},
		HttpError,
		response: (status: number, body?: unknown) => new ModuleResponse(status, body),
		ledger: {
			listAccounts: (opts: { includeInactive?: boolean } = {}) => listAccounts(app, opts.includeInactive ?? false),
			getAccount: (code: string) => getAccount(app, code),
			createAccount: (a: AccountCreate) => createAccount(app, { code: a.code, name: a.name, type: a.type, currency: a.currency, description: a.description ?? "" }),
			accountLedger: (code: string, opts: { from?: string; to?: string } = {}) => getAccountLedger(app, code, opts.from ?? null, opts.to ?? null),
			listJournalEntries: (f: { from?: string; to?: string; accountCode?: string; limit?: number; offset?: number } = {}) =>
				listJournalEntries(app, {
					from: f.from ?? null,
					to: f.to ?? null,
					accountCode: f.accountCode ?? null,
					limit: Math.min(Math.max(f.limit ?? 50, 1), 500),
					offset: Math.max(f.offset ?? 0, 0),
				}),
			getJournalEntry: (entryId: number | bigint) => getJournalEntry(app, BigInt(entryId)),
			/** Posts a balanced entry; pass the request's user so it is attributed to them. */
			createJournalEntry: (entry: unknown, user?: { username: string }) => createJournalEntry(app, toEntry(entry), actorOf(user)),
			reverseJournalEntry: (entryId: number | bigint, opts: { entry_date?: string; description?: string } = {}, user?: { username: string }) =>
				reverseJournalEntry(app, BigInt(entryId), opts, actorOf(user)),
			trialBalance: (opts: { asOf?: string; currency?: string } = {}) => getTrialBalance(app, opts.asOf ?? null, cur(opts.currency)),
			balanceSheet: (opts: { asOf?: string; currency?: string } = {}) => getBalanceSheet(app, opts.asOf ?? null, cur(opts.currency)),
			incomeStatement: (opts: { from?: string; to?: string; currency?: string } = {}) =>
				getIncomeStatement(app, opts.from ?? null, opts.to ?? null, cur(opts.currency)),
		},
	};
}

export type ModuleContext = ReturnType<typeof makeContext>;

const REGISTER_TIMEOUT_MS = 15_000;

export class ModuleHost {
	readonly modules = new Map<string, LoadedModule>();
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Imports and registers every installed module. Never throws. */
	async loadAll(app: App): Promise<void> {
		for (const inst of await scanInstalled(this.dir)) await this.load(app, inst);
	}

	private async load(app: App, inst: InstalledModule): Promise<void> {
		const m: LoadedModule = {
			manifest: inst.manifest,
			dir: inst.dir,
			repo: inst.source?.repo ?? null,
			tag: inst.source?.tag ?? null,
			routes: [],
			error: null,
		};
		this.modules.set(m.manifest.id, m);
		if (!compatible(m.manifest, app.version)) {
			m.error = `needs Ledger ${m.manifest.ledger} (this is ${app.version})`;
			return;
		}
		if (!m.manifest.server) return;
		try {
			const file = path.join(inst.dir, m.manifest.server);
			if (!file.startsWith(inst.dir + path.sep)) throw new Error("server file is outside the module");
			const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; register?: unknown };
			const register = (typeof mod.default === "function" ? mod.default : mod.register) as ((ctx: ModuleContext) => unknown) | undefined;
			if (typeof register !== "function") throw new Error(`${m.manifest.server} must export a register(ctx) function`);
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.resolve(register(makeContext(app, m))),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`register() did not finish within ${REGISTER_TIMEOUT_MS / 1000} s`)), REGISTER_TIMEOUT_MS);
				}),
			]).finally(() => clearTimeout(timer));
			log.info("module loaded", { module: m.manifest.id, version: m.manifest.version, routes: m.routes.length });
		} catch (err) {
			m.routes = [];
			m.error = (err as Error).message || String(err);
			log.error("module failed to load", { module: m.manifest.id, err: m.error });
		}
	}

	/** Finds the route for a request below /api/v1/m/<id>. */
	match(id: string, method: string, segments: string[]): { route: ModuleRoute; params: Record<string, string> } | "method" | null {
		const m = this.modules.get(id);
		if (!m || m.error) return null;
		let pathMatched = false;
		for (const r of m.routes) {
			if (r.segments.length !== segments.length) continue;
			const params: Record<string, string> = {};
			let ok = true;
			for (const [i, seg] of r.segments.entries()) {
				const actual = segments[i]!;
				if (seg.startsWith(":")) {
					if (actual === "") ok = false;
					else {
						try {
							params[seg.slice(1)] = decodeURIComponent(actual);
						} catch {
							ok = false;
						}
					}
				} else if (seg !== actual) ok = false;
				if (!ok) break;
			}
			if (!ok) continue;
			pathMatched = true;
			if (r.method === method) return { route: r, params };
		}
		return pathMatched ? "method" : null;
	}

	/** Runs a handler and turns its result into a status and body. */
	async run(route: ModuleRoute, req: Omit<ModuleRequest, "user">, user: User): Promise<{ status: number; body: unknown }> {
		const result = await route.handler({ ...req, user: moduleUser(user) });
		if (result instanceof ModuleResponse) return { status: result.status, body: result.body };
		return result === undefined ? { status: 204, body: undefined } : { status: 200, body: result };
	}

	/** The file to serve for /m/<id>/<rest>, or null. */
	async uiFile(id: string, rest: string): Promise<string | null> {
		const m = this.modules.get(id);
		if (!m || !m.manifest.ui) return null;
		const root = path.join(m.dir, m.manifest.ui);
		let rel: string;
		try {
			rel = path.posix.normalize("/" + decodeURIComponent(rest)).slice(1);
		} catch {
			return null;
		}
		if (rel.includes("\0") || rel.split("/").some((s) => s.startsWith("."))) return null;
		const tryFile = async (p: string) => ((await fsp.stat(p).catch(() => null))?.isFile() ? p : null);
		const file = path.join(root, rel === "" ? "index.html" : rel);
		if (file !== root && !file.startsWith(root + path.sep)) return null;
		// Unknown paths without an extension get index.html (client-side routing).
		return (await tryFile(file)) ?? (path.extname(rel) === "" ? tryFile(path.join(root, "index.html")) : null);
	}

	/** Sidebar entries for running modules with a UI. */
	nav(): { id: string; label: string; icon: string | null }[] {
		return [...this.modules.values()]
			.filter((m) => !m.error && m.manifest.ui && m.manifest.nav)
			.map((m) => ({ id: m.manifest.id, label: m.manifest.nav!.label, icon: m.manifest.nav!.icon }));
	}
}
