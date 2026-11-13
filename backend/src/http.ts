// HTTP layer. Paths match api/openapi.yaml under /api/v1; everything else
// serves the built SvelteKit frontend.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { isPgError, withDatabase, withTx } from "./db.ts";
import {
	BadCredentialsError,
	ConflictError,
	HttpError,
	NotFoundError,
	TooLargeError,
	TooManyLoginsError,
	UnauthorizedError,
	ValidationError,
	type FieldError,
} from "./errors.ts";
import { parseDate } from "./date.ts";
import { log } from "./log.ts";
import { ACCOUNT_CODE_RE, isCurrency, MAIN_ROLES, publicUser, roleAtLeast, ROLES, type Currency, type MainRole, type Role, type User } from "./types.ts";
import {
	DecodeError,
	decodeAccountCreate,
	decodeAccountUpdate,
	decodeExportRequest,
	decodeImportRequest,
	decodeJournalEntryCreate,
	decodeLoginRequest,
	decodePasswordChange,
	decodeReverseRequest,
	decodeReconciliationCreate,
	decodeReconciliationUpdate,
	decodeClearedChange,
	parseJson,
	plainJson,
} from "./decode.ts";
import {
	baseUpdateRepo,
	nextScheduledTime,
	readSchedule,
	readUpdateRepo,
	readStatus,
	requestRunNow,
	updaterInstalled,
	validateSchedule,
	writeSchedule,
	writeUpdateRepo,
} from "./update.ts";
import { createAccount, getAccount, getAccountLedger, getTrialBalance, listAccounts, listCurrencies, updateAccount } from "./accounts.ts";
import { createJournalEntry, getJournalEntry, listJournalEntries, reverseJournalEntry, type EntryFilter } from "./ledger.ts";
import { getBalanceSheet, getIncomeStatement } from "./reports.ts";
import { CSV_FILENAME_RE, MAX_FILE_BYTES, exportGeneralLedger, listCsvFiles, openCsvFile, saveUploadedCsv } from "./files.ts";
import { importJournalEntries } from "./import.ts";
import { getDashboard, setItemClosed } from "./dashboard.ts";
import { search } from "./search.ts";
import { integrationsAvailable, requireIntegrations, writeIntegration } from "./integrations.ts";
import { applyLlmChange, llmComplete, llmUsage, pickConnection, publicLlmConfig, readLlmConfig } from "./llm.ts";
import { analyzeUpload, cleanMapping, getUpload, MIGRATION_KINDS, planFor, runMigration } from "./migrate.ts";
import { analyzeImport, cleanImportMapping, getImportUpload, publicPlan } from "./module-import.ts";
import { applyGmailChange, codeFromPaste, finishAuth, publicGmailConfig, readGmailConfig, REDIRECT_URI, revoke as revokeGmail, startAuth } from "./gmail.ts";
import { decodeSidebar, getSidebar, putSidebar } from "./settings.ts";
import {
	applyConfigChange,
	backupsInstalled,
	fetchDriveBackup,
	fetchShareBackup,
	isBackupFolder,
	isSettingsFolder,
	listDriveBackups,
	SETTINGS_FILE,
	orgBackupDir,
	readOrgConfig,
	listShareDumps,
	checkShare,
	nextBackupTime,
	pollDeviceFlow,
	publicConfig,
	readBackupStatus,
	revokeGoogle,
	runBackup,
	startDeviceFlow,
	testShare,
	writeConfig,
} from "./backup.ts";
import { RESTORE_CONFIRM, prepareRestore, readRestoreStatus, readSettingsFile } from "./restore.ts";
import { publicSettings, saveSettings } from "./module-settings.ts";
import { notifySettings } from "./module-host.ts";
import {
	changeCleared,
	createReconciliation,
	deleteReconciliation,
	finishReconciliation,
	getReconciliation,
	listReconciliations,
	undoReconciliation,
	updateReconciliation,
} from "./reconcile.ts";
import { changePassword, createUser, findUser, hashToken, listUsers, login, logout, normalizeUsername, sessionUser, setPassword, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, updateUserAccess, validatePassword, type UserRecord } from "./auth.ts";
import {
	allMemberships,
	createOrganization,
	currentOrg,
	filesDir,
	finishSetup,
	getOrganization,
	inOrg,
	MAIN_ORG,
	listOrganizations,
	mirrorUser,
	ORG_KINDS,
	orgsForUser,
	provisionOrganization,
	refreshOrganizations,
	removeMembership,
	renameOrganization,
	setMembership,
	switchOrganization,
	validateOrgCreate,
	type Organization,
	type OrgCreate,
	type OrgKind,
} from "./orgs.ts";
import { MultipartError, formDataBoundary, parseHeaderParams, parseMultipart } from "./multipart.ts";
import { CONTENT_TYPES, staticHandler } from "./static.ts";
import { promises as fsp } from "node:fs";
import pathMod from "node:path";
import { createReadStream } from "node:fs";
import { INLINE_TYPES, openStored } from "./module-storage.ts";
import { MAX_MODULES, normalizeRepo, readDesired, readModuleResults, requestModuleSync, writeDesired, compatible, type DesiredModule } from "./modules.ts";
import { fetchManifest, githubApi, latestModuleRelease, repoIdentity } from "./github.ts";

const MAX_BODY_BYTES = 1 << 20; // 1 MiB for JSON
const MULTIPART_OVERHEAD = 64 << 10;


class BodyTooLargeError extends Error {}

interface Ctx {
	app: App;
	req: IncomingMessage;
	res: ServerResponse;
	params: Record<string, string>;
	query: URLSearchParams;
	user: User | null;
	token: string;
}

type Handler = (c: Ctx) => Promise<void>;

interface Route {
	method: string;
	segments: string[];
	/** The least role allowed in the current organization, "server" for server admins only; null for routes that need no login. */
	role: Role | "server" | null;
	handler: Handler;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** JSON.stringify that writes bigint values as exact JSON numbers. */
export function toJson(v: unknown): string {
	const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
	return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? rawJSON(x.toString()) : x));
}

function writeJSON(res: ServerResponse, status: number, v: unknown): void {
	const body = toJson(v) + "\n";
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

function writeError(res: ServerResponse, status: number, code: string, message: string, details?: FieldError[]): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const error: { code: string; message: string; details?: FieldError[] } = { code, message };
	if (details && details.length > 0) error.details = details;
	writeJSON(res, status, { error });
}

function findCause<T>(err: unknown, test: (e: unknown) => e is T): T | undefined {
	for (let e = err, depth = 0; e && depth < 10; e = (e as Error).cause, depth++) {
		if (test(e)) return e;
	}
	return undefined;
}

const UNIQUE_MESSAGES: Record<string, string> = {
	accounts_code_unique: "an account with this code already exists",
	journal_entries_reversed_once: "this journal entry has already been reversed",
	csv_imports_sha256_unique: "this file's content has already been imported",
};

/**
 * Maps ledger and PostgreSQL errors to API error responses. Database
 * constraint violations (the last line of defence) surface as 409/422 with
 * the trigger's message rather than as opaque 500s.
 */
function writeErr(c: Ctx, err: unknown): void {
	const { res } = c;
	if (err instanceof ValidationError) return writeError(res, 422, "validation_failed", "request validation failed", err.details);
	if (err instanceof HttpError) return writeError(res, err.status, err.code, err.message);
	if (err instanceof UnauthorizedError) return writeError(res, 401, "unauthorized", "login required");
	if (err instanceof BadCredentialsError) return writeError(res, 401, "unauthorized", err.message);
	if (err instanceof TooManyLoginsError) return writeError(res, 429, "too_many_requests", err.message);
	if (err instanceof TooLargeError) return writeError(res, 413, "payload_too_large", `file is larger than ${MAX_FILE_BYTES} bytes`);
	if (err instanceof NotFoundError) return writeError(res, 404, "not_found", "not found");
	if (err instanceof ConflictError) return writeError(res, 409, "conflict", err.message);
	const pg = findCause(err, isPgError);
	if (pg) {
		const code = pg.code ?? "";
		if (code === "23505") return writeError(res, 409, "conflict", UNIQUE_MESSAGES[pg.constraint ?? ""] ?? pg.message);
		if (code === "23001") return writeError(res, 409, "conflict", pg.message); // immutability triggers
		if (code.startsWith("23") || code.startsWith("22")) return writeError(res, 422, "validation_failed", pg.message);
		if (code === "57014") return writeError(res, 503, "internal_error", "request timed out or was cancelled");
	}
	log.error("internal error", { err: err instanceof Error ? err.message : String(err), path: c.req.url?.split("?")[0] });
	writeError(res, 500, "internal_error", "internal server error");
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Reads the whole body, or throws BodyTooLargeError past limit bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (declared > limit) {
			req.resume();
			reject(new BodyTooLargeError());
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		const onData = (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				req.off("data", onData);
				req.resume(); // discard the rest
				reject(new BodyTooLargeError());
				return;
			}
			chunks.push(chunk);
		};
		req.on("data", onData);
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Reads a JSON body. An empty body yields undefined unless required. A
 * non-empty body must be sent as application/json, which browsers cannot do
 * cross-origin without a CORS preflight.
 */
async function readJSON(c: Ctx, required: boolean): Promise<unknown> {
	const ct = c.req.headers["content-type"] ?? "";
	const length = Number(c.req.headers["content-length"] ?? 0);
	if ((ct !== "" || length > 0) && parseHeaderParams(ct).type !== "application/json") {
		throw new HttpError(415, "Content-Type must be application/json", "bad_request");
	}
	let body: Buffer;
	try {
		body = await readBody(c.req, MAX_BODY_BYTES);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			c.res.setHeader("Connection", "close");
			throw new HttpError(413, "request body too large", "payload_too_large");
		}
		throw err;
	}
	const text = body.toString("utf8");
	if (text.trim() === "") {
		if (!required) return undefined;
		throw new HttpError(400, "request body is required", "bad_request");
	}
	return parseJson(text);
}

async function decodeBody<T>(c: Ctx, required: boolean, decode: (v: unknown) => T): Promise<T> {
	try {
		const v = await readJSON(c, required);
		return decode(v === undefined ? null : v);
	} catch (err) {
		if (err instanceof DecodeError) throw new HttpError(400, "invalid JSON: " + err.message, "bad_request");
		throw err;
	}
}

function queryBool(q: URLSearchParams, name: string): boolean {
	const s = q.get(name) ?? "";
	if (s === "") return false;
	if (["1", "t", "T", "TRUE", "true", "True"].includes(s)) return true;
	if (["0", "f", "F", "FALSE", "false", "False"].includes(s)) return false;
	const v = new ValidationError();
	v.add(name, "must be true or false");
	throw v;
}

function queryDate(q: URLSearchParams, name: string): string | null {
	const s = q.get(name) ?? "";
	if (s === "") return null;
	try {
		return parseDate(s);
	} catch (err) {
		const v = new ValidationError();
		v.add(name, (err as Error).message);
		throw v;
	}
}

function queryCurrency(q: URLSearchParams): Currency | null {
	const s = q.get("currency") ?? "";
	if (s === "") return null;
	const c = s.toUpperCase();
	if (!isCurrency(c)) {
		const v = new ValidationError();
		v.add("currency", "must be CAD or USD");
		throw v;
	}
	return c;
}

function queryDateRange(q: URLSearchParams): [from: string | null, to: string | null] {
	return [queryDate(q, "from"), queryDate(q, "to")];
}

/** A positive int64 path id; anything else is a 404. */
function pathId(c: Ctx, name: string): bigint {
	const s = c.params[name] ?? "";
	if (/^[+-]?[0-9]+$/.test(s)) {
		const id = BigInt(s);
		if (id >= 1n && id <= 2n ** 63n - 1n) return id;
	}
	throw new NotFoundError();
}

/** Parses an integer query parameter like Go's strconv.Atoi. */
function atoi(s: string): number | null {
	if (!/^[+-]?[0-9]+$/.test(s)) return null;
	const n = Number(s);
	return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Sessions and cookies
// ---------------------------------------------------------------------------

function sessionToken(req: IncomingMessage): string {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
		let v = part.slice(eq + 1).trim();
		if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		return v;
	}
	return "";
}

/**
 * Whether the session cookie gets the Secure flag: "true"/"false" force it;
 * "auto" sets it when the request arrived via a reverse proxy that sets
 * X-Forwarded-Proto: https (the server itself speaks plain HTTP).
 */
function secureCookie(c: Ctx): boolean {
	if (c.app.cookieSecure === "true") return true;
	if (c.app.cookieSecure === "false") return false;
	const proto = c.req.headers["x-forwarded-proto"];
	return typeof proto === "string" && proto.toLowerCase() === "https";
}

function setSessionCookie(c: Ctx, token: string, maxAge: number): void {
	const attrs = [`${SESSION_COOKIE}=${token}`, "Path=/", `Max-Age=${Math.max(maxAge, 0)}`, "HttpOnly"];
	if (secureCookie(c)) attrs.push("Secure");
	attrs.push("SameSite=Strict");
	c.res.setHeader("Set-Cookie", attrs.join("; "));
}

function clientIP(req: IncomingMessage): string {
	return req.socket.remoteAddress ?? "";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(c: Ctx): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), 3000);
	});
	try {
		await Promise.race([c.app.db.query("SELECT 1"), timeout]);
		writeJSON(c.res, 200, { status: "ok", database: "ok" });
	} catch {
		writeJSON(c.res, 503, { status: "degraded", database: "unreachable" });
	} finally {
		clearTimeout(timer);
	}
}

async function handleLogin(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeLoginRequest);
	const user = normalizeUsername(input.username);
	const key = clientIP(c.req) + "|" + user;
	if (!c.app.logins.allowed(key) || !c.app.userLogins.allowed(user)) throw new TooManyLoginsError();
	let result;
	try {
		result = await login(c.app, input.username, input.password);
	} catch (err) {
		if (err instanceof BadCredentialsError) {
			c.app.logins.fail(key);
			c.app.userLogins.fail(user);
		}
		throw err;
	}
	c.app.logins.reset(key);
	c.app.userLogins.reset(user);
	setSessionCookie(c, result.token, SESSION_MAX_AGE_SECONDS);
	writeJSON(c.res, 200, publicUser(result.user));
}

async function handleLogout(c: Ctx): Promise<void> {
	const token = sessionToken(c.req);
	if (token !== "") await logout(c.app, token);
	setSessionCookie(c, "", -1);
	c.res.writeHead(204).end();
}

async function handleMe(c: Ctx): Promise<void> {
	await refreshOrganizations(c.app);
	const u = c.user!;
	writeJSON(c.res, 200, {
		...publicUser(u),
		organization: { id: u.org.id, name: u.org.name, kind: u.org.kind },
		organizations: (await orgsForUser(c.app, u.id)).map(publicAccess),
	});
}

async function handleSwitchOrg(c: Ctx): Promise<void> {
	const b = await decodeBody(c, true, (v) => {
		const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
		if (!o) throw new DecodeError("expected an object");
		for (const k of Object.keys(o)) if (k !== "organization_id") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
		if (!Number.isSafeInteger(o.organization_id) || (o.organization_id as number) < 1) {
			const err = new ValidationError();
			err.add("organization_id", "must be an organization's id");
			err.throwIfAny();
		}
		return o as { organization_id: number };
	});
	await switchOrganization(c.app, c.user!.id, hashToken(c.token), b.organization_id);
	c.user = await sessionUser(c.app, c.token);
	await handleMe(c);
}

function publicAccess(o: { id: number; name: string; kind: OrgKind; status: Organization["status"]; role: Role }) {
	return { id: o.id, name: o.name, kind: o.kind, status: o.status, role: o.role };
}

function publicOrg(o: Organization) {
	return { id: o.id, name: o.name, kind: o.kind, status: o.status, message: o.message, created_at: o.created_at };
}

async function userItems(c: Ctx, users: UserRecord[]) {
	const memberships = await allMemberships(c.app);
	return users.map((u) => ({
		username: u.username,
		role: u.role,
		is_active: u.is_active,
		created_at: u.created_at,
		last_login_at: u.last_login_at,
		server_admin: u.role === "admin",
		organizations: (memberships.get(u.id) ?? []).map(publicAccess),
	}));
}

async function handleListUsers(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, { data: await userItems(c, await listUsers(c.app)) });
}

interface OrgChoice {
	mode: "main" | "existing" | "new";
	organization_id?: number;
	name?: string;
	kind?: OrgKind;
	chart?: string | null;
}

function decodeUserBody(v: unknown, create: boolean): { username?: string; password?: string; role?: MainRole; is_active?: boolean; organization?: OrgChoice } {
	const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
	if (!o) throw new DecodeError("expected an object");
	const allowed = create ? ["username", "password", "role", "organization"] : ["password", "role", "is_active"];
	for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
	const err = new ValidationError();
	for (const k of ["username", "password"]) if (o[k] !== undefined && typeof o[k] !== "string") err.add(k, "must be text");
	if (o.role !== undefined && !(MAIN_ROLES as readonly unknown[]).includes(o.role)) err.add("role", "must be admin, bookkeeper, viewer or none");
	if (o.is_active !== undefined && typeof o.is_active !== "boolean") err.add("is_active", "must be true or false");
	if (create) for (const k of ["username", "password", "role"]) if (o[k] === undefined) err.add(k, "is required");
	if (o.organization !== undefined) {
		const g = (o.organization && typeof o.organization === "object" && !Array.isArray(o.organization) ? o.organization : null) as Record<string, unknown> | null;
		if (!g) err.add("organization", "must be an object");
		else {
			for (const k of Object.keys(g)) if (!["mode", "organization_id", "name", "kind", "chart"].includes(k)) throw new DecodeError(`json: unknown field ${JSON.stringify("organization." + k)}`);
			if (!["main", "existing", "new"].includes(g.mode as string)) err.add("organization.mode", "must be main, existing or new");
			if (g.mode === "existing" && (!Number.isSafeInteger(g.organization_id) || (g.organization_id as number) < 2))
				err.add("organization.organization_id", "must be another organization's id");
			if (g.mode === "new") {
				if (typeof g.name !== "string") err.add("organization.name", "is required");
				if (!(ORG_KINDS as readonly unknown[]).includes(g.kind)) err.add("organization.kind", "must be business or personal");
				if (g.chart !== undefined && g.chart !== null && !(typeof g.chart === "string" && isCurrency(g.chart))) err.add("organization.chart", "must be CAD, USD or null");
			}
			if (g.mode !== "main" && o.role === "none") err.add("role", "must be admin, bookkeeper or viewer in that organization");
		}
	}
	err.throwIfAny();
	return o as { username?: string; password?: string; role?: MainRole; is_active?: boolean; organization?: OrgChoice };
}

/**
 * Creates a user with access to the main books (the default), to an
 * existing organization, or to a new organization of their own (business or
 * personal books, optionally with a starter chart of accounts). Outside the
 * main books, role is their role in that organization and they get no access
 * to the main books.
 */
async function handleCreateUser(c: Ctx): Promise<void> {
	const b = await decodeBody(c, true, (v) => decodeUserBody(v, true));
	const choice = b.organization ?? { mode: "main" };
	if (choice.mode === "new") {
		const v = new ValidationError();
		validateOrgCreate(v, "organization.", { name: choice.name!, kind: choice.kind!, chart: null });
		v.throwIfAny();
	}
	if (choice.mode === "existing") {
		const org = (await listOrganizations(c.app)).find((o) => o.id === choice.organization_id);
		if (!org) {
			const v = new ValidationError();
			v.add("organization.organization_id", "no such organization");
			v.throwIfAny();
		}
	}
	let user: UserRecord;
	try {
		user = await createUser(c.app, b.username!, b.password!, choice.mode === "main" ? b.role! : "none");
	} catch (err) {
		if (isPgError(err) && err.constraint === "users_username_unique") throw new ConflictError("a user with that name already exists");
		throw err;
	}
	if (choice.mode === "existing") await setMembership(c.app, user.id, choice.organization_id!, b.role as Role);
	if (choice.mode === "new") {
		const org = await createOrganization(c.app, { name: choice.name!, kind: choice.kind!, chart: (choice.chart ?? null) as Currency | null });
		await setMembership(c.app, user.id, org.id, b.role as Role);
		await provisionOrganization(c.app, org);
	}
	writeJSON(c.res, 201, (await userItems(c, [user]))[0]);
}

function usernameParam(c: Ctx): string {
	try {
		return decodeURIComponent(c.params.username ?? "");
	} catch {
		throw new NotFoundError();
	}
}

async function handleUpdateUser(c: Ctx): Promise<void> {
	const b = await decodeBody(c, true, (v) => decodeUserBody(v, false));
	const name2 = usernameParam(c);
	if (b.is_active === false && normalizeUsername(name2) === c.user!.username) {
		const v = new ValidationError();
		v.add("is_active", "you can't disable yourself");
		v.throwIfAny();
	}
	if (b.password !== undefined) {
		const v = new ValidationError();
		validatePassword(v, "password", b.password);
		v.throwIfAny();
	}
	const user = await updateUserAccess(c.app, name2, { role: b.role, is_active: b.is_active });
	// A new password ends that user's sessions (the admin resets it for them).
	if (b.password !== undefined) await setPassword(c.app, name2, b.password);
	writeJSON(c.res, 200, (await userItems(c, [user]))[0]);
}

function orgIdParam(c: Ctx): number {
	const id = Number(c.params.orgId);
	if (!/^[1-9][0-9]{0,15}$/.test(c.params.orgId ?? "") || !Number.isSafeInteger(id)) throw new NotFoundError();
	return id;
}

async function handlePutMembership(c: Ctx): Promise<void> {
	const b = await decodeBody(c, true, (v) => {
		const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
		if (!o) throw new DecodeError("expected an object");
		for (const k of Object.keys(o)) if (k !== "role") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
		if (!(ROLES as readonly unknown[]).includes(o.role)) {
			const err = new ValidationError();
			err.add("role", "must be admin, bookkeeper or viewer");
			err.throwIfAny();
		}
		return o as { role: Role };
	});
	const user = await findUser(c.app, usernameParam(c));
	await setMembership(c.app, user.id, orgIdParam(c), b.role);
	writeJSON(c.res, 200, (await userItems(c, [user]))[0]);
}

async function handleDeleteMembership(c: Ctx): Promise<void> {
	const user = await findUser(c.app, usernameParam(c));
	await removeMembership(c.app, user.id, orgIdParam(c));
	writeJSON(c.res, 200, (await userItems(c, [user]))[0]);
}

async function handleListOrgs(c: Ctx): Promise<void> {
	await refreshOrganizations(c.app);
	const mine = new Set((await orgsForUser(c.app, c.user!.id)).map((o) => o.id));
	const all = await listOrganizations(c.app);
	// Server admins see every organization; others the ones they belong to.
	writeJSON(c.res, 200, { data: all.filter((o) => c.user!.server_admin || mine.has(o.id)).map(publicOrg) });
}

function decodeOrgCreate(v: unknown): OrgCreate {
	const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
	if (!o) throw new DecodeError("expected an object");
	for (const k of Object.keys(o)) if (!["name", "kind", "chart"].includes(k)) throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
	const err = new ValidationError();
	if (typeof o.name !== "string") err.add("name", "is required");
	if (!(ORG_KINDS as readonly unknown[]).includes(o.kind)) err.add("kind", "must be business or personal");
	if (o.chart !== undefined && o.chart !== null && !(typeof o.chart === "string" && isCurrency(o.chart))) err.add("chart", "must be CAD, USD or null");
	err.throwIfAny();
	return { name: o.name as string, kind: o.kind as OrgKind, chart: (o.chart ?? null) as Currency | null };
}

/** Creates an organization; the server admin who creates it becomes its admin. */
async function handleCreateOrg(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeOrgCreate);
	const org = await createOrganization(c.app, input);
	await setMembership(c.app, c.user!.id, org.id, "admin");
	writeJSON(c.res, 201, publicOrg(await provisionOrganization(c.app, org)));
}

async function handleUpdateOrg(c: Ctx): Promise<void> {
	const b = await decodeBody(c, true, (v) => {
		const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
		if (!o) throw new DecodeError("expected an object");
		for (const k of Object.keys(o)) if (k !== "name") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
		if (typeof o.name !== "string") {
			const err = new ValidationError();
			err.add("name", "is required");
			err.throwIfAny();
		}
		return o as { name: string };
	});
	writeJSON(c.res, 200, publicOrg(await finishSetup(c.app, await renameOrganization(c.app, orgIdParam(c), b.name))));
}

async function handleGetSidebar(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await getSidebar(c.app, c.user!.id));
}

async function handlePutSidebar(c: Ctx): Promise<void> {
	const items = await decodeBody(c, true, decodeSidebar);
	writeJSON(c.res, 200, await putSidebar(c.app, c.user!.id, items));
}

async function handleChangePassword(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodePasswordChange);
	await changePassword(c.app, c.user!, c.token, input);
	c.res.writeHead(204).end();
}

async function handleListCurrencies(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, { data: await listCurrencies(c.app) });
}

async function handleListAccounts(c: Ctx): Promise<void> {
	const includeInactive = queryBool(c.query, "include_inactive");
	writeJSON(c.res, 200, { data: await listAccounts(c.app, includeInactive) });
}

async function handleCreateAccount(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeAccountCreate);
	writeJSON(c.res, 201, await createAccount(c.app, input));
}

async function handleGetAccount(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await getAccount(c.app, c.params.accountCode!));
}

async function handleUpdateAccount(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeAccountUpdate);
	writeJSON(c.res, 200, await updateAccount(c.app, c.params.accountCode!, input));
}

async function handleAccountLedger(c: Ctx): Promise<void> {
	const [from, to] = queryDateRange(c.query);
	writeJSON(c.res, 200, await getAccountLedger(c.app, c.params.accountCode!, from, to));
}

async function handleListJournalEntries(c: Ctx): Promise<void> {
	const [from, to] = queryDateRange(c.query);
	const f: EntryFilter = { from, to, accountCode: null, hideReversed: queryBool(c.query, "hide_reversed"), limit: 50, offset: 0 };
	const v = new ValidationError();
	const code = c.query.get("account_code") ?? "";
	if (code !== "") {
		if (!ACCOUNT_CODE_RE.test(code)) v.add("account_code", "is not a valid account code");
		else f.accountCode = code;
	}
	const limit = c.query.get("limit") ?? "";
	if (limit !== "") {
		const n = atoi(limit);
		if (n === null || n < 1 || n > 500) v.add("limit", "must be an integer between 1 and 500");
		else f.limit = n;
	}
	const offset = c.query.get("offset") ?? "";
	if (offset !== "") {
		const n = atoi(offset);
		if (n === null || n < 0) v.add("offset", "must be a non-negative integer");
		else f.offset = n;
	}
	v.throwIfAny();
	writeJSON(c.res, 200, { data: await listJournalEntries(c.app, f), limit: f.limit, offset: f.offset });
}

async function handleCreateJournalEntry(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeJournalEntryCreate);
	writeJSON(c.res, 201, await createJournalEntry(c.app, input, c.user!.id));
}

async function handleGetJournalEntry(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await getJournalEntry(c.app, pathId(c, "entryId")));
}

async function handleReverseJournalEntry(c: Ctx): Promise<void> {
	const id = pathId(c, "entryId");
	const input = await decodeBody(c, false, decodeReverseRequest);
	writeJSON(c.res, 201, await reverseJournalEntry(c.app, id, input, c.user!.id));
}

async function handleTrialBalance(c: Ctx): Promise<void> {
	const asOf = queryDate(c.query, "as_of");
	const currency = queryCurrency(c.query);
	writeJSON(c.res, 200, await getTrialBalance(c.app, asOf, currency));
}

async function handleBalanceSheet(c: Ctx): Promise<void> {
	const asOf = queryDate(c.query, "as_of");
	const currency = queryCurrency(c.query);
	writeJSON(c.res, 200, await getBalanceSheet(c.app, asOf, currency));
}

async function handleIncomeStatement(c: Ctx): Promise<void> {
	const [from, to] = queryDateRange(c.query);
	const currency = queryCurrency(c.query);
	writeJSON(c.res, 200, await getIncomeStatement(c.app, from, to, currency));
}

async function handleListReconciliations(c: Ctx): Promise<void> {
	const code = c.query.get("account_code");
	writeJSON(c.res, 200, { data: await listReconciliations(c.app, code || null) });
}

async function handleCreateReconciliation(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeReconciliationCreate);
	writeJSON(c.res, 201, await createReconciliation(c.app, input, c.user!.id));
}

async function handleGetReconciliation(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await getReconciliation(c.app, pathId(c, "reconciliationId")));
}

async function handleUpdateReconciliation(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeReconciliationUpdate);
	writeJSON(c.res, 200, await updateReconciliation(c.app, pathId(c, "reconciliationId"), input));
}

async function handleChangeCleared(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeClearedChange);
	writeJSON(c.res, 200, await changeCleared(c.app, pathId(c, "reconciliationId"), input));
}

async function handleFinishReconciliation(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await finishReconciliation(c.app, pathId(c, "reconciliationId"), c.user!.id));
}

async function handleUndoReconciliation(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await undoReconciliation(c.app, pathId(c, "reconciliationId")));
}

async function handleDeleteReconciliation(c: Ctx): Promise<void> {
	await deleteReconciliation(c.app, pathId(c, "reconciliationId"));
	c.res.writeHead(204).end();
}

async function requireBackups(c: Ctx): Promise<void> {
	if (!(await backupsInstalled(c.app.backup.dir))) {
		throw new ConflictError(`backups are not set up on this server (${c.app.backup.dir} is missing); install from a release with deploy/install.sh`);
	}
}

/**
 * The current organization's backups: each organization has its own settings,
 * status and destinations (orgBackupDir), and backs up only its own books.
 */
async function orgBackups(c: Ctx) {
	const org = currentOrg();
	const db = org.id === MAIN_ORG ? "" : org.db_name;
	const base = c.app.backup.dir;
	const dir = orgBackupDir(base, db);
	return {
		db,
		base,
		dir,
		work: pathMod.join(dir, "tmp"),
		databaseUrl: db && c.app.backup.databaseUrl ? withDatabase(c.app.backup.databaseUrl, db) : c.app.backup.databaseUrl,
		config: () => readOrgConfig(base, db),
	};
}

async function restoreInfo(c: Ctx) {
	const b = await orgBackups(c);
	const status = await readRestoreStatus(b.dir);
	// A restore that never finished (the updater isn't installed, or the server restarted).
	if (status.state === "running" && !c.app.backup.restoring.has(b.db) && Date.now() - Date.parse(status.started_at ?? "") > 3 * 3600_000) {
		Object.assign(status, { state: "error", phase: "", message: "The restore did not finish (see journalctl -u ledger-update on the server)." });
	}
	return status;
}

async function handleRestorable(c: Ctx): Promise<void> {
	await requireBackups(c);
	const b = await orgBackups(c);
	const config = await b.config();
	const backups: { source: "share" | "google"; name: string; size_bytes: number; modified_at: string }[] = [];
	const problems: string[] = [];
	if (config.share.enabled) {
		const list = await listShareDumps(config.share, b.work, 30);
		backups.push(...list.map((x) => ({ source: "share" as const, ...x })));
	}
	if (config.google.enabled) {
		try {
			backups.push(...(await listDriveBackups(config.google, c.app.backup.google, 30)).map((x) => ({ source: "google" as const, ...x })));
		} catch (err) {
			problems.push(`Google Drive: ${(err as Error).message}`);
		}
	}
	// The books' backups and the settings' are separate lists.
	writeJSON(c.res, 200, { backups: backups.filter((x) => isBackupFolder(x.name)), settings: backups.filter((x) => isSettingsFolder(x.name)), problems, confirm: RESTORE_CONFIRM });
}

/** Puts back an organization's settings (its modules' settings and backup schedule) from a settings backup. */
async function handleRestoreSettings(c: Ctx): Promise<void> {
	await requireBackups(c);
	const body = (await readJSON(c, true)) as { source?: unknown; backup?: unknown };
	const err = new ValidationError();
	if (body.source !== "share" && body.source !== "google") err.add("source", "must be share or google");
	if (typeof body.backup !== "string" || !isSettingsFolder(body.backup)) err.add("backup", "choose a settings backup");
	err.throwIfAny();
	const b = await orgBackups(c);
	const config = await b.config();
	const dest = pathMod.join(b.dir, "restore-settings");
	let file;
	try {
		if (body.source === "google") await fetchDriveBackup(config.google, c.app.backup.google, body.backup as string, dest);
		else await fetchShareBackup(config.share, b.work, body.backup as string, dest);
		file = await readSettingsFile(pathMod.join(dest, SETTINGS_FILE));
	} catch (e) {
		throw new ConflictError(`the settings were not restored: ${(e as Error).message}`);
	} finally {
		await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
	}
	// Modules' settings: exactly what the file holds.
	await withTx(c.app.db, {}, async (tx) => {
		await tx.query(`DELETE FROM module_settings WHERE NOT (module_id = ANY($1::text[]))`, [Object.keys(file.modules)]);
		for (const [id, values] of Object.entries(file.modules)) {
			await tx.query(
				`INSERT INTO module_settings (module_id, "values", updated_by) VALUES ($1, $2::jsonb, $3)
				 ON CONFLICT (module_id) DO UPDATE SET "values" = EXCLUDED."values", updated_at = now(), updated_by = EXCLUDED.updated_by`,
				[id, JSON.stringify(values), c.user!.id],
			);
		}
	});
	for (const m of c.app.modules.modules.values()) if (!m.error) await notifySettings(c.app, m).catch((e: Error) => log.warn("module settings change", { module: m.manifest.id, err: e.message }));
	// The backup schedule and what is kept; destinations and their passwords are not in the file.
	const bk = file.backup;
	if (bk && typeof bk === "object") {
		try {
			const next = applyConfigChange(config, {
				schedule: bk.schedule,
				include_csv: bk.include_csv,
				share: { ...config.share, password: null, keep_days: bk.share_keep_days },
				google: { enabled: config.google.enabled, client_id: config.google.client_id, keep_count: bk.google_keep_count },
			});
			await writeConfig(b.dir, next);
		} catch (e) {
			log.warn("restore settings: the backup schedule in the file was not applied", { err: (e as Error).message });
		}
	}
	writeJSON(c.res, 200, { ...(await backupsInfo(c)), settings_restored: { backup: body.backup, made_at: file.made_at, modules: Object.keys(file.modules) } });
}

async function handleRestore(c: Ctx): Promise<void> {
	await requireBackups(c);
	const body = (await readJSON(c, true)) as { source?: unknown; backup?: unknown; confirm?: unknown };
	const err = new ValidationError();
	if (body.source !== "share" && body.source !== "google") err.add("source", "must be share or google");
	if (typeof body.backup !== "string" || !isBackupFolder(body.backup)) err.add("backup", "choose a backup");
	if (body.confirm !== RESTORE_CONFIRM) err.add("confirm", `type ${RESTORE_CONFIRM} to confirm`);
	err.throwIfAny();
	const b = await orgBackups(c);
	if (!b.databaseUrl) throw new ConflictError("DATABASE_URL is not known to the app");
	if (c.app.backup.running.has(b.db)) throw new ConflictError("a backup is running; try again when it has finished");
	if (c.app.backup.restoring.size > 0 || (await restoreInfo(c)).state === "running") throw new ConflictError("a restore is already running");
	const job = prepareRestore({
		baseDir: b.base,
		db: b.db,
		configDir: c.app.update.config,
		databaseUrl: b.databaseUrl,
		csvDir: await filesDir(c.app),
		google: c.app.backup.google,
		source: body.source as "share" | "google",
		backup: body.backup as string,
		requestedBy: c.user!.username,
	}).finally(() => {
		c.app.backup.restoring.delete(b.db);
	});
	c.app.backup.restoring.set(b.db, job);
	await new Promise((r) => setTimeout(r, 150));
	writeJSON(c.res, 202, await backupsInfo(c));
}

async function backupsInfo(c: Ctx) {
	const b = await orgBackups(c);
	const available = await backupsInstalled(b.base);
	const config = await b.config();
	const status = await readBackupStatus(b.dir);
	// A run that died without finishing (container restarted) is not running any more.
	if (status.state === "running" && !c.app.backup.running.has(b.db) && Date.now() - Date.parse(status.started_at ?? "") > 3 * 3600_000) {
		Object.assign(status, { state: "error", message: "The last backup did not finish (the server may have restarted)." });
	}
	return {
		available,
		config: publicConfig(config),
		status,
		next_run: nextBackupTime(config),
		share_files: available && config.share.enabled ? (await listShareDumps(config.share, b.work, 20)).filter((f) => !isSettingsFolder(f.name)).slice(0, 10) : [],
		restore: await restoreInfo(c),
		/** Whether this user may point the backups at another mounted folder (server admins only). */
		can_change_folder: c.user!.server_admin === true,
	};
}

async function handleGetBackups(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await backupsInfo(c));
}

async function handlePutBackupConfig(c: Ctx): Promise<void> {
	await requireBackups(c);
	const body = await decodeBody(c, true, (v) => plainJson(v));
	const b = await orgBackups(c);
	const cur = await b.config();
	const next = applyConfigChange(cur, body);
	// A mounted folder is a place on the server: only the server's admins choose it, so one
	// organization's admin can't aim its backups (or restores) at another organization's folder.
	if (next.share.mode === "folder" && next.share.path !== cur.share.path && !c.user!.server_admin) {
		throw new HttpError(403, "only an admin of the main books can change the folder on the server; use an SMB share or Google Drive, or ask them", "forbidden");
	}
	await writeConfig(b.dir, next);
	writeJSON(c.res, 200, await backupsInfo(c));
}

async function handleRunBackup(c: Ctx): Promise<void> {
	await requireBackups(c);
	const b = await orgBackups(c);
	if (!b.databaseUrl) throw new ConflictError("DATABASE_URL is not known to the app");
	if (c.app.backup.running.has(b.db)) throw new ConflictError("a backup is already running");
	if (c.app.backup.restoring.has(b.db)) throw new ConflictError("a restore is running");
	const job = runBackup({ dir: b.dir, config: await b.config(), databaseUrl: b.databaseUrl, trigger: "manual", google: c.app.backup.google, csvDir: await filesDir(c.app) })
		.catch((err: Error) => log.error("backup failed", { err: err.message }))
		.finally(() => {
			c.app.backup.running.delete(b.db);
		});
	c.app.backup.running.set(b.db, job);
	// Give it a moment to record that it started, so the page shows "running".
	await Promise.race([job, new Promise((r) => setTimeout(r, 300))]);
	writeJSON(c.res, 202, await backupsInfo(c));
}

async function handleTestShare(c: Ctx): Promise<void> {
	await requireBackups(c);
	// The settings as they are on the page (not saved yet); a missing password means the saved one.
	const body = await decodeBody(c, true, (v) => (v && typeof v === "object" && !Array.isArray(v) ? (plainJson(v) as Record<string, unknown>) : null));
	if (!body) throw new DecodeError("expected the share settings");
	const b = await orgBackups(c);
	const cur = (await b.config()).share;
	const err = new ValidationError();
	const t = checkShare({ keep_days: 30, ...body, enabled: true }, cur, err);
	err.throwIfAny();
	if (t.mode === "folder" && t.path !== cur.path && !c.user!.server_admin) throw new HttpError(403, "only an admin of the main books can change the folder on the server", "forbidden");
	writeJSON(c.res, 200, await testShare(t, b.work));
}

async function handleGoogleConnect(c: Ctx): Promise<void> {
	await requireBackups(c);
	const b = await orgBackups(c);
	const code = await startDeviceFlow((await b.config()).google, c.app.backup.google);
	c.app.backup.device.set(b.db, code);
	writeJSON(c.res, 200, { user_code: code.user_code, verification_url: code.verification_url, expires_at: new Date(code.expires_at).toISOString(), interval: code.interval });
}

async function handleGooglePoll(c: Ctx): Promise<void> {
	await requireBackups(c);
	const b = await orgBackups(c);
	const code = c.app.backup.device.get(b.db);
	if (!code) throw new ConflictError("start connecting first");
	const config = await b.config();
	// Each organization's backups go in a Drive folder of their own.
	const org = b.db ? await getOrganization(c.app, currentOrg().id) : null;
	const r = await pollDeviceFlow(config.google, code, c.app.backup.google, org ? `Ledger backups – ${org.name}` : undefined);
	if (r.state === "connected") {
		await writeConfig(b.dir, { ...config, google: { ...r.google, enabled: true } });
		c.app.backup.device.delete(b.db);
		writeJSON(c.res, 200, { state: "connected", account: r.google.account });
		return;
	}
	if (r.state !== "pending") c.app.backup.device.delete(b.db);
	writeJSON(c.res, 200, { state: r.state, account: "" });
}

async function handleGoogleDisconnect(c: Ctx): Promise<void> {
	await requireBackups(c);
	const b = await orgBackups(c);
	const config = await b.config();
	await revokeGoogle(config.google, c.app.backup.google);
	await writeConfig(b.dir, { ...config, google: { ...config.google, enabled: false, refresh_token: "", folder_id: "", account: "" } });
	writeJSON(c.res, 200, await backupsInfo(c));
}

async function handleSearch(c: Ctx): Promise<void> {
	const limit = atoi(c.query.get("limit") ?? "") ?? 8;
	writeJSON(c.res, 200, await search(c.app, c.query.get("q") ?? "", c.user!, Math.min(Math.max(limit, 1), 25)));
}

// ---------------------------------------------------------------------------
// Integrations: the AI provider and Gmail, shared with modules
// ---------------------------------------------------------------------------

/** Running modules, for the "which modules may use it" lists. */
function moduleChoices(c: Ctx) {
	return [...c.app.modules.modules.values()].filter((m) => !m.error).map((m) => ({ id: m.manifest.id, name: m.manifest.name }));
}

async function llmInfo(c: Ctx) {
	const dir = c.app.integrations.dir;
	return {
		available: await integrationsAvailable(dir),
		config: publicLlmConfig(await readLlmConfig(dir)),
		modules: moduleChoices(c),
		usage: await llmUsage(c.app),
	};
}

async function handleGetLlm(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await llmInfo(c));
}

async function handlePutLlm(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const body = await decodeBody(c, true, (v) => plainJson(v));
	await writeIntegration(c.app.integrations.dir, "llm", applyLlmChange(await readLlmConfig(c.app.integrations.dir), body));
	writeJSON(c.res, 200, await llmInfo(c));
}

async function handleTestLlm(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const started = Date.now();
	const body = await decodeBody(c, false, (v) => {
		const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
		if (v !== null && v !== undefined && (!o || Object.keys(o).some((k) => k !== "connection") || (o.connection !== undefined && typeof o.connection !== "string"))) {
			throw new DecodeError('expected {"connection": "<id>"}');
		}
		return (o ?? {}) as { connection?: string };
	});
	const r = await llmComplete(c.app, "ledger", { prompt: "Reply with the single word OK.", maxTokens: 50, connection: body?.connection });
	writeJSON(c.res, 200, { text: r.text.trim().slice(0, 200), model: r.model, duration_ms: Date.now() - started });
}

async function gmailInfo(c: Ctx) {
	const dir = c.app.integrations.dir;
	return { available: await integrationsAvailable(dir), config: publicGmailConfig(await readGmailConfig(dir)), modules: moduleChoices(c) };
}

async function handleGetGmail(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await gmailInfo(c));
}

async function handlePutGmail(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const body = await decodeBody(c, true, (v) => plainJson(v));
	await writeIntegration(c.app.integrations.dir, "gmail", applyGmailChange(await readGmailConfig(c.app.integrations.dir), body));
	writeJSON(c.res, 200, await gmailInfo(c));
}

async function handleGmailStart(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const body = (await decodeBody(c, false, (v) => plainJson(v))) as { send?: unknown } | null;
	const { url, pending } = startAuth(await readGmailConfig(c.app.integrations.dir), c.app.integrations.gmail, body?.send === true);
	c.app.integrations.pendingGmail = pending;
	writeJSON(c.res, 200, { auth_url: url, redirect_uri: REDIRECT_URI });
}

async function handleGmailFinish(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const body = (await decodeBody(c, true, (v) => plainJson(v))) as { url?: unknown } | null;
	const pending = c.app.integrations.pendingGmail;
	if (!pending) throw new ConflictError("press Connect first");
	if (typeof body?.url !== "string") throw new HttpError(422, "paste the address your browser showed after approving", "validation_failed");
	const code = codeFromPaste(body.url, pending.state);
	const dir = c.app.integrations.dir;
	await writeIntegration(dir, "gmail", await finishAuth(await readGmailConfig(dir), pending, code, c.app.integrations.gmail));
	c.app.integrations.pendingGmail = null;
	writeJSON(c.res, 200, await gmailInfo(c));
}

async function handleGmailDisconnect(c: Ctx): Promise<void> {
	await requireIntegrations(c.app.integrations.dir);
	const dir = c.app.integrations.dir;
	const cur = await readGmailConfig(dir);
	await revokeGmail(cur, c.app.integrations.gmail);
	await writeIntegration(dir, "gmail", { ...cur, refresh_token: "", account: "", scopes: [] });
	writeJSON(c.res, 200, await gmailInfo(c));
}

async function handleGetDashboard(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await getDashboard(c.app));
}

async function handleCloseDashboardItem(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await setItemClosed(c.app, pathId(c, "itemId"), true, c.user!.id));
}

async function handleReopenDashboardItem(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await setItemClosed(c.app, pathId(c, "itemId"), false, null));
}

async function handleExportGeneralLedger(c: Ctx): Promise<void> {
	const input = await decodeBody(c, false, decodeExportRequest);
	writeJSON(c.res, 201, await exportGeneralLedger(c.app, input.from, input.to, input.currency));
}

async function handleListFiles(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, { data: await listCsvFiles(c.app) });
}

async function handleDownloadFile(c: Ctx): Promise<void> {
	const name = c.params.filename!;
	const { fh, info } = await openCsvFile(c.app, name);
	try {
		const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
		const since = Date.parse(c.req.headers["if-modified-since"] ?? "");
		if (!Number.isNaN(since) && modified.getTime() <= since) {
			c.res.writeHead(304, { "Last-Modified": modified.toUTCString() }).end();
			return;
		}
		c.res.writeHead(200, {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${name}"`,
			"Content-Length": info.size,
			"Last-Modified": modified.toUTCString(),
		});
		await new Promise<void>((resolve, reject) => {
			const stream = fh.createReadStream({ autoClose: false, start: 0, end: Math.max(info.size - 1, 0) });
			if (info.size === 0) {
				stream.destroy();
				c.res.end();
				resolve();
				return;
			}
			stream.on("error", reject);
			c.res.on("close", resolve);
			stream.pipe(c.res);
		});
	} finally {
		await fh.close();
	}
}

async function handleUploadFile(c: Ctx): Promise<void> {
	const boundary = formDataBoundary(c.req.headers["content-type"]);
	if (!boundary) throw new HttpError(400, 'expected a multipart/form-data body with a "file" field', "bad_request");
	let body: Buffer;
	try {
		body = await readBody(c.req, MAX_FILE_BYTES + MULTIPART_OVERHEAD);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			c.res.setHeader("Connection", "close");
			throw new TooLargeError();
		}
		throw err;
	}
	let parts;
	try {
		parts = parseMultipart(body, boundary);
	} catch (err) {
		if (err instanceof MultipartError) throw new HttpError(400, "invalid multipart body: " + err.message, "bad_request");
		throw err;
	}
	const part = parts.find((p) => p.name === "file");
	if (!part) throw new HttpError(400, 'missing "file" field', "bad_request");
	writeJSON(c.res, 201, await saveUploadedCsv(c.app, part.filename, part.data));
}

// A module's "Import from CSV" (ctx.imports): upload, preview (the module's dry run), import.

function moduleImporter(c: Ctx) {
	const m = c.app.modules.modules.get(c.params.id ?? "");
	if (!m || m.error || !m.importer) throw new NotFoundError();
	return { m, spec: m.importer };
}

async function handleModuleImportInfo(c: Ctx): Promise<void> {
	const m = c.app.modules.modules.get(c.params.id ?? "");
	if (!m) throw new NotFoundError();
	const spec = m.error ? null : m.importer;
	writeJSON(c.res, 200, {
		available: spec !== null,
		label: spec?.label ?? "",
		description: spec?.description ?? "",
		fields: spec?.fields ?? [],
		ai_available: pickConnection(await readLlmConfig(c.app.integrations.dir), "text") !== null,
	});
}

async function handleModuleImportUpload(c: Ctx): Promise<void> {
	const { m, spec } = moduleImporter(c);
	const boundary = formDataBoundary(c.req.headers["content-type"]);
	if (!boundary) throw new HttpError(400, 'expected a multipart/form-data body with a "file" field', "bad_request");
	let body: Buffer;
	try {
		body = await readBody(c.req, MAX_FILE_BYTES + MULTIPART_OVERHEAD);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			c.res.setHeader("Connection", "close");
			throw new TooLargeError();
		}
		throw err;
	}
	let parts;
	try {
		parts = parseMultipart(body, boundary);
	} catch (err) {
		if (err instanceof MultipartError) throw new HttpError(400, "invalid multipart body: " + err.message, "bad_request");
		throw err;
	}
	const part = parts.find((p) => p.name === "file");
	if (!part) throw new HttpError(400, 'missing "file" field', "bad_request");
	const useAi = parts.find((p) => p.name === "use_ai")?.data.toString() !== "false";
	const u = await analyzeImport(c.app, m.manifest.id, m.manifest.name, spec, c.user!.id, part.filename || "import.csv", part.data, useAi);
	const { rows: _rows, ...plan } = publicPlan(u, spec, u.mapping);
	writeJSON(c.res, 201, { ...plan, check: null });
}

async function handleModuleImportPreview(c: Ctx): Promise<void> {
	const { m, spec } = moduleImporter(c);
	const u = getImportUpload(m.manifest.id, c.params.uploadId ?? "", c.user!.id);
	const body = (await decodeBody(c, false, (v) => (v && typeof v === "object" ? plainJson(v) : {}))) as Record<string, unknown> | null;
	const mapping = cleanImportMapping(u, spec, body?.mapping ?? {});
	const { rows, ...plan } = publicPlan(u, spec, mapping);
	// The module checks the rows without changing anything.
	const check = plan.missing.length === 0 && rows.length > 0 ? await c.app.modules.runImport(m.manifest.id, rows, true, c.user!) : null;
	writeJSON(c.res, 200, { ...plan, check });
}

async function handleModuleImportRun(c: Ctx): Promise<void> {
	const { m, spec } = moduleImporter(c);
	const u = getImportUpload(m.manifest.id, c.params.uploadId ?? "", c.user!.id);
	const body = (await decodeBody(c, true, (v) => plainJson(v))) as Record<string, unknown>;
	const mapping = cleanImportMapping(u, spec, body.mapping ?? {});
	const { rows, missing, problems } = publicPlan(u, spec, mapping);
	if (missing.length) throw new HttpError(422, `choose a column for ${missing.join(", ")}`, "validation_failed");
	if (rows.length === 0) throw new HttpError(422, "no rows can be imported", "validation_failed");
	const check = await c.app.modules.runImport(m.manifest.id, rows, true, c.user!);
	if (check.errors.length) throw new HttpError(422, `the module found problems: ${check.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join("; ")}`, "validation_failed");
	const result = await c.app.modules.runImport(m.manifest.id, rows, false, c.user!);
	writeJSON(c.res, 200, { imported: rows.length, skipped: new Set(problems.map((p) => p.row)).size, summary: result.summary, errors: result.errors });
}

// Migrating from other bookkeeping software: upload, preview, import.

async function handleMigrationInfo(c: Ctx): Promise<void> {
	const cfg = await readLlmConfig(c.app.integrations.dir);
	writeJSON(c.res, 200, { ai_available: pickConnection(cfg, "text") !== null, kinds: MIGRATION_KINDS, max_bytes: MAX_FILE_BYTES });
}

async function handleMigrationUpload(c: Ctx): Promise<void> {
	const boundary = formDataBoundary(c.req.headers["content-type"]);
	if (!boundary) throw new HttpError(400, 'expected a multipart/form-data body with a "file" field', "bad_request");
	let body: Buffer;
	try {
		body = await readBody(c.req, MAX_FILE_BYTES + MULTIPART_OVERHEAD);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			c.res.setHeader("Connection", "close");
			throw new TooLargeError();
		}
		throw err;
	}
	let parts;
	try {
		parts = parseMultipart(body, boundary);
	} catch (err) {
		if (err instanceof MultipartError) throw new HttpError(400, "invalid multipart body: " + err.message, "bad_request");
		throw err;
	}
	const part = parts.find((p) => p.name === "file");
	if (!part) throw new HttpError(400, 'missing "file" field', "bad_request");
	const useAi = parts.find((p) => p.name === "use_ai")?.data.toString() !== "false";
	const u = await analyzeUpload(c.app, c.user!.id, part.filename || "import.csv", part.data, useAi);
	writeJSON(c.res, 201, await planFor(c.app, u, u.mapping));
}

async function handleMigrationPreview(c: Ctx): Promise<void> {
	const u = getUpload(c.params.uploadId ?? "", c.user!.id);
	const body = await decodeBody(c, false, (v) => (v === null || v === undefined ? {} : (plainJson(v) as Record<string, unknown>)));
	writeJSON(c.res, 200, await planFor(c.app, u, cleanMapping(u, (body as Record<string, unknown>).mapping ?? {})));
}

async function handleMigrationImport(c: Ctx): Promise<void> {
	const u = getUpload(c.params.uploadId ?? "", c.user!.id);
	const body = (await decodeBody(c, true, (v) => plainJson(v))) as Record<string, unknown>;
	const recipient = typeof body.recipient === "string" ? body.recipient : null;
	writeJSON(c.res, 200, await runMigration(c.app, u, cleanMapping(u, body.mapping ?? {}), c.user!.id, recipient));
}

async function handleImportJournalEntries(c: Ctx): Promise<void> {
	const input = await decodeBody(c, true, decodeImportRequest);
	if (!CSV_FILENAME_RE.test(input.filename)) {
		const v = new ValidationError();
		v.add("filename", "must be a .csv file name in the CSV directory");
		throw v;
	}
	writeJSON(c.res, 201, await importJournalEntries(c.app, input.filename, c.user!.id));
}

async function updateInfo(c: Ctx) {
	const schedule = await readSchedule(c.app.update);
	const next = nextScheduledTime(schedule, Date.now());
	const saved = await readUpdateRepo(c.app.update);
	return {
		current_version: c.app.version,
		updater_installed: await updaterInstalled(c.app.update),
		repo: { current: saved ?? baseUpdateRepo(), installed: baseUpdateRepo() },
		schedule,
		next_run_at: next === null ? null : new Date(next).toISOString(),
		status: await readStatus(c.app.update),
	};
}

async function handleGetUpdate(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await updateInfo(c));
}

async function requireUpdater(c: Ctx): Promise<void> {
	if (!(await updaterInstalled(c.app.update))) {
		throw new ConflictError("automatic updates are not set up on this server; install from a release with deploy/install.sh");
	}
}

async function handlePutUpdateSchedule(c: Ctx): Promise<void> {
	const schedule = validateSchedule(plainJson(await decodeBody(c, true, (v) => v)));
	await requireUpdater(c);
	await writeSchedule(c.app.update, schedule);
	writeJSON(c.res, 200, await updateInfo(c));
}

/**
 * Ledger's own repository after a rename on GitHub. Only the same repository
 * (same GitHub id) is accepted: the root updater installs from it.
 */
async function handlePutUpdateRepo(c: Ctx): Promise<void> {
	const { repo: input } = await decodeBody(c, true, decodeRepoBody);
	await requireUpdater(c);
	const repo = normalizeRepo(input);
	const err = new ValidationError();
	if (!repo) {
		err.add("repo", "must be a GitHub repository, e.g. owner/name or its github.com URL");
		err.throwIfAny();
	}
	const base = baseUpdateRepo();
	let current: { id: number; full_name: string };
	let next: { id: number; full_name: string };
	try {
		[current, next] = await Promise.all([repoIdentity(githubApi(), base), repoIdentity(githubApi(), repo!)]);
	} catch (e) {
		throw new HttpError(422, `couldn't check ${repo} on GitHub: ${(e as Error).message}`, "validation_failed");
	}
	if (current.id !== next.id) {
		err.add("repo", `${repo} is a different repository from ${base}; Ledger only follows its own repository when it is renamed or moved`);
		err.throwIfAny();
	}
	// Store GitHub's current spelling; the installed name needs no file.
	await writeUpdateRepo(c.app.update, next.full_name === base ? null : next.full_name);
	writeJSON(c.res, 200, await updateInfo(c));
}

async function handleCheckUpdate(c: Ctx): Promise<void> {
	await requireUpdater(c);
	const status = await readStatus(c.app.update);
	// A run that never finished (power loss, say) stops blocking after an hour.
	const started = Date.parse(status?.started_at ?? "");
	if (status?.state === "running" && Date.now() - started < 3600_000) throw new ConflictError("an update is already running");
	await requestRunNow(c.app.update);
	writeJSON(c.res, 202, await updateInfo(c));
}

// ---------------------------------------------------------------------------
// Modules: management (the root installer does the installing) and dispatch
// ---------------------------------------------------------------------------

async function modulesInfo(c: Ctx) {
	const desired = await readDesired(c.app.update);
	const results = await readModuleResults(c.app.update);
	const loaded = [...c.app.modules.modules.values()];
	const list: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	const resultFor = (repo: string | null, id: string | null) => results.find((r) => (repo && r.repo === repo) || (id && r.id === id)) ?? null;
	for (const d of desired) {
		const m = loaded.find((x) => (d.id && x.manifest.id === d.id) || (x.repo && x.repo === d.repo));
		const last = resultFor(d.repo, d.id);
		if (m) seen.add(m.manifest.id);
		list.push({
			repo: d.repo,
			id: m?.manifest.id ?? d.id,
			name: m?.manifest.name ?? d.id ?? d.repo,
			version: m?.manifest.version ?? null,
			description: m?.manifest.description ?? "",
			nav_label: m && !m.error ? (m.manifest.nav?.label ?? null) : null,
			has_settings: !!m && !m.error && !!m.manifest.settings,
			accepts: m?.manifest.files?.accepts ?? [],
			state: m ? (m.error ? "failed" : "running") : last?.state === "error" ? "error" : "pending",
			message: m?.error ?? (last?.state === "error" ? last.message : m ? "" : "Waiting for the installer…"),
		});
	}
	for (const m of loaded) {
		if (seen.has(m.manifest.id)) continue;
		list.push({
			repo: m.repo,
			id: m.manifest.id,
			name: m.manifest.name,
			version: m.manifest.version,
			description: m.manifest.description,
			nav_label: null,
			// Still running until the next sync (or, in development, loaded from MODULES_DIR).
			has_settings: !m.error && !!m.manifest.settings,
			accepts: m.manifest.files?.accepts ?? [],
			state: "removing",
			message: "Removed from the list; uninstalls at the next sync.",
		});
	}
	return { installer_available: await updaterInstalled(c.app.update), modules: list, nav: c.app.modules.nav() };
}

/** A running module that declares settings, or 404. */
function settingsModule(c: Ctx) {
	const m = c.app.modules.modules.get(c.params.id ?? "");
	if (!m || m.error || !m.manifest.settings) throw new NotFoundError();
	return { m, spec: m.manifest.settings };
}

async function handleGetModuleSettings(c: Ctx): Promise<void> {
	const { m, spec } = settingsModule(c);
	writeJSON(c.res, 200, await publicSettings(c.app.db, m.manifest.id, spec));
}

async function handlePutModuleSettings(c: Ctx): Promise<void> {
	const { m, spec } = settingsModule(c);
	const body = await decodeBody(c, true, (v) => {
		const o = (v && typeof v === "object" && !Array.isArray(v) ? plainJson(v) : null) as Record<string, unknown> | null;
		if (!o || Object.keys(o).some((k) => k !== "values")) throw new DecodeError('expected {"values": {...}}');
		return o.values;
	});
	await saveSettings(c.app.db, m.manifest.id, spec, body, c.user!.id);
	await notifySettings(c.app, m);
	writeJSON(c.res, 200, await publicSettings(c.app.db, m.manifest.id, spec));
}

async function handleListModules(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await modulesInfo(c));
}

async function previewModule(input: string) {
	const repo = normalizeRepo(input);
	if (!repo) {
		const v = new ValidationError();
		v.add("repo", "must be a GitHub repository, e.g. someone/ledger-invoicing or its github.com URL");
		throw v;
	}
	try {
		const rel = await latestModuleRelease(githubApi(), repo);
		const manifest = await fetchManifest(githubApi(), repo, rel.tag);
		return { repo, tag: rel.tag, manifest };
	} catch (err) {
		if (err instanceof ValidationError) throw new HttpError(422, `${repo}: ledger-module.json is invalid: ${err.message.replace(/^validation failed: /, "")}`, "validation_failed");
		throw new HttpError(422, `${repo}: ${(err as Error).message}`, "validation_failed");
	}
}

function decodeRepoBody(v: unknown): { repo: string } {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (k !== "repo") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
	return { repo: typeof o.repo === "string" ? o.repo : "" };
}

async function handlePreviewModule(c: Ctx): Promise<void> {
	const { repo } = await decodeBody(c, true, decodeRepoBody);
	const p = await previewModule(repo);
	writeJSON(c.res, 200, { ...p, compatible: compatible(p.manifest, c.app.version), ledger_version: c.app.version });
}

async function handleAddModule(c: Ctx): Promise<void> {
	const { repo } = await decodeBody(c, true, decodeRepoBody);
	await requireUpdater(c);
	const p = await previewModule(repo);
	if (!compatible(p.manifest, c.app.version)) throw new ConflictError(`${p.repo} needs Ledger ${p.manifest.ledger} (this is ${c.app.version})`);
	const desired = await readDesired(c.app.update);
	const clash = desired.find((d) => d.id === p.manifest.id && d.repo !== p.repo) ?? (c.app.modules.modules.get(p.manifest.id)?.repo ?? p.repo) !== p.repo;
	if (clash) throw new ConflictError(`another module already uses the id "${p.manifest.id}"`);
	if (!desired.some((d) => d.repo === p.repo)) {
		if (desired.length >= MAX_MODULES) throw new ConflictError(`at most ${MAX_MODULES} modules`);
		desired.push({ repo: p.repo, id: p.manifest.id });
		await writeDesired(c.app.update, desired);
	}
	await requestModuleSync(c.app.update);
	writeJSON(c.res, 202, await modulesInfo(c));
}

/**
 * Points an installed module at its repository's new name (after a rename on
 * GitHub). The repository must hold the same module: its manifest id must match.
 */
async function handleRenameModuleRepo(c: Ctx): Promise<void> {
	const { repo } = await decodeBody(c, true, decodeRepoBody);
	await requireUpdater(c);
	const id = c.params.id ?? "";
	const loaded = c.app.modules.modules.get(id);
	const desired = await readDesired(c.app.update);
	const entry = desired.find((d) => d.id === id) ?? desired.find((d) => !!loaded?.repo && d.repo === loaded.repo);
	if (!entry) throw new NotFoundError();
	const p = await previewModule(repo);
	if (p.manifest.id !== id) {
		const v = new ValidationError();
		v.add("repo", `${p.repo} holds the module "${p.manifest.id}", not "${id}"`);
		v.throwIfAny();
	}
	if (desired.some((d) => d !== entry && d.repo === p.repo)) throw new ConflictError(`${p.repo} is already on the list`);
	entry.repo = p.repo;
	entry.id = id;
	await writeDesired(c.app.update, desired);
	await requestModuleSync(c.app.update);
	writeJSON(c.res, 202, await modulesInfo(c));
}

async function handleRemoveModule(c: Ctx): Promise<void> {
	await requireUpdater(c);
	const id = c.params.id ?? "";
	const loaded = c.app.modules.modules.get(id);
	const desired = await readDesired(c.app.update);
	const keep = desired.filter((d: DesiredModule) => d.id !== id && !(loaded?.repo && d.repo === loaded.repo));
	if (keep.length === desired.length && !loaded) throw new NotFoundError();
	await writeDesired(c.app.update, keep);
	await requestModuleSync(c.app.update);
	writeJSON(c.res, 202, await modulesInfo(c));
}

async function handleSyncModules(c: Ctx): Promise<void> {
	await requireUpdater(c);
	await requestModuleSync(c.app.update);
	writeJSON(c.res, 202, await modulesInfo(c));
}

/** Runs a request's work in the database of the session's organization. */
async function inUserOrg<T>(c: Ctx, fn: () => Promise<T>): Promise<T> {
	const org = c.user!.org;
	await mirrorUser(c.app, org, c.user!);
	return inOrg(org, fn);
}

/**
 * /api/v1/modules/<id>/storage/<path>: a file the module stored (ctx.storage),
 * for any logged-in user of the organization. PDFs, pictures and plain text
 * open in the browser; anything else downloads. Never runs as a page.
 */
async function serveModuleStorage(c: Ctx, id: string, parts: string[]): Promise<void> {
	if (c.req.method !== "GET" && c.req.method !== "HEAD") return writeError(c.res, 405, "bad_request", "method not allowed");
	c.token = sessionToken(c.req);
	c.user = await sessionUser(c.app, c.token);
	if (!/^[a-z][a-z0-9-]{1,31}$/.test(id) || !c.app.modules.modules.has(id)) return writeError(c.res, 404, "not_found", "not found");
	const file = await inUserOrg(c, () => openStored(c.app, id, parts));
	if (!file) return writeError(c.res, 404, "not_found", "not found");
	const inline = INLINE_TYPES.has(file.type);
	c.res.writeHead(200, {
		"Content-Type": file.type + (file.type.startsWith("text/") ? "; charset=utf-8" : ""),
		"Content-Length": file.size,
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		"Content-Security-Policy": "sandbox; frame-ancestors 'self'",
		"Cache-Control": "private, no-cache",
	});
	if (c.req.method === "HEAD") return void c.res.end();
	createReadStream(file.full).pipe(c.res);
}

/** /api/v1/m/<id>/...: a module's own API. Always requires a session. */
async function serveModuleAPI(c: Ctx, segments: string[]): Promise<void> {
	c.token = sessionToken(c.req);
	c.user = await sessionUser(c.app, c.token);
	return inUserOrg(c, () => serveModuleRoute(c, segments));
}

async function serveModuleRoute(c: Ctx, segments: string[]): Promise<void> {
	if (!c.user) throw new UnauthorizedError();
	const id = segments[1]!;
	const rest = segments.length > 2 ? segments.slice(2) : [""];
	const found = c.app.modules.match(id, c.req.method ?? "", rest);
	if (found === null) return writeError(c.res, 404, "not_found", "no such endpoint");
	if (found === "method") return writeError(c.res, 405, "bad_request", "method not allowed");
	// Modules follow the same rule as Ledger: viewers read, bookkeepers change.
	if (c.req.method !== "GET" && !roleAtLeast(c.user.role, "bookkeeper")) {
		return writeError(c.res, 403, "forbidden", `this needs the bookkeeper role (you are ${c.user.role})`);
	}
	let body: unknown = undefined;
	if (c.req.method !== "GET" && c.req.method !== "DELETE") {
		const v = await decodeBody(c, false, (x) => x);
		body = v === null ? undefined : plainJson(v);
	}
	const out = await c.app.modules.run(
		found.route,
		{ method: found.route.method, path: "/" + rest.join("/"), params: found.params, query: c.query, body },
		c.user,
	);
	if (out.status === 204 || out.body === undefined) {
		c.res.writeHead(out.status).end();
		return;
	}
	writeJSON(c.res, out.status, out.body);
}

/** /m/<id>/...: a module's UI, shown in an iframe inside Ledger. */
async function serveModuleUI(c: Ctx, pathname: string): Promise<void> {
	c.res.setHeader("X-Frame-Options", "SAMEORIGIN");
	c.res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		c.res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }).end("method not allowed\n");
		return;
	}
	try {
		c.user = await sessionUser(c.app, sessionToken(c.req));
	} catch {
		c.res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("log in to Ledger first\n");
		return;
	}
	const m = /^\/m\/([a-z][a-z0-9-]{1,31})(\/.*)?$/.exec(pathname);
	if (!m) {
		c.res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
		return;
	}
	if (m[2] === undefined) {
		c.res.writeHead(301, { Location: `/m/${m[1]}/` }).end();
		return;
	}
	const file = await c.app.modules.uiFile(m[1]!, m[2].slice(1));
	if (!file) {
		c.res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
		return;
	}
	const data = await fsp.readFile(file);
	c.res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[pathMod.extname(file).toLowerCase()] ?? "application/octet-stream",
		"Content-Length": data.length,
		"Cache-Control": "no-cache",
	});
	c.res.end(c.req.method === "HEAD" ? undefined : data);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * auth: false for public routes; true for "any logged-in user may read, a
 * bookkeeper may change"; or the least role allowed.
 */
function route(method: string, pattern: string, auth: boolean | Role | "server", handler: Handler): Route {
	const role = auth === false ? null : auth === true ? (method === "GET" ? "viewer" : "bookkeeper") : auth;
	return { method, segments: pattern.split("/").slice(1), role, handler };
}

const ROUTES: Route[] = [
	route("GET", "/health", false, handleHealth),
	route("POST", "/auth/login", false, handleLogin),
	route("POST", "/auth/logout", false, handleLogout),

	// Everything else requires a logged-in user.
	route("GET", "/auth/me", true, handleMe),
	route("POST", "/auth/organization", "viewer", handleSwitchOrg),
	route("GET", "/organizations", true, handleListOrgs),
	route("POST", "/organizations", "server", handleCreateOrg),
	route("PATCH", "/organizations/:orgId", "server", handleUpdateOrg),
	route("POST", "/auth/password", "viewer", handleChangePassword),
	route("GET", "/settings/sidebar", true, handleGetSidebar),
	route("GET", "/users", "server", handleListUsers),
	route("POST", "/users", "server", handleCreateUser),
	route("PATCH", "/users/:username", "server", handleUpdateUser),
	route("PUT", "/users/:username/organizations/:orgId", "server", handlePutMembership),
	route("DELETE", "/users/:username/organizations/:orgId", "server", handleDeleteMembership),
	route("PUT", "/settings/sidebar", "viewer", handlePutSidebar),
	route("GET", "/currencies", true, handleListCurrencies),

	route("GET", "/accounts", true, handleListAccounts),
	route("POST", "/accounts", true, handleCreateAccount),
	route("GET", "/accounts/:accountCode", true, handleGetAccount),
	route("PATCH", "/accounts/:accountCode", true, handleUpdateAccount),
	route("GET", "/accounts/:accountCode/ledger", true, handleAccountLedger),

	route("GET", "/journal-entries", true, handleListJournalEntries),
	route("POST", "/journal-entries", true, handleCreateJournalEntry),
	route("GET", "/journal-entries/:entryId", true, handleGetJournalEntry),
	route("POST", "/journal-entries/:entryId/reverse", true, handleReverseJournalEntry),

	route("GET", "/search", true, handleSearch),
	route("GET", "/dashboard", true, handleGetDashboard),
	route("POST", "/dashboard/items/:itemId/close", true, handleCloseDashboardItem),
	route("POST", "/dashboard/items/:itemId/reopen", true, handleReopenDashboardItem),

	route("GET", "/reconciliations", true, handleListReconciliations),
	route("POST", "/reconciliations", true, handleCreateReconciliation),
	route("GET", "/reconciliations/:reconciliationId", true, handleGetReconciliation),
	route("PATCH", "/reconciliations/:reconciliationId", true, handleUpdateReconciliation),
	route("DELETE", "/reconciliations/:reconciliationId", true, handleDeleteReconciliation),
	route("POST", "/reconciliations/:reconciliationId/cleared", true, handleChangeCleared),
	route("POST", "/reconciliations/:reconciliationId/finish", true, handleFinishReconciliation),
	route("POST", "/reconciliations/:reconciliationId/undo", true, handleUndoReconciliation),

	route("GET", "/reports/trial-balance", true, handleTrialBalance),
	route("GET", "/reports/balance-sheet", true, handleBalanceSheet),
	route("GET", "/reports/income-statement", true, handleIncomeStatement),

	route("POST", "/exports/general-ledger", true, handleExportGeneralLedger),
	route("GET", "/files", true, handleListFiles),
	route("POST", "/files", true, handleUploadFile),
	route("GET", "/files/:filename", true, handleDownloadFile),
	route("POST", "/imports/journal-entries", true, handleImportJournalEntries),
	route("GET", "/migrations", true, handleMigrationInfo),
	route("POST", "/migrations", true, handleMigrationUpload),
	route("POST", "/migrations/:uploadId/preview", true, handleMigrationPreview),
	route("POST", "/migrations/:uploadId/import", true, handleMigrationImport),

	route("GET", "/backups", "admin", handleGetBackups),
	route("PUT", "/backups/config", "admin", handlePutBackupConfig),
	route("POST", "/backups/run", "admin", handleRunBackup),
	route("GET", "/backups/restorable", "admin", handleRestorable),
	route("POST", "/backups/restore", "admin", handleRestore),
	route("POST", "/backups/restore-settings", "admin", handleRestoreSettings),
	route("POST", "/backups/share/test", "admin", handleTestShare),
	route("POST", "/backups/google/connect", "admin", handleGoogleConnect),
	route("POST", "/backups/google/poll", "admin", handleGooglePoll),
	route("POST", "/backups/google/disconnect", "admin", handleGoogleDisconnect),

	route("GET", "/integrations/llm", "server", handleGetLlm),
	route("PUT", "/integrations/llm", "server", handlePutLlm),
	route("POST", "/integrations/llm/test", "server", handleTestLlm),
	route("GET", "/integrations/gmail", "server", handleGetGmail),
	route("PUT", "/integrations/gmail", "server", handlePutGmail),
	route("POST", "/integrations/gmail/start", "server", handleGmailStart),
	route("POST", "/integrations/gmail/finish", "server", handleGmailFinish),
	route("POST", "/integrations/gmail/disconnect", "server", handleGmailDisconnect),

	route("GET", "/system/update", "server", handleGetUpdate),
	route("PUT", "/system/update/schedule", "server", handlePutUpdateSchedule),
	route("POST", "/system/update/check", "server", handleCheckUpdate),
	route("PUT", "/system/update/repo", "server", handlePutUpdateRepo),

	route("GET", "/modules", true, handleListModules),
	route("POST", "/modules", "server", handleAddModule),
	route("POST", "/modules/preview", "server", handlePreviewModule),
	route("POST", "/modules/sync", "server", handleSyncModules),
	route("DELETE", "/modules/:id", "server", handleRemoveModule),
	route("PATCH", "/modules/:id", "server", handleRenameModuleRepo),
	route("GET", "/modules/:id/import", true, handleModuleImportInfo),
	route("POST", "/modules/:id/import", true, handleModuleImportUpload),
	route("POST", "/modules/:id/import/:uploadId/preview", true, handleModuleImportPreview),
	route("POST", "/modules/:id/import/:uploadId/run", true, handleModuleImportRun),
	route("GET", "/modules/:id/settings", "admin", handleGetModuleSettings),
	route("PUT", "/modules/:id/settings", "admin", handlePutModuleSettings),
];

/** Matches a path relative to /api/v1 against a route; returns its decoded params. */
function match(r: Route, segments: string[]): Record<string, string> | null {
	if (r.segments.length !== segments.length) return null;
	const params: Record<string, string> = {};
	for (const [i, seg] of r.segments.entries()) {
		const actual = segments[i]!;
		if (seg.startsWith(":")) {
			if (actual === "") return null;
			params[seg.slice(1)] = actual; // kept percent-encoded, so "%2F" can never become a path separator
		} else if (seg !== actual) {
			return null;
		}
	}
	return params;
}

async function serveAPI(c: Ctx, rel: string): Promise<void> {
	const segments = rel.split("/").slice(1);
	if (segments[0] === "m" && segments.length >= 2 && segments[1] !== "") return serveModuleAPI(c, segments);
	if (segments[0] === "modules" && segments[2] === "storage" && segments.length >= 4) return serveModuleStorage(c, segments[1]!, segments.slice(3));
	let pathMatched = false;
	for (const r of ROUTES) {
		const params = match(r, segments);
		if (!params) continue;
		pathMatched = true;
		if (r.method !== c.req.method) continue;
		c.params = params;
		if (r.role) {
			c.token = sessionToken(c.req);
			c.user = await sessionUser(c.app, c.token);
			if (r.role === "server") {
				if (!c.user.server_admin) throw new HttpError(403, "this needs an admin of the main books", "forbidden");
			} else if (!roleAtLeast(c.user.role, r.role)) throw new HttpError(403, `this needs the ${r.role} role (you are ${c.user.role})`, "forbidden");
			await inUserOrg(c, () => r.handler(c));
			return;
		}
		await r.handler(c);
		return;
	}
	if (pathMatched) writeError(c.res, 405, "bad_request", "method not allowed");
	else writeError(c.res, 404, "not_found", "no such endpoint");
}

/**
 * Rejects cross-site state-changing requests (checks Sec-Fetch-Site, then
 * Origin against Host), so another web page open in the same browser cannot
 * post entries or upload files to this server.
 */
function crossOriginAllowed(req: IncomingMessage): boolean {
	if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
	const site = req.headers["sec-fetch-site"] ?? "";
	if (site === "same-origin" || site === "none") return true;
	if (site !== "") return false;
	const origin = req.headers.origin ?? "";
	if (origin === "") return true; // not a browser
	const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/.exec(origin);
	return m !== null && m[1] === req.headers.host;
}

let requestCounter = 0;
const requestPrefix = randomBytes(4).toString("hex");

/** Builds the request handler for the HTTP server. */
export function createHandler(app: App): (req: IncomingMessage, res: ServerResponse) => void {
	const serveStatic = staticHandler(app.webDir);
	return (req, res) => {
		const start = performance.now();
		const requestId = `${requestPrefix}-${String(++requestCounter).padStart(6, "0")}`;
		const rawUrl = req.url ?? "/";
		const q = rawUrl.indexOf("?");
		const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
		res.on("finish", () => {
			log.info("request", {
				method: req.method,
				path: pathname,
				status: res.statusCode,
				duration_ms: Math.round(performance.now() - start),
				request_id: requestId,
			});
		});

		res.setHeader("X-Content-Type-Options", "nosniff");
		// Ledger may frame itself (side-by-side panes, module UIs), nothing else may.
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
		res.setHeader("Referrer-Policy", "same-origin");

		const c: Ctx = { app, req, res, params: {}, query: new URLSearchParams(q < 0 ? "" : rawUrl.slice(q + 1)), user: null, token: "" };
		const run = async () => {
			if (!crossOriginAllowed(req)) {
				writeError(res, 403, "forbidden", "cross-origin request rejected");
			} else if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
				await serveAPI(c, pathname.slice("/api/v1".length));
			} else if (pathname.startsWith("/api/")) {
				writeError(res, 404, "not_found", "no such endpoint");
			} else if (pathname === "/m" || pathname.startsWith("/m/")) {
				await serveModuleUI(c, pathname);
			} else {
				await serveStatic(req, res, pathname);
			}
		};
		run().catch((err) => {
			try {
				writeErr(c, err);
			} catch (e) {
				log.error("write error response", { err: String(e) });
				res.destroy();
			}
		});
	};
}
