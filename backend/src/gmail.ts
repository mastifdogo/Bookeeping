// Gmail, connected once under Settings → Gmail with Google OAuth and shared
// with modules (ctx.gmail). Each module needs an admin's permission to read
// mail and, separately, to send it.
//
// Ledger usually runs on a LAN address, which Google won't accept as an OAuth
// redirect. So it uses a "Desktop app" OAuth client with the loopback
// redirect http://127.0.0.1: after the user approves, their browser goes to
// an address that doesn't load, and they paste that address (or just the
// code in it) back into Ledger. PKCE protects the exchange.

import { createHash, randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { HttpError, ValidationError } from "./errors.ts";
import { moduleIdList, readIntegration } from "./integrations.ts";

export const SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_SEND = "https://www.googleapis.com/auth/gmail.send";
export const REDIRECT_URI = "http://127.0.0.1";
const TIMEOUT_MS = 30_000;

export interface GoogleEndpoints {
	/** https://accounts.google.com (the consent page) */
	auth: string;
	/** https://oauth2.googleapis.com (tokens) */
	oauth: string;
	/** https://gmail.googleapis.com */
	gmail: string;
}

export function gmailEndpoints(): GoogleEndpoints {
	return {
		auth: process.env.GOOGLE_AUTH_BASE || "https://accounts.google.com",
		oauth: process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com",
		gmail: process.env.GMAIL_API_BASE || "https://gmail.googleapis.com",
	};
}

export interface GmailConfig {
	client_id: string;
	client_secret: string;
	refresh_token: string;
	account: string;
	scopes: string[];
	/** Modules allowed to read mail, and to send it. */
	allow_read: string[];
	allow_send: string[];
}

export const GMAIL_DEFAULTS: GmailConfig = { client_id: "", client_secret: "", refresh_token: "", account: "", scopes: [], allow_read: [], allow_send: [] };

export const readGmailConfig = (dir: string) => readIntegration(dir, "gmail", GMAIL_DEFAULTS);

export function publicGmailConfig(c: GmailConfig) {
	return {
		client_id: c.client_id,
		has_client_secret: c.client_secret !== "",
		connected: c.refresh_token !== "",
		account: c.account,
		can_read: c.scopes.includes(SCOPE_READ),
		can_send: c.scopes.includes(SCOPE_SEND),
		allow_read: c.allow_read,
		allow_send: c.allow_send,
		redirect_uri: REDIRECT_URI,
	};
}

/** Settings → Gmail: the OAuth client and which modules may use it. */
export function applyGmailChange(c: GmailConfig, v: unknown): GmailConfig {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!["client_id", "client_secret", "allow_read", "allow_send"].includes(k)) err.add(k, "unknown field");
	const next = structuredClone(c);
	if (o.client_id !== undefined) {
		const id = typeof o.client_id === "string" ? o.client_id.trim() : "";
		if (id !== "" && !/^[0-9A-Za-z._-]{3,200}\.apps\.googleusercontent\.com$/.test(id)) err.add("client_id", "must be an OAuth client ID ending in .apps.googleusercontent.com");
		else if (id !== c.client_id) Object.assign(next, { client_id: id, client_secret: "", refresh_token: "", account: "", scopes: [] });
	}
	if (o.client_secret !== undefined && o.client_secret !== null) {
		if (typeof o.client_secret !== "string" || o.client_secret.length > 200 || /\s/.test(o.client_secret)) err.add("client_secret", "is not valid");
		else next.client_secret = o.client_secret;
	}
	for (const k of ["allow_read", "allow_send"] as const) {
		if (o[k] === undefined) continue;
		const list = moduleIdList(o[k]);
		if (!list) err.add(k, "must be a list of module ids");
		else next[k] = list;
	}
	err.throwIfAny();
	return next;
}

export class GmailError extends HttpError {
	constructor(message: string, status = 502) {
		super(status, `Gmail: ${message}`, "gmail_error");
	}
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export interface PendingAuth {
	state: string;
	verifier: string;
	scopes: string[];
	expires: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** The consent page to open; the PKCE verifier and state are kept in memory. */
export function startAuth(c: GmailConfig, ep: GoogleEndpoints, send: boolean): { url: string; pending: PendingAuth } {
	if (!c.client_id || !c.client_secret) throw new HttpError(409, "save the OAuth client ID and secret first", "conflict");
	const verifier = b64url(randomBytes(48));
	const pending: PendingAuth = { state: b64url(randomBytes(18)), verifier, scopes: send ? [SCOPE_READ, SCOPE_SEND] : [SCOPE_READ], expires: Date.now() + 15 * 60_000 };
	const u = new URL("/o/oauth2/v2/auth", ep.auth);
	u.search = new URLSearchParams({
		client_id: c.client_id,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: pending.scopes.join(" "),
		access_type: "offline",
		prompt: "consent",
		code_challenge: b64url(createHash("sha256").update(verifier).digest()),
		code_challenge_method: "S256",
		state: pending.state,
	}).toString();
	return { url: u.toString(), pending };
}

/** The code from what the user pasted: the whole redirected address, or the code alone. */
export function codeFromPaste(paste: string, state: string): string {
	const s = paste.trim();
	if (/^https?:\/\//i.test(s)) {
		let u: URL;
		try {
			u = new URL(s);
		} catch {
			throw new GmailError("that isn't a valid address", 422);
		}
		const e = u.searchParams.get("error");
		if (e) throw new GmailError(e === "access_denied" ? "access was denied on Google's page" : `Google answered ${e}`, 422);
		if (u.searchParams.get("state") !== state) throw new GmailError("that address is from a different attempt; press Connect again", 422);
		const code = u.searchParams.get("code");
		if (!code) throw new GmailError("the address has no code in it; copy the whole address after approving", 422);
		return code;
	}
	if (!/^[\w./-]{10,512}$/.test(s)) throw new GmailError("paste the whole address your browser showed after approving", 422);
	return s;
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: any }> {
	let res: Response;
	try {
		res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (e: any) {
		throw new GmailError(`could not reach Google: ${e?.cause?.message || e?.message}`);
	}
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

const googleWhy = (b: any, status: number) => (typeof b?.error === "string" ? `${b.error}${b.error_description ? `: ${b.error_description}` : ""}` : (b?.error?.message ?? `HTTP ${status}`));

/** Exchanges the code; returns the settings with the account connected. */
export async function finishAuth(c: GmailConfig, pending: PendingAuth, code: string, ep: GoogleEndpoints): Promise<GmailConfig> {
	if (Date.now() > pending.expires) throw new GmailError("that attempt expired; press Connect again", 409);
	const r = await postForm(`${ep.oauth}/token`, {
		code,
		client_id: c.client_id,
		client_secret: c.client_secret,
		redirect_uri: REDIRECT_URI,
		grant_type: "authorization_code",
		code_verifier: pending.verifier,
	});
	if (r.status !== 200 || typeof r.body.access_token !== "string") throw new GmailError(`Google refused the code: ${googleWhy(r.body, r.status)}`, 422);
	if (typeof r.body.refresh_token !== "string") {
		throw new GmailError("Google sent no refresh token; remove Ledger at myaccount.google.com/permissions and connect again", 422);
	}
	const granted = typeof r.body.scope === "string" ? r.body.scope.split(" ") : pending.scopes;
	if (!granted.includes(SCOPE_READ)) throw new GmailError("reading mail wasn't allowed on Google's page; tick it when you connect", 422);
	const profile = await gmailFetch(ep, r.body.access_token, "GET", "/gmail/v1/users/me/profile");
	return { ...c, refresh_token: r.body.refresh_token, scopes: granted.filter((s: string) => s === SCOPE_READ || s === SCOPE_SEND), account: String(profile.emailAddress ?? "") };
}

export async function revoke(c: GmailConfig, ep: GoogleEndpoints): Promise<void> {
	if (c.refresh_token) await postForm(`${ep.oauth}/revoke`, { token: c.refresh_token }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

/** Access tokens, cached in memory until shortly before they expire. */
const tokens = new Map<string, { token: string; expires: number }>();

async function accessToken(c: GmailConfig, ep: GoogleEndpoints): Promise<string> {
	if (!c.refresh_token) throw new GmailError("Gmail isn't connected; an admin can connect it under Settings → Gmail", 409);
	const hit = tokens.get(c.refresh_token);
	if (hit && hit.expires > Date.now() + 60_000) return hit.token;
	const r = await postForm(`${ep.oauth}/token`, { client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" });
	if (r.status !== 200 || typeof r.body.access_token !== "string") {
		throw new GmailError(
			r.body?.error === "invalid_grant"
				? "Google access was revoked or expired; an admin can connect Gmail again under Settings → Gmail (publish the OAuth app to stop weekly expiry)"
				: `couldn't sign in to Google: ${googleWhy(r.body, r.status)}`,
			409,
		);
	}
	tokens.set(c.refresh_token, { token: r.body.access_token, expires: Date.now() + Number(r.body.expires_in ?? 3600) * 1000 });
	return r.body.access_token;
}

async function gmailFetch(ep: GoogleEndpoints, token: string, method: string, p: string, body?: unknown): Promise<any> {
	let res: Response;
	try {
		res = await fetch(ep.gmail + p, {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e: any) {
		throw new GmailError(`could not reach Gmail: ${e?.cause?.message || e?.message}`);
	}
	const j: any = await res.json().catch(() => ({}));
	if (!res.ok) throw new GmailError(`Gmail answered ${res.status}: ${googleWhy(j, res.status)}`, res.status === 404 ? 404 : 502);
	return j;
}

export interface MessageSummary {
	id: string;
	threadId: string;
	date: string;
	from: string;
	to: string;
	subject: string;
	snippet: string;
	labels: string[];
}

export interface MessageDetail extends MessageSummary {
	cc: string;
	text: string;
	html: string;
	attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

const header = (h: { name: string; value: string }[] | undefined, name: string) => h?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function summary(m: any): MessageSummary {
	const h = m.payload?.headers;
	return {
		id: m.id,
		threadId: m.threadId,
		date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
		from: header(h, "From"),
		to: header(h, "To"),
		subject: header(h, "Subject"),
		snippet: m.snippet ?? "",
		labels: m.labelIds ?? [],
	};
}

/** Runs up to `n` promises at a time. */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k]!);
			}
		}),
	);
	return out;
}

/** What a module can do: everything is checked against Settings → Gmail. */
export function gmailFor(app: App, moduleId: string) {
	const ctx = async (need: "read" | "send") => {
		const c = await readGmailConfig(app.integrations.dir);
		const scope = need === "read" ? SCOPE_READ : SCOPE_SEND;
		if (!c.refresh_token) throw new GmailError("Gmail isn't connected; an admin can connect it under Settings → Gmail", 409);
		if (!c.scopes.includes(scope)) throw new GmailError(`Gmail was connected without permission to ${need} mail; an admin can reconnect it under Settings → Gmail`, 409);
		if (!(need === "read" ? c.allow_read : c.allow_send).includes(moduleId)) {
			throw new GmailError(`this module isn't allowed to ${need} mail; an admin can allow it under Settings → Gmail`, 403);
		}
		return { token: await accessToken(c, app.integrations.gmail), ep: app.integrations.gmail };
	};
	const checkId = (id: string, what: string) => {
		if (typeof id !== "string" || !ID_RE.test(id)) throw new GmailError(`invalid ${what}`, 422);
	};

	return {
		/** { connected, account, canRead, canSend } for this module. */
		async status() {
			const c = await readGmailConfig(app.integrations.dir);
			const connected = c.refresh_token !== "";
			return {
				connected,
				account: c.account,
				canRead: connected && c.scopes.includes(SCOPE_READ) && c.allow_read.includes(moduleId),
				canSend: connected && c.scopes.includes(SCOPE_SEND) && c.allow_send.includes(moduleId),
			};
		},

		/** Messages matching a Gmail search (e.g. "from:billing@ newer_than:30d has:attachment"), newest first. */
		async search(query: string, opts: { max?: number; pageToken?: string } = {}): Promise<{ messages: MessageSummary[]; nextPageToken: string | null }> {
			const { token, ep } = await ctx("read");
			const max = Math.min(Math.max(Math.trunc(opts.max ?? 25), 1), 100);
			const qs = new URLSearchParams({ q: String(query ?? ""), maxResults: String(max) });
			if (opts.pageToken) qs.set("pageToken", String(opts.pageToken));
			const list = await gmailFetch(ep, token, "GET", `/gmail/v1/users/me/messages?${qs}`);
			const ids: string[] = (list.messages ?? []).map((m: any) => m.id).filter((id: unknown) => typeof id === "string" && ID_RE.test(id));
			const meta = new URLSearchParams([["format", "metadata"], ...["From", "To", "Subject", "Date"].map((h): [string, string] => ["metadataHeaders", h])]);
			const messages = await mapLimit(ids, 8, async (id) => summary(await gmailFetch(ep, token, "GET", `/gmail/v1/users/me/messages/${id}?${meta}`)));
			return { messages, nextPageToken: list.nextPageToken ?? null };
		},

		/** One message: headers, text and HTML bodies, and its attachments (fetch them with attachment()). */
		async message(id: string): Promise<MessageDetail> {
			checkId(id, "message id");
			const { token, ep } = await ctx("read");
			const m = await gmailFetch(ep, token, "GET", `/gmail/v1/users/me/messages/${id}?format=full`);
			let text = "";
			let html = "";
			const attachments: MessageDetail["attachments"] = [];
			const walk = (p: any) => {
				if (!p) return;
				const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
				if (p.filename && p.body?.attachmentId) {
					attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "", size: p.body.size ?? 0 });
				} else if (p.mimeType === "text/plain" && !text) text = data;
				else if (p.mimeType === "text/html" && !html) html = data;
				for (const c of p.parts ?? []) walk(c);
			};
			walk(m.payload);
			return { ...summary(m), cc: header(m.payload?.headers, "Cc"), text, html, attachments };
		},

		/** The whole message as RFC 822 source (a Buffer), for your own MIME parsing. */
		async raw(id: string): Promise<Buffer> {
			checkId(id, "message id");
			const { token, ep } = await ctx("read");
			const m = await gmailFetch(ep, token, "GET", `/gmail/v1/users/me/messages/${id}?format=raw`);
			return Buffer.from(String(m.raw ?? ""), "base64url");
		},

		/** An attachment's bytes (a Buffer). */
		async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
			checkId(messageId, "message id");
			if (typeof attachmentId !== "string" || !/^[A-Za-z0-9_-]{1,2000}$/.test(attachmentId)) throw new GmailError("invalid attachment id", 422);
			const { token, ep } = await ctx("read");
			const a = await gmailFetch(ep, token, "GET", `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
			return Buffer.from(String(a.data ?? ""), "base64url");
		},

		/** Sends an email from the connected account. Returns Gmail's message id. */
		async send(mail: SendMail): Promise<{ id: string; threadId: string }> {
			const raw = buildMime(mail);
			const { token, ep } = await ctx("send");
			const r = await gmailFetch(ep, token, "POST", `/gmail/v1/users/me/messages/send`, {
				raw: raw.toString("base64url"),
				...(mail.threadId ? { threadId: mail.threadId } : {}),
			});
			return { id: r.id, threadId: r.threadId };
		},
	};
}

export interface SendMail {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string;
	subject: string;
	text?: string;
	html?: string;
	attachments?: { filename: string; contentType?: string; content: Buffer | Uint8Array | string }[];
	/** Reply in an existing thread. */
	threadId?: string;
}

const ADDRESS_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+$|^[^<>\r\n]{0,100}<[^\s<>@,;"]+@[^\s<>@,;"]+>$/;
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

/** A MIME message from SendMail; validates every address and header. */
export function buildMime(mail: SendMail, extra: { from?: string; date?: Date; messageId?: string; omitBcc?: boolean } = {}): Buffer {
	const err = new ValidationError();
	const list = (v: unknown, field: string, required: boolean): string[] => {
		const a = v === undefined ? [] : Array.isArray(v) ? v : [v];
		if (required && a.length === 0) err.add(field, "is required");
		if (a.length > 100 || !a.every((x) => typeof x === "string" && ADDRESS_RE.test(x.trim()))) err.add(field, "must be email addresses");
		return a.map((x) => String(x).trim());
	};
	const to = list(mail?.to, "to", true);
	const cc = list(mail?.cc, "cc", false);
	const bcc = list(mail?.bcc, "bcc", false);
	const replyTo = mail?.replyTo === undefined ? [] : list(mail.replyTo, "replyTo", false);
	if (typeof mail?.subject !== "string" || mail.subject.length > 500 || /[\r\n]/.test(mail.subject)) err.add("subject", "must be one line of text");
	if (mail?.text === undefined && mail?.html === undefined) err.add("text", "give text or html");
	const atts = mail?.attachments ?? [];
	if (!Array.isArray(atts) || atts.length > 20) err.add("attachments", "at most 20");
	for (const a of Array.isArray(atts) ? atts : []) {
		if (typeof a?.filename !== "string" || !/^[^\r\n"\\/]{1,200}$/.test(a.filename)) err.add("attachments", "each needs a filename");
		if (a?.contentType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)) err.add("attachments", "contentType must be like application/pdf");
	}
	err.throwIfAny();
	const boundary = (tag: string) => `=_ledger_${tag}_${randomBytes(12).toString("hex")}`;
	const head = [
		// Gmail fills these in itself; an SMTP server expects them.
		...(extra.from ? [`From: ${extra.from}`] : []),
		...(extra.date ? [`Date: ${extra.date.toUTCString().replace("GMT", "+0000")}`] : []),
		...(extra.messageId ? [`Message-ID: <${extra.messageId}>`] : []),
		`To: ${to.join(", ")}`,
		...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
		...(bcc.length && !extra.omitBcc ? [`Bcc: ${bcc.join(", ")}`] : []),
		...(replyTo.length ? [`Reply-To: ${replyTo.join(", ")}`] : []),
		`Subject: ${encodeWord(mail.subject)}`,
		"MIME-Version: 1.0",
	];
	const textPart = (type: string, body: string) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(body).toString("base64"))].join("\r\n");
	let bodyPart: string;
	if (mail.text !== undefined && mail.html !== undefined) {
		const b = boundary("alt");
		bodyPart = [`Content-Type: multipart/alternative; boundary="${b}"`, "", `--${b}`, textPart("text/plain", mail.text), `--${b}`, textPart("text/html", mail.html), `--${b}--`, ""].join("\r\n");
	} else {
		bodyPart = mail.html !== undefined ? textPart("text/html", mail.html) : textPart("text/plain", mail.text!);
	}
	if (atts.length === 0) return Buffer.from([...head, bodyPart].join("\r\n"));
	const b = boundary("mix");
	const parts = atts.map((a) =>
		[
			`Content-Type: ${a.contentType ?? "application/octet-stream"}; name="${encodeWord(a.filename)}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${encodeWord(a.filename)}"`,
			"",
			wrap76(typeof a.content === "string" ? Buffer.from(a.content).toString("base64") : Buffer.from(a.content).toString("base64")),
		].join("\r\n"),
	);
	return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, bodyPart, ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, ""].join("\r\n"));
}

