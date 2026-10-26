// HTTP layer. Paths match api/openapi.yaml under /api/v1; everything else
// serves the built SvelteKit frontend.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { isPgError } from "./db.ts";
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
import { ACCOUNT_CODE_RE, isCurrency, publicUser, type Currency, type User } from "./types.ts";
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
	nextScheduledTime,
	readSchedule,
	readStatus,
	requestRunNow,
	updaterInstalled,
	validateSchedule,
	writeSchedule,
} from "./update.ts";
import { createAccount, getAccount, getAccountLedger, getTrialBalance, listAccounts, listCurrencies, updateAccount } from "./accounts.ts";
import { createJournalEntry, getJournalEntry, listJournalEntries, reverseJournalEntry, type EntryFilter } from "./ledger.ts";
import { getBalanceSheet, getIncomeStatement } from "./reports.ts";
import { CSV_FILENAME_RE, MAX_FILE_BYTES, exportGeneralLedger, listCsvFiles, openCsvFile, saveUploadedCsv } from "./files.ts";
import { importJournalEntries } from "./import.ts";
import { getDashboard, setItemClosed } from "./dashboard.ts";
import { decodeSidebar, getSidebar, putSidebar } from "./settings.ts";
import {
	applyConfigChange,
	backupsInstalled,
	listShareDumps,
	nextBackupTime,
	pollDeviceFlow,
	publicConfig,
	readBackupStatus,
	readConfig,
	revokeGoogle,
	runBackup,
	startDeviceFlow,
	testShare,
	writeConfig,
} from "./backup.ts";
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
import { changePassword, login, logout, normalizeUsername, sessionUser, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./auth.ts";
import { MultipartError, formDataBoundary, parseHeaderParams, parseMultipart } from "./multipart.ts";
import { CONTENT_TYPES, staticHandler } from "./static.ts";
import { promises as fsp } from "node:fs";
import pathMod from "node:path";
import { MAX_MODULES, normalizeRepo, readDesired, readModuleResults, requestModuleSync, writeDesired, compatible, type DesiredModule } from "./modules.ts";
import { fetchManifest, githubApi, latestModuleRelease } from "./github.ts";

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
	auth: boolean;
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
	writeJSON(c.res, 200, publicUser(c.user!));
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
	const f: EntryFilter = { from, to, accountCode: null, limit: 50, offset: 0 };
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

async function backupsInfo(c: Ctx) {
	const available = await backupsInstalled(c.app.backup.dir);
	const config = await readConfig(c.app.backup.dir);
	const status = await readBackupStatus(c.app.backup.dir);
	// A run that died without finishing (container restarted) is not running any more.
	if (status.state === "running" && !c.app.backup.running && Date.now() - Date.parse(status.started_at ?? "") > 3 * 3600_000) {
		Object.assign(status, { state: "error", message: "The last backup did not finish (the server may have restarted)." });
	}
	return {
		available,
		config: publicConfig(config),
		status,
		next_run: nextBackupTime(config),
		share_files: available && config.truenas.enabled ? await listShareDumps(config.truenas.path) : [],
	};
}

async function handleGetBackups(c: Ctx): Promise<void> {
	writeJSON(c.res, 200, await backupsInfo(c));
}

async function handlePutBackupConfig(c: Ctx): Promise<void> {
	await requireBackups(c);
	const body = await decodeBody(c, true, (v) => plainJson(v));
	const next = applyConfigChange(await readConfig(c.app.backup.dir), body);
	await writeConfig(c.app.backup.dir, next);
	writeJSON(c.res, 200, await backupsInfo(c));
}

async function handleRunBackup(c: Ctx): Promise<void> {
	await requireBackups(c);
	if (!c.app.backup.databaseUrl) throw new ConflictError("DATABASE_URL is not known to the app");
	if (c.app.backup.running) throw new ConflictError("a backup is already running");
	const job = runBackup({ dir: c.app.backup.dir, databaseUrl: c.app.backup.databaseUrl, trigger: "manual", google: c.app.backup.google })
		.catch((err: Error) => log.error("backup failed", { err: err.message }))
		.finally(() => {
			c.app.backup.running = null;
		});
	c.app.backup.running = job;
	// Give it a moment to record that it started, so the page shows "running".
	await Promise.race([job, new Promise((r) => setTimeout(r, 300))]);
	writeJSON(c.res, 202, await backupsInfo(c));
}

async function handleTestShare(c: Ctx): Promise<void> {
	await requireBackups(c);
	const body = await decodeBody(c, true, (v) => plainJson(v) as { path?: unknown });
	writeJSON(c.res, 200, await testShare(typeof body?.path === "string" ? body.path : ""));
}

async function handleGoogleConnect(c: Ctx): Promise<void> {
	await requireBackups(c);
	const config = await readConfig(c.app.backup.dir);
	const code = await startDeviceFlow(config.google, c.app.backup.google);
	c.app.backup.device = code;
	writeJSON(c.res, 200, { user_code: code.user_code, verification_url: code.verification_url, expires_at: new Date(code.expires_at).toISOString(), interval: code.interval });
}

async function handleGooglePoll(c: Ctx): Promise<void> {
	await requireBackups(c);
	const code = c.app.backup.device;
	if (!code) throw new ConflictError("start connecting first");
	const config = await readConfig(c.app.backup.dir);
	const r = await pollDeviceFlow(config.google, code, c.app.backup.google);
	if (r.state === "connected") {
		await writeConfig(c.app.backup.dir, { ...config, google: { ...r.google, enabled: true } });
		c.app.backup.device = null;
		writeJSON(c.res, 200, { state: "connected", account: r.google.account });
		return;
	}
	if (r.state !== "pending") c.app.backup.device = null;
	writeJSON(c.res, 200, { state: r.state, account: "" });
}

async function handleGoogleDisconnect(c: Ctx): Promise<void> {
	await requireBackups(c);
	const config = await readConfig(c.app.backup.dir);
	await revokeGoogle(config.google, c.app.backup.google);
	await writeConfig(c.app.backup.dir, { ...config, google: { ...config.google, enabled: false, refresh_token: "", folder_id: "", account: "" } });
	writeJSON(c.res, 200, await backupsInfo(c));
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
	return {
		current_version: c.app.version,
		updater_installed: await updaterInstalled(c.app.update),
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

/** /api/v1/m/<id>/...: a module's own API. Always requires a session. */
async function serveModuleAPI(c: Ctx, segments: string[]): Promise<void> {
	c.token = sessionToken(c.req);
	c.user = await sessionUser(c.app, c.token);
	const id = segments[1]!;
	const rest = segments.length > 2 ? segments.slice(2) : [""];
	const found = c.app.modules.match(id, c.req.method ?? "", rest);
	if (found === null) return writeError(c.res, 404, "not_found", "no such endpoint");
	if (found === "method") return writeError(c.res, 405, "bad_request", "method not allowed");
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

function route(method: string, pattern: string, auth: boolean, handler: Handler): Route {
	return { method, segments: pattern.split("/").slice(1), auth, handler };
}

const ROUTES: Route[] = [
	route("GET", "/health", false, handleHealth),
	route("POST", "/auth/login", false, handleLogin),
	route("POST", "/auth/logout", false, handleLogout),

	// Everything else requires a logged-in user.
	route("GET", "/auth/me", true, handleMe),
	route("POST", "/auth/password", true, handleChangePassword),
	route("GET", "/settings/sidebar", true, handleGetSidebar),
	route("PUT", "/settings/sidebar", true, handlePutSidebar),
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

	route("GET", "/backups", true, handleGetBackups),
	route("PUT", "/backups/config", true, handlePutBackupConfig),
	route("POST", "/backups/run", true, handleRunBackup),
	route("POST", "/backups/truenas/test", true, handleTestShare),
	route("POST", "/backups/google/connect", true, handleGoogleConnect),
	route("POST", "/backups/google/poll", true, handleGooglePoll),
	route("POST", "/backups/google/disconnect", true, handleGoogleDisconnect),

	route("GET", "/system/update", true, handleGetUpdate),
	route("PUT", "/system/update/schedule", true, handlePutUpdateSchedule),
	route("POST", "/system/update/check", true, handleCheckUpdate),

	route("GET", "/modules", true, handleListModules),
	route("POST", "/modules", true, handleAddModule),
	route("POST", "/modules/preview", true, handlePreviewModule),
	route("POST", "/modules/sync", true, handleSyncModules),
	route("DELETE", "/modules/:id", true, handleRemoveModule),
	route("GET", "/modules/:id/settings", true, handleGetModuleSettings),
	route("PUT", "/modules/:id/settings", true, handlePutModuleSettings),
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
	let pathMatched = false;
	for (const r of ROUTES) {
		const params = match(r, segments);
		if (!params) continue;
		pathMatched = true;
		if (r.method !== c.req.method) continue;
		c.params = params;
		if (r.auth) {
			c.token = sessionToken(c.req);
			c.user = await sessionUser(c.app, c.token);
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
