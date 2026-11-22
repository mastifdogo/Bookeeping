// Runs installed modules inside the Ledger server. At startup each module's
// server file is imported and its `register(ctx)` called; the context lets
// it add API routes under /api/v1/m/<id>/, query the database (as the app's
// restricted role, plus full access to its own schema mod_<id>), and use the
// ledger's own functions. Its UI directory is served at /m/<id>/.
//
// A module that fails to load is reported on the Modules page and skipped;
// the rest of Ledger keeps running.

import { rateOfTags, ratesOfTags, removeTag, removeTags, setTag, setTags, STANDARD_TAGS, tagsOf, type TagChange } from "./tags.ts";

type TagOpts = { id?: number | null; entity_id?: number | null; note?: string; description?: string | null; quantity?: number | string | null; unit?: string | null; rate_cents?: number | null };
const tagOpts = (o: TagOpts) => ({ id: o?.id, entity_id: o?.entity_id, note: o?.note, description: o?.description, quantity: o?.quantity, unit: o?.unit, rate_cents: o?.rate_cents });
type RateOpts = { id?: number | null; description?: string | null; quantity?: number | string | null; unit?: string | null; rate_cents?: number | null; note?: string };
import { rootModuleDelete, rootModuleUpdate } from "./root.ts";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "./app.ts";
import { HttpError } from "./errors.ts";
import { log } from "./log.ts";
import { builtFor, compatible, scanInstalled, type InstalledModule, type ModuleManifest } from "./modules.ts";
import { createAccount, ensureClearingAccount, getAccount, getAccountLedger, getTrialBalance, listAccounts, listClearingAccounts } from "./accounts.ts";
import { createJournalEntry, getJournalEntry, linkedEntries, linkJournalEntry, listJournalEntries, reverseJournalEntry, unlinkJournalEntry, editJournalEntry } from "./ledger.ts";
import { getBalanceSheet, getIncomeStatement } from "./reports.ts";
import { getReconciliation, listReconciliations } from "./reconcile.ts";
import { startReconciliation, type ReconciliationStart } from "./statement-reading.ts";
import { paymentsOf, relateEntries, relatedEntries, unrelateEntries } from "./related.ts";
import { createEntity, ensureEntity, findEntity, getEntity, listEntities, updateEntity, type EntityInput, type EntityRole } from "./entities.ts";
import { entityAccount, postEntityPayment } from "./entity-accounts.ts";
import { moduleValues, saveSettings, type SettingValue } from "./module-settings.ts";
import type { SearchProvider } from "./search.ts";
import { connectionReady, llmComplete, pickConnection, PROVIDER_INFO, readLlmConfig, type LlmRequest } from "./llm.ts";
import { gmailFor } from "./gmail.ts";
import { mailFor } from "./mail.ts";
import { documentsFor, type DocumentInfo } from "./documents.ts";
import { filesFor, type FileSummary } from "./module-files.ts";
import { ONE_FILE_STORE_SINCE, storageFor } from "./module-storage.ts";
import type { DocumentTagChange } from "./document-tags.ts";
import { queryRows } from "./db.ts";
import { callImport, checkImportSpec, type ImportRow, type ImportSpec } from "./module-import.ts";
import { currentOrg, forEachOrg, getOrganization, listOrganizations, type OrgKind } from "./orgs.ts";
import { listBySource, postItem, removeByKey, setClosedByKey, type ItemInput, type ItemKind } from "./dashboard.ts";
import { isCurrency, publicUser, type EntryLinkInput, type AccountCreate, type Currency, type JournalEntryCreate, type User } from "./types.ts";

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
	/** The logged-in user, their role ("admin", "bookkeeper" or "viewer") in the organization the request works in, and that organization. */
	user: { username: string; role: string; root: boolean; organization: { id: number; name: string; kind: string } };
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
	/** ctx.files.onReceive listeners. */
	fileListeners: ((file: FileSummary) => unknown)[];
	documentListeners: ((doc: DocumentInfo) => unknown)[];
	/** ctx.documents.tags.onChange listeners: told of every tag set on or taken off a document. */
	documentTagListeners: ((change: DocumentTagChange) => unknown)[];
	/**
	 * Built for a Ledger older than 0.27.0, when modules could still keep files in
	 * folders of their own (ctx.storage): it keeps working, and the Modules page says to update it.
	 */
	ownFiles: boolean;
	accountCodeListeners: ((change: { old_code: string; new_code: string }) => unknown)[];
	/** ctx.root.onCheck functions: what in the module's records keeps root mode from being left. */
	rootChecks: (() => unknown)[];
	/** ctx.tags.onChange listeners: told of every tag set on or taken off an entry, whoever did it. */
	tagListeners: ((change: TagChange) => unknown)[];
	/** ctx.search.provide functions. */
	searchProviders: SearchProvider[];
	/** ctx.settings.onChange listeners. */
	settingsListeners: ((values: Record<string, SettingValue>) => unknown)[];
	/** ctx.imports.provide: the module's "Import from CSV" (Settings tab). */
	importer: ImportSpec | null;
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
		entity_id: typeof o.entity_id === "number" ? o.entity_id : typeof o.entity_id === "bigint" ? Number(o.entity_id) : null,
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

/** A journal entry id from a module (number, bigint or digits); anything else is "not found". */
function entryIdOf(v: unknown): bigint {
	if (typeof v === "bigint" && v > 0n) return v;
	if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
	if (typeof v === "string" && /^[1-9]\d{0,17}$/.test(v)) return BigInt(v);
	throw new HttpError(404, "no such journal entry", "not_found");
}

const cur = (c: string | null | undefined): Currency | null => (c && isCurrency(c.toUpperCase()) ? (c.toUpperCase() as Currency) : null);

// Users passed to modules: the internal id stays out of reach of the module's
// JSON, but the host can still attribute entries to the right person.
const userIds = new WeakMap<object, number>();
function moduleUser(u: User): ModuleRequest["user"] {
	const pub = { username: publicUser(u).username, role: u.role, root: u.root && u.role === "admin", organization: { id: u.org.id, name: u.org.name, kind: u.org.kind } };
	userIds.set(pub, u.id);
	fullUsers.set(pub, u);
	return pub;
}
const fullUsers = new WeakMap<object, User>();
/** The logged-in user behind a request handed to a module (for ctx.root). */
function rootUser(req: unknown): User {
	const u = req && typeof req === "object" ? fullUsers.get((req as { user?: object }).user ?? {}) : undefined;
	if (!u) throw new HttpError(400, "ctx.root needs the request (req) the handler was given");
	return u;
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
		/**
		 * Tags on journal entries, shared by Ledger and every module (Ledger
		 * 0.23.0): "paid", "billed", "overdue", "customer" and "vendor" (these two
		 * with entity_id), or any lowercase word modules agree on. A tag is on
		 * the entry, not owned by the module that set it: any module or a person
		 * can take it off, and everyone sees it.
		 */
		tags: {
			standard: [...STANDARD_TAGS],
			/** The entry's tags. */
			of: (entryId: number | bigint | string) => tagsOf(app, entryIdOf(entryId)),
			/** Tags the entry: set(entryId, "paid") or set(entryId, "customer", { entity_id }). "paid" takes "overdue" off. Returns its tags. */
			set: (entryId: number | bigint | string, tag: string, opts: TagOpts = {}, user?: { username: string }) =>
				setTag(app, entryIdOf(entryId), { tag, ...tagOpts(opts) }, { moduleId: id, userId: actorOf(user) }),
			/** Tags many entries at once, all or none (at most 500): setMany([12, 13], "billed"). Returns { entries, changed }. */
			setMany: (entryIds: (number | bigint | string)[], tag: string, opts: TagOpts = {}, user?: { username: string }) =>
				setTags(app, entryIds, { tag, ...tagOpts(opts) }, { moduleId: id, userId: actorOf(user) }),
			/** Takes the tag off many entries at once. Returns { entries, changed }. */
			removeMany: (entryIds: (number | bigint | string)[], tag: string, opts: { entity_id?: number | null } = {}) => removeTags(app, entryIds, { tag, entity_id: opts?.entity_id }, { moduleId: id }),
			/**
			 * Rate items (Ledger 0.24.0; description and several per entry since 0.25.0): description,
			 * quantity and rate, so forms fill themselves in. addRate(entryId, { description: "Labour",
			 * quantity: 7.5, unit: "hours", rate_cents: 8000 }) adds one and returns it; setRate does the
			 * same, or changes the item named by `id`. rates(entryId) → every item,
			 * [{ id, description, quantity, unit, rate_cents, amount_cents }]; rate(entryId) → the first or null.
			 * removeRate(entryId, itemId) takes one off.
			 */
			addRate: (entryId: number | bigint | string, r: RateOpts, user?: { username: string }) =>
				setTag(app, entryIdOf(entryId), { tag: "rate", ...tagOpts({ ...(r ?? {}), id: null }) }, { moduleId: id, userId: actorOf(user) }).then((tags) => ratesOfTags(tags).at(-1) ?? null),
			setRate: (entryId: number | bigint | string, r: RateOpts, user?: { username: string }) =>
				setTag(app, entryIdOf(entryId), { tag: "rate", ...tagOpts(r ?? {}) }, { moduleId: id, userId: actorOf(user) }).then((tags) => {
					const all = ratesOfTags(tags);
					return (r?.id ? all.find((x) => x.id === Number(r.id)) : all.at(-1)) ?? null;
				}),
			rates: async (entryId: number | bigint | string) => ratesOfTags(await tagsOf(app, entryIdOf(entryId))),
			rate: async (entryId: number | bigint | string) => rateOfTags(await tagsOf(app, entryIdOf(entryId))),
			removeRate: (entryId: number | bigint | string, itemId: number) => removeTag(app, entryIdOf(entryId), { tag: "rate", id: Number(itemId) || -1 }, { moduleId: id }).then(ratesOfTags),
			/** Takes the tag off (for "customer"/"vendor": that entity, or all when none is given; for "rate": the item `id`, or all). Returns the entry's tags. */
			remove: (entryId: number | bigint | string, tag: string, opts: { entity_id?: number | null; id?: number | null } = {}) => removeTag(app, entryIdOf(entryId), { tag, entity_id: opts?.entity_id, id: opts?.id }, { moduleId: id }),
			/** Entries carrying a tag and/or belonging to a customer or vendor, newest first: { tag?, entity_id?, from?, to?, limit?, offset? }. */
			entries: (f: { tag?: string; entity_id?: number; from?: string; to?: string; limit?: number; offset?: number } = {}) =>
				listJournalEntries(app, {
					from: f.from ?? null,
					to: f.to ?? null,
					accountCode: null,
					tag: typeof f.tag === "string" ? f.tag.trim().toLowerCase() : null,
					entityId: Number.isSafeInteger(f.entity_id) ? (f.entity_id as number) : null,
					limit: Math.min(Math.max(Number(f.limit) || 100, 1), 500),
					offset: Math.max(Number(f.offset) || 0, 0),
				}),
			/** fn({ entry_id, action: "set" | "removed", tag, entity_id, module_id }) after every change, by any module or a person. */
			onChange(fn: (change: TagChange) => unknown) {
				if (typeof fn !== "function") throw new Error("tags.onChange: expected a function");
				m.tagListeners.push(fn);
			},
		},
		/**
		 * Root mode (Ledger 0.21.1): while an admin has root mode on (req.user.root),
		 * the module lets them delete or change any of its records. Do it through
		 * these, so Ledger keeps the row as it was and can put it back when the
		 * action, or the whole root session, is reversed. The table is one of the
		 * module's own with an `id` column. Rows that go with a deleted row
		 * (ON DELETE CASCADE) are not kept: remove those first, one by one.
		 */
		root: {
			remove: (req: unknown, table: string, rowId: unknown, summary?: string) => rootModuleDelete(app, { id, name: m.manifest.name, schema: `mod_${id.replaceAll("-", "_")}` }, table, rowId, rootUser(req), summary),
			update: (req: unknown, table: string, rowId: unknown, set: Record<string, unknown>, summary?: string) =>
				rootModuleUpdate(app, { id, name: m.manifest.name, schema: `mod_${id.replaceAll("-", "_")}` }, table, rowId, set, rootUser(req), summary),
			/** fn returns a list of problems (text) that must be fixed before root mode can be left; [] when the module's records are sound. */
			onCheck(fn: () => unknown) {
				if (typeof fn !== "function") throw new Error("root.onCheck: needs a function");
				m.rootChecks.push(fn);
			},
		},
		route(method: Method, routePath: string, handler: Handler) {
			if (!METHODS.includes(method)) throw new Error(`route: unsupported method ${method}`);
			if (!/^\/[A-Za-z0-9_\-/:.]*$/.test(routePath)) throw new Error(`route: invalid path ${routePath}`);
			if (typeof handler !== "function") throw new Error("route: handler must be a function");
			m.routes.push({ method, segments: routePath.split("/").slice(1), handler });
		},
		/**
		 * The values of the settings declared in ledger-module.json (defaults
		 * filled in, secrets included). Each organization has its own values:
		 * the request's organization, the main books outside a request, or
		 * the one ctx.orgs.forEach is visiting.
		 */
		settings: {
			get: () => moduleValues(app.db, id, m.manifest.settings ?? { fields: [], page: null, tabs: [] }),
			/** Saves some values (validated like the form); other keys keep theirs. */
			set: async (values: Record<string, SettingValue>) => {
				await saveSettings(app.db, id, m.manifest.settings ?? { fields: [], page: null, tabs: [] }, values, null);
				await notifySettings(app, m);
			},
			/** Called with the new values after they change (the user saved the form, or set()), inside that organization. */
			onChange(fn: (values: Record<string, SettingValue>) => unknown) {
				if (typeof fn !== "function") throw new Error("settings.onChange: expected a function");
				m.settingsListeners.push(fn);
			},
		},
		/**
		 * The LLM connections set up under Settings → LLM API (an admin must
		 * allow this module there). complete() returns { text, model, usage };
		 * json() also parses the answer against a JSON schema into data.
		 * Requests with images or documents go to the connection for images,
		 * others to the one for text, unless r.connection names one.
		 */
		llm: {
			status: async () => {
				const c = await readLlmConfig(app.integrations.dir);
				const text = pickConnection(c, "text");
				const images = pickConnection(c, "images");
				return {
					configured: text !== null,
					allowed: c.allow_modules.includes(id),
					provider: text?.provider ?? null,
					model: text?.model || null,
					images: { configured: images !== null, provider: images?.provider ?? null, model: images?.model || null },
					readsPdf: images !== null && PROVIDER_INFO[images.provider].pdf,
					connections: c.connections.filter(connectionReady).map((x) => ({ id: x.id, name: x.name, uses: [...x.uses], provider: x.provider, model: x.model })),
				};
			},
			complete: (r: LlmRequest) => llmComplete(app, id, { ...r, schema: undefined }),
			json: (r: LlmRequest & { schema: object }) => {
				if (!r || typeof r.schema !== "object" || r.schema === null) throw new HttpError(400, "llm.json needs a JSON schema");
				return llmComplete(app, id, r);
			},
		},
		/** Gmail, connected under Settings → Mail → Gmail (an admin must allow reading and sending per module). */
		gmail: gmailFor(app, id),
		/**
		 * The shared mailbox, whatever kind it is: the IMAP/SMTP account under
		 * Settings → Mail (Proton Mail Bridge or any other) when one is set
		 * up, else Gmail. status, search, message, raw, attachment, send.
		 */
		mail: mailFor(app, id),
		/**
		 * Files for and from other modules (statements, bills, receipts,
		 * transaction lists), without posting anything. Receive them by
		 * declaring "files": {"accepts": [...]} in the manifest.
		 */
		/**
		 * Organizations (separate books, each in its own database). A request
		 * runs in the user's current organization and ctx.db, ctx.ledger and
		 * the rest follow it; background work runs in the main books unless it
		 * uses forEach.
		 */
		orgs: {
			current: async () => {
				const o = await getOrganization(app, currentOrg().id);
				return { id: o.id, name: o.name, kind: o.kind };
			},
			list: async () =>
				(await listOrganizations(app)).filter((o) => o.status === "ready").map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
			/** Runs fn({ id, name, kind }) once inside each organization, one after another. */
			forEach: (fn: (org: { id: number; name: string; kind: OrgKind }) => unknown) => {
				if (typeof fn !== "function") throw new Error("orgs.forEach: expected a function");
				return forEachOrg(app, fn);
			},
		},
		/**
		 * Files the module stored in a folder of its own before Ledger 0.27.0.
		 * Modules keep no files of their own any more: a module built for
		 * 0.27.0 or newer can read, list and remove them (to move them into
		 * Documents) but put() answers 410.
		 */
		storage: storageFor(app, id, m.ownFiles),
		/**
		 * The one file store, for every file a module receives, makes or
		 * keeps, of any type: list, get, read, add, ensure, update, remove,
		 * mark, unmark, url, onAdded; tags (shared by all modules) and
		 * extracted / setExtracted (what was read out of a file, kept with it
		 * so no module reads it twice).
		 */
		documents: documentsFor(app, id, actorOf, m.documentListeners, m.documentTagListeners),
		files: {
			...filesFor(app, id, actorOf),
			/** Called with the file's summary right after another module sends this one a file. */
			onReceive(fn: (file: FileSummary) => unknown) {
				if (typeof fn !== "function") throw new Error("files.onReceive: expected a function");
				m.fileListeners.push(fn);
			},
		},
		/** Results in Ledger's search bar. */
		/**
		 * "Import from CSV" on the module's Settings tab. provide({ label,
		 * description?, fields: [{ key, label, type: text|number|money|date|boolean,
		 * required?, help? }], handler(rows, { dryRun, user }) → { summary?, errors? } }).
		 * Ledger maps the CSV's columns to the fields (AI or column names) and
		 * converts values; the handler checks (dryRun) and then imports the rows.
		 */
		imports: {
			provide(spec: unknown) {
				m.importer = checkImportSpec(spec);
			},
		},
		search: {
			/**
			 * Registers fn(query, { limit, user }) returning (or resolving to)
			 * [{ title, subtitle?, href }], href a path inside Ledger such as
			 * "/apps/<id>/invoices/7". Called for every search; answer within 2 s.
			 */
			provide(fn: SearchProvider) {
				if (typeof fn !== "function") throw new Error("search.provide: expected a function");
				m.searchProviders.push(fn);
			},
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
		/**
		 * Customers and vendors: one list shared by Ledger and every module, per
		 * organization. Use it instead of a table of your own names.
		 */
		entities: {
			list: (f: { role?: EntityRole; q?: string; includeInactive?: boolean } = {}) => listEntities(app, f),
			get: (entityId: number) => getEntity(app, Number(entityId)),
			find: (name: string) => findEntity(app, name),
			create: (e: EntityInput) => createEntity(app, e),
			update: (entityId: number, e: EntityInput) => updateEntity(app, Number(entityId), e),
			/** The entity with that name in that role ("customer" | "vendor"), created or given the role if needed. */
			ensure: (name: string, role: EntityRole, details?: EntityInput) => ensureEntity(app, name, role, details),
			/**
			 * The customer's or vendor's own account in a currency (Ledger 0.31.0): a
			 * sub-account of accounts receivable (role "customer") or payable (role
			 * "vendor"), made the first time it is asked for. Post an invoice or a
			 * bill to it, and the payment that settles it: its balance is what the
			 * customer owes or the vendor is owed (entity.accounts[].owed_cents).
			 * Always look it up with this, never by a saved code.
			 */
			account: (entityId: number, role: EntityRole, currency: string) => entityAccount(app, Number(entityId), role, currency),
			/**
			 * Posts a payment between a bank or card account and the vendor's
			 * (role "vendor": a bill is paid) or customer's (role "customer": a
			 * payment is received) own account: { role, account_code, entry_date,
			 * amount_cents, description?, reference? } → the entry.
			 */
			payment: (entityId: number, p: { role: EntityRole; account_code: string; entry_date: string; amount_cents: number | bigint | string; description?: string; reference?: string }, user?: { username: string }) =>
				postEntityPayment(app, Number(entityId), { ...p, amount_cents: toCents(p?.amount_cents, "amount_cents") }, actorOf(user)),
		},
		/**
		 * Reconciling an account against a statement (Ledger 0.34.0), on Ledger's
		 * Reconcile page: the statement beside the account's lines, the matching
		 * ones ticked, a person checks the rest and finishes.
		 */
		reconcile: {
			/**
			 * Opens a reconciliation and returns it with `href`, the page to send
			 * the user to: { account_code, document_id?, statement_date?,
			 * statement_balance_cents?, lines?: [{ date, description, amount_cents }],
			 * opening_balance_cents?, period_start? }. With `lines` (in the account's
			 * natural sign: what makes its balance go up is positive) the module has
			 * read the statement; with only document_id Ledger reads it; an account's
			 * reconciliation already in progress is returned as it is. For a
			 * vendor's statement use the vendor's own account
			 * (ctx.entities.account): invoices are positive, payments negative, and
			 * what isn't ticked stays in the account when it is finished.
			 */
			start: async (input: ReconciliationStart, user?: { username: string }) => {
				const d = await startReconciliation(app, input, actorOf(user));
				return { ...d, href: `/reconcile/${d.reconciliation.id}` };
			},
			/** The account's reconciliation in progress (with href), or null. */
			open: async (accountCode: string) => {
				const r = (await listReconciliations(app, String(accountCode))).find((x) => x.status === "open");
				return r ? { ...(await getReconciliation(app, BigInt(r.id))), href: `/reconcile/${r.id}` } : null;
			},
			/** One reconciliation in full (lines, totals, difference_cents, reading with matched and unmatched statement lines), with href. */
			get: async (id: number | bigint | string) => ({ ...(await getReconciliation(app, entryIdOf(id))), href: `/reconcile/${id}` }),
			/** The account's reconciliations, newest first (open one first). */
			list: (accountCode: string) => listReconciliations(app, String(accountCode)),
		},
		ledger: {
			listAccounts: (opts: { includeInactive?: boolean } = {}) => listAccounts(app, opts.includeInactive ?? false),
			getAccount: (code: string) => getAccount(app, code),
			/**
			 * Called with { old_code, new_code } after someone changes an account's code.
			 * Ledger has already rewritten the code in this module's settings (text values
			 * under a key with "account" in it) and tables (columns named account_code,
			 * *_account_code or *_account); use this for anywhere else the module keeps one.
			 */
			onAccountCodeChanged(fn: (change: { old_code: string; new_code: string }) => unknown) {
				if (typeof fn !== "function") throw new Error("ledger.onAccountCodeChanged: expected a function");
				m.accountCodeListeners.push(fn);
			},
			createAccount: (a: AccountCreate) => createAccount(app, { code: a.code, name: a.name, type: a.type, currency: a.currency, description: a.description ?? "", parent_code: a.parent_code ?? null, kind: a.kind ?? null }),
			/**
			 * This module's own clearing account, made the first time it is asked for:
			 * { key, name, currency, type?: "asset" | "liability", description? } → the account.
			 * Post one side of a transaction to it and the other side later; it should
			 * come back to zero. Always look it up with this (by key), never by a saved
			 * code: a person can renumber it.
			 */
			clearingAccount: (a: { key: string; name: string; currency: string; type?: string; description?: string }) => ensureClearingAccount(app, id, m.manifest.name, a),
			/** Every clearing account, whichever module made it (module_id, module_key), with its balance. */
			clearingAccounts: () => listClearingAccounts(app),
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
			/**
			 * Posts a balanced entry; pass the request's user so it is attributed
			 * to them. entry.links: [{ ref, label, href? }] links it to this
			 * module's records in the same transaction.
			 */
			createJournalEntry: (entry: unknown, user?: { username: string }) => {
				const links = (entry as { links?: unknown } | null)?.links;
				if (links !== undefined && (!Array.isArray(links) || links.length > 50)) throw new HttpError(422, "links must be a list of at most 50 { ref, label, href? }");
				return createJournalEntry(app, toEntry(entry), actorOf(user), links ? { moduleId: id, links: links as EntryLinkInput[] } : undefined);
			},
			/**
			 * Moves one line of a posted entry to another account of the same
			 * currency (Ledger 0.32.0): moveLine(entryId, lineNumber, accountCode,
			 * { reason }, user) → the entry. For a line posted to a stand-in
			 * (accounts payable or receivable) until the bank or card transaction
			 * it belongs to is known. Refused (409) for a line ticked on a
			 * reconciliation and for an entry that was reversed or is a reversal;
			 * the move is logged on the entry.
			 */
			moveLine: (entryId: number | bigint | string, lineNumber: number, accountCode: string, opts: { reason?: string } = {}, user?: { username: string }) =>
				editJournalEntry(app, entryIdOf(entryId), { lines: [{ line_number: Number(lineNumber), account_code: String(accountCode) }], reason: opts?.reason }, actorOf(user)),
			/** Links an existing entry to one of this module's records ({ ref, label, href? }); the same ref again updates it. */
			linkJournalEntry: (entryId: number | bigint | string, link: EntryLinkInput, user?: { username: string }) =>
				linkJournalEntry(app, entryIdOf(entryId), id, link, actorOf(user)),
			/** Removes this module's link with that ref from an entry; false if there was none. */
			unlinkJournalEntry: (entryId: number | bigint | string, ref: string) => unlinkJournalEntry(app, entryIdOf(entryId), id, ref),
			/** Entries linked to one of this module's records (all of them without ref): [{ entry_id, ref, label, href, reversed }]. */
			linkedEntries: (ref?: string) => linkedEntries(app, id, ref === undefined ? undefined : String(ref)),
			/**
			 * Links two journal entries to each other (a payment and the invoice
			 * it settles): each then shows on the other's page. opts.note says
			 * what the link is; the same pair again changes the note.
			 */
			relateEntries: async (entryId: number | bigint | string, otherId: number | bigint | string, opts: { note?: string } = {}, user?: { username: string }) => {
				await relateEntries(app, entryIdOf(entryId), entryIdOf(otherId), opts?.note, { moduleId: id, userId: actorOf(user) });
				return relatedEntries(app, entryIdOf(entryId));
			},
			/** Takes off the link between two entries (whoever made it); false if there was none. */
			unrelateEntries: (entryId: number | bigint | string, otherId: number | bigint | string) => unrelateEntries(app, entryIdOf(entryId), entryIdOf(otherId), { moduleId: id, userId: null }),
			/**
			 * Says that entry `paymentId` is a payment of entry `entryId` (Ledger
			 * 0.33.0): linkPayment(billEntry, paymentEntry, { amount_cents?, note? },
			 * user). amount_cents is how much of the payment goes to this entry when
			 * it pays several (left out: all of it); the same pair again changes it.
			 * Neither entry changes. The payment shows on the entry's page with what
			 * is paid and what is left, and Ledger keeps one of the tags unpaid,
			 * partially_paid or paid on the entry paid (ctx.tags.onChange tells you).
			 * Returns { currency, due_cents, paid_cents, left_cents, status, payments }.
			 */
			linkPayment: async (entryId: number | bigint | string, paymentId: number | bigint | string, opts: { amount_cents?: number | bigint | string | null; note?: string } = {}, user?: { username: string }) => {
				const cents = opts?.amount_cents === undefined || opts.amount_cents === null ? null : toCents(opts.amount_cents, "amount_cents");
				await relateEntries(app, entryIdOf(entryId), entryIdOf(paymentId), opts?.note, { moduleId: id, userId: actorOf(user) }, { amount_cents: cents });
				return paymentsOf(app, entryIdOf(entryId));
			},
			/** Takes a payment off an entry (the link goes; the entry is partially paid or unpaid again). false if there was no link. */
			unlinkPayment: (entryId: number | bigint | string, paymentId: number | bigint | string, user?: { username: string }) =>
				unrelateEntries(app, entryIdOf(entryId), entryIdOf(paymentId), { moduleId: id, userId: actorOf(user) }),
			/** An entry's linked payments and what is left: { currency, due_cents, paid_cents, left_cents, status, payments: [{ entry_id, entry_date, description, amount_cents, counted, note }] }, or null when none is linked. */
			payments: (entryId: number | bigint | string) => paymentsOf(app, entryIdOf(entryId)),
			/** Every entry linked to this one, oldest first: [{ id, entry_date, description, reference, totals, tags, reversed, direct, why }]. */
			relatedEntries: (entryId: number | bigint | string) => relatedEntries(app, entryIdOf(entryId)),
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

/** Tells a module its settings changed. A failing listener is logged, never fatal. */
export async function notifySettings(app: App, m: LoadedModule): Promise<void> {
	if (!m.settingsListeners.length || !m.manifest.settings) return;
	const values = await moduleValues(app.db, m.manifest.id, m.manifest.settings);
	for (const fn of m.settingsListeners) {
		try {
			await fn({ ...values });
		} catch (err) {
			log.error("module settings listener failed", { module: m.manifest.id, err: (err as Error).message });
		}
	}
}

const REGISTER_TIMEOUT_MS = 15_000;

/**
 * Modules keep no files in their own tables (Ledger 0.27.0): every file is in
 * Documents and a table holds only the document's id. A module built for
 * 0.27.0 or newer whose schema still has a binary (bytea) column is not
 * started; its error says which columns to move and drop.
 */
async function refuseOwnFileColumns(app: App, m: LoadedModule): Promise<void> {
	if (m.ownFiles) return;
	const cols = await queryRows<{ t: string; c: string }>(
		app.db,
		`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND data_type = 'bytea' ORDER BY 1, 2`,
		[`mod_${m.manifest.id.replaceAll("-", "_")}`],
	);
	if (cols.length === 0) return;
	const list = cols.slice(0, 6).map((x) => `${x.t}.${x.c}`).join(", ") + (cols.length > 6 ? ", …" : "");
	throw new Error(`keeps files in its own tables (${list}): since Ledger ${ONE_FILE_STORE_SINCE} every file goes in Documents (ctx.documents) and tables hold only the document's id. The module's previous version moves the bytes into Documents; this one's migrations then drop the column${cols.length === 1 ? "" : "s"} (refusing while any row still holds bytes)`);
}

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
			settingsListeners: [],
			searchProviders: [],
			fileListeners: [],
			documentListeners: [],
			documentTagListeners: [],
			ownFiles: !builtFor(inst.manifest, ONE_FILE_STORE_SINCE),
			accountCodeListeners: [],
			rootChecks: [],
			tagListeners: [],
			importer: null,
		};
		this.modules.set(m.manifest.id, m);
		if (!compatible(m.manifest, app.version)) {
			m.error = `needs Ledger ${m.manifest.ledger} (this is ${app.version})`;
			return;
		}
		if (!m.manifest.server) return;
		try {
			await refuseOwnFileColumns(app, m);
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

	/** Hands imported rows to a module's ctx.imports handler (a dry run first, from the preview). */
	runImport(id: string, rows: ImportRow[], dryRun: boolean, user: User) {
		const m = this.modules.get(id);
		if (!m?.importer || m.error) throw new HttpError(404, "this module has no CSV import", "not_found");
		return callImport(m.importer, rows, dryRun, moduleUser(user));
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
	nav(): { id: string; label: string; icon: string | null; icon_path: string | null; icon_fill: boolean; icon_url: string | null }[] {
		return [...this.modules.values()]
			.filter((m) => !m.error && m.manifest.ui && m.manifest.nav)
			.map((m) => {
				const n = m.manifest.nav!;
				return {
					id: m.manifest.id,
					label: n.label,
					icon: n.icon,
					icon_path: n.icon_path,
					icon_fill: n.icon_fill,
					icon_url: n.icon_file ? `/m/${m.manifest.id}/${n.icon_file}` : null,
				};
			});
	}
}
