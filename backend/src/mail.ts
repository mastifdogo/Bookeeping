// A mailbox reached over IMAP and SMTP, set once under Settings → Mail and
// shared with modules (ctx.mail). Made for Proton Mail, which is only
// reachable through Proton Mail Bridge (a program that offers IMAP and SMTP
// on the machine it runs on), and good for any other mailbox with a password.
//
// ctx.mail is the same for every kind of mailbox: it reads and sends through
// this account when one is set up, and through Gmail (Settings → Gmail)
// otherwise. Each module needs an admin's permission to read mail and,
// separately, to send it.

import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { HttpError, ValidationError } from "./errors.ts";
import { buildMime, gmailFor, type SendMail } from "./gmail.ts";
import { moduleIdList, readIntegration } from "./integrations.ts";
import { ImapClient, MailError as ClientError, smtpCheck, smtpSend, type ImapSearch, type Security, type ServerOptions } from "./mail-client.ts";
import { decodeWords, parseEmail, parseHeaders } from "./mime.ts";

export const SECURITIES = ["starttls", "tls", "none"] as const;

export interface MailConfig {
	/** The address mail is sent from. */
	account: string;
	/** Shown next to the address on mail Ledger sends. */
	from_name: string;
	username: string;
	password: string;
	imap_host: string;
	imap_port: number;
	imap_security: Security;
	smtp_host: string;
	smtp_port: number;
	smtp_security: Security;
	/** The folder modules read. */
	folder: string;
	/** Accept the server's own certificate (Proton Mail Bridge signs its own). */
	trust_certificate: boolean;
	allow_read: string[];
	allow_send: string[];
}

export const MAIL_DEFAULTS: MailConfig = {
	account: "",
	from_name: "",
	username: "",
	password: "",
	imap_host: "",
	imap_port: 993,
	imap_security: "tls",
	smtp_host: "",
	smtp_port: 465,
	smtp_security: "tls",
	folder: "INBOX",
	trust_certificate: false,
	allow_read: [],
	allow_send: [],
};

/** What to fill in for a kind of mailbox; the page offers these as buttons. */
export const MAIL_PRESETS = [
	{
		id: "proton",
		label: "Proton Mail Bridge",
		note: "Proton Mail Bridge must run on this server. Its \"info\" command shows the username, the password it made for mail programs (not your Proton password) and the ports; change the ones below if they differ.",
		values: { imap_host: "127.0.0.1", imap_port: 1143, imap_security: "starttls", smtp_host: "127.0.0.1", smtp_port: 1025, smtp_security: "starttls", trust_certificate: true },
	},
	{
		id: "other",
		label: "Another mailbox (IMAP and SMTP)",
		note: "Use the server names your mail host gives for mail programs. Many hosts need an app password rather than your normal one.",
		values: { imap_host: "", imap_port: 993, imap_security: "tls", smtp_host: "", smtp_port: 465, smtp_security: "tls", trust_certificate: false },
	},
] as const;

export const readMailConfig = (dir: string) => readIntegration(dir, "mail", MAIL_DEFAULTS);

const canRead = (c: MailConfig) => c.imap_host !== "" && c.username !== "" && c.password !== "";
const canSend = (c: MailConfig) => c.smtp_host !== "" && c.username !== "" && c.password !== "" && c.account !== "";

export function publicMailConfig(c: MailConfig) {
	const { password, ...rest } = c;
	return { ...rest, has_password: password !== "", connected: canRead(c), can_send: canSend(c), presets: MAIL_PRESETS, securities: SECURITIES };
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;
const EMAIL_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

/** Applies a change from Settings → Mail. password omitted or null keeps the saved one, "" clears it. */
export function applyMailChange(c: MailConfig, v: unknown): MailConfig {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!(k in MAIL_DEFAULTS)) err.add(k, "unknown field");
	const next = structuredClone(c);
	const text = (k: "account" | "from_name" | "username" | "folder" | "imap_host" | "smtp_host", max: number, re?: RegExp, why = "is not valid") => {
		if (o[k] === undefined) return;
		const s = typeof o[k] === "string" ? (o[k] as string).trim() : null;
		if (s === null || s.length > max || /[\r\n\0]/.test(s) || (s !== "" && re && !re.test(s))) err.add(k, why);
		else next[k] = s;
	};
	text("account", 254, EMAIL_RE, "must be an email address");
	text("from_name", 100, /^[^<>"]*$/, "can't contain < > or quotes");
	text("username", 254);
	text("folder", 200);
	text("imap_host", 253, HOST_RE, "must be a host name or address");
	text("smtp_host", 253, HOST_RE, "must be a host name or address");
	if (next.folder === "") next.folder = "INBOX";
	for (const k of ["imap_port", "smtp_port"] as const) {
		if (o[k] === undefined) continue;
		if (!Number.isInteger(o[k]) || (o[k] as number) < 1 || (o[k] as number) > 65535) err.add(k, "must be a port number");
		else next[k] = o[k] as number;
	}
	for (const k of ["imap_security", "smtp_security"] as const) {
		if (o[k] === undefined) continue;
		if (!SECURITIES.includes(o[k] as Security)) err.add(k, `must be one of ${SECURITIES.join(", ")}`);
		else next[k] = o[k] as Security;
	}
	if (o.trust_certificate !== undefined) {
		if (typeof o.trust_certificate !== "boolean") err.add("trust_certificate", "must be true or false");
		else next.trust_certificate = o.trust_certificate;
	}
	if (o.password !== undefined && o.password !== null) {
		if (typeof o.password !== "string" || o.password.length > 500 || /[\r\n\0]/.test(o.password)) err.add("password", "is not valid");
		else next.password = o.password;
	}
	for (const k of ["allow_read", "allow_send"] as const) {
		if (o[k] === undefined) continue;
		const list = moduleIdList(o[k]);
		if (!list) err.add(k, "must be a list of module ids");
		else next[k] = list;
	}
	// A password saved for one server is never sent to another.
	if ((next.imap_host !== c.imap_host || next.smtp_host !== c.smtp_host || next.username !== c.username) && (o.password === undefined || o.password === null) && c.password !== "") {
		if (c.imap_host !== "" || c.smtp_host !== "") err.add("password", "enter the password again when the server or username changes");
	}
	err.throwIfAny();
	return next;
}

export class MailError extends HttpError {
	constructor(message: string, status = 502) {
		super(status, `Mail: ${message}`, "mail_error");
	}
}

const imapServer = (c: MailConfig): ServerOptions => ({ host: c.imap_host, port: c.imap_port, security: c.imap_security, trustCertificate: c.trust_certificate });
const smtpServer = (c: MailConfig): ServerOptions => ({ host: c.smtp_host, port: c.smtp_port, security: c.smtp_security, trustCertificate: c.trust_certificate });
const asMailError = (e: unknown): never => {
	if (e instanceof HttpError) throw e;
	throw new MailError(e instanceof ClientError ? e.message : `${(e as Error)?.message ?? e}`);
};

/** Logs in, opens the folder, runs fn and logs out. */
async function withImap<T>(c: MailConfig, fn: (imap: ImapClient, box: { uidvalidity: number; exists: number }) => Promise<T>): Promise<T> {
	const imap = new ImapClient(imapServer(c));
	try {
		await imap.connect();
		await imap.login(c.username, c.password);
		const out = await fn(imap, await imap.examine(c.folder));
		await imap.logout();
		return out;
	} catch (e) {
		return asMailError(e);
	} finally {
		imap.close();
	}
}

/** Settings → Mail → Test: signs in for reading and for sending (nothing is sent). */
export async function testMail(c: MailConfig) {
	const why = (e: unknown) => (e as Error).message.replace(/^Mail: /, "");
	const out = { imap: { ok: false, message: "Not set up." }, smtp: { ok: false, message: "Not set up." } };
	if (canRead(c)) {
		try {
			const n = await withImap(c, async (_imap, box) => box.exists);
			out.imap = { ok: true, message: `Signed in; ${n.toLocaleString("en")} message${n === 1 ? "" : "s"} in ${c.folder}.` };
		} catch (e) {
			out.imap = { ok: false, message: why(e) };
		}
	}
	if (canSend(c)) {
		try {
			await smtpCheck(smtpServer(c), c.username, c.password);
			out.smtp = { ok: true, message: "Signed in; ready to send." };
		} catch (e) {
			out.smtp = { ok: false, message: why(e) };
		}
	} else if (c.smtp_host !== "" && c.account === "") out.smtp.message = "Enter the email address to send from.";
	return out;
}

// ---------------------------------------------------------------------------
// ctx.mail
// ---------------------------------------------------------------------------

export interface MailSearch {
	from?: string;
	to?: string;
	subject?: string;
	/** Words anywhere in the message. */
	text?: string;
	/** Received on or after / before this day (a Date or "YYYY-MM-DD"). */
	since?: Date | string;
	before?: Date | string;
	/** At most this many, newest first (default 25, at most 100). */
	max?: number;
}

export interface MailSummary {
	id: string;
	date: string;
	from: string;
	to: string;
	subject: string;
	snippet: string;
}

export interface MailDetail extends MailSummary {
	cc: string;
	text: string;
	html: string;
	attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

function checkSearch(q: MailSearch): { filter: ImapSearch; max: number } {
	const err = new ValidationError();
	const o = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!["from", "to", "subject", "text", "since", "before", "max"].includes(k)) err.add(k, "unknown field");
	const filter: ImapSearch = {};
	for (const k of ["from", "to", "subject", "text"] as const) {
		if (o[k] === undefined || o[k] === "") continue;
		if (typeof o[k] !== "string" || (o[k] as string).length > 200 || /[\r\n\0]/.test(o[k] as string)) err.add(k, "must be a short line of text");
		else filter[k] = o[k] as string;
	}
	for (const k of ["since", "before"] as const) {
		if (o[k] === undefined || o[k] === null || o[k] === "") continue;
		const d = o[k] instanceof Date ? (o[k] as Date) : typeof o[k] === "string" && /^\d{4}-\d{2}-\d{2}/.test(o[k] as string) ? new Date(`${(o[k] as string).slice(0, 10)}T00:00:00Z`) : null;
		if (!d || Number.isNaN(d.getTime())) err.add(k, "must be a date (YYYY-MM-DD)");
		else filter[k] = d;
	}
	if (o.max !== undefined && (!Number.isFinite(o.max) || (o.max as number) < 1)) err.add("max", "must be a positive number");
	err.throwIfAny();
	return { filter, max: Math.min(Math.max(Math.trunc((o.max as number | undefined) ?? 25), 1), 100) };
}

/** The same search in Gmail's own words. */
function gmailQuery(f: ImapSearch): string {
	const q = (s: string) => `"${s.replace(/"/g, " ")}"`;
	const day = (d: Date) => `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
	return [f.from && `from:${q(f.from)}`, f.to && `to:${q(f.to)}`, f.subject && `subject:${q(f.subject)}`, f.text && q(f.text), f.since && `after:${day(new Date(f.since.getTime() - 86_400_000))}`, f.before && `before:${day(f.before)}`]
		.filter(Boolean)
		.join(" ");
}

/** What a module can do with mail: everything is checked against Settings → Mail (or Settings → Gmail). */
export function mailFor(app: App, moduleId: string) {
	const gmail = gmailFor(app, moduleId);
	/** The mailbox in use: this account when it is set up, else Gmail. */
	const which = async () => {
		const c = await readMailConfig(app.integrations.dir);
		return canRead(c) || canSend(c) ? { kind: "imap" as const, c } : { kind: "gmail" as const, c };
	};
	const allowed = (c: MailConfig, need: "read" | "send") => {
		if (!(need === "read" ? canRead(c) : canSend(c))) {
			throw new MailError(need === "read" ? "the mailbox isn't set up for reading; an admin can finish it under Settings → Mail" : "the mailbox isn't set up for sending; an admin can finish it under Settings → Mail", 409);
		}
		if (!(need === "read" ? c.allow_read : c.allow_send).includes(moduleId)) {
			throw new MailError(`this module isn't allowed to ${need} mail; an admin can allow it under Settings → Mail`, 403);
		}
	};
	const parseId = (id: unknown): { validity: number; uid: number } => {
		const m = typeof id === "string" ? /^(\d{1,12})\.(\d{1,12})$/.exec(id) : null;
		if (!m) throw new MailError("invalid message id", 422);
		return { validity: Number(m[1]), uid: Number(m[2]) };
	};
	const fetchRaw = (c: MailConfig, id: string) =>
		withImap(c, async (imap, box) => {
			const { validity, uid } = parseId(id);
			// The server renumbered the folder: old ids no longer point at the same messages.
			if (validity !== box.uidvalidity) throw new MailError("that message is no longer there (the mailbox was rebuilt); search again", 404);
			const size = await imap.size(uid);
			if (size === null) throw new MailError("no such message", 404);
			if (size > MAX_MESSAGE_BYTES) throw new MailError("that message is too large to read here", 413);
			const raw = await imap.fetch(uid);
			if (!raw) throw new MailError("no such message", 404);
			return raw;
		});

	return {
		/** { connected, kind, account, canRead, canSend } for this module, whichever mailbox is in use. */
		async status() {
			const w = await which();
			if (w.kind === "gmail") {
				const g = await gmail.status();
				return { connected: g.connected, kind: g.connected ? ("gmail" as const) : null, account: g.account, canRead: g.canRead, canSend: g.canSend };
			}
			return { connected: true, kind: "imap" as const, account: w.c.account || w.c.username, canRead: canRead(w.c) && w.c.allow_read.includes(moduleId), canSend: canSend(w.c) && w.c.allow_send.includes(moduleId) };
		},

		/** Messages that match, newest first: { from, to, subject, text, since, before, max }. */
		async search(query: MailSearch = {}): Promise<{ messages: MailSummary[] }> {
			const { filter, max } = checkSearch(query);
			const w = await which();
			if (w.kind === "gmail") {
				const r = await gmail.search(gmailQuery(filter), { max });
				return { messages: r.messages.map((m) => ({ id: m.id, date: m.date, from: m.from, to: m.to, subject: m.subject, snippet: m.snippet })) };
			}
			allowed(w.c, "read");
			return withImap(w.c, async (imap, box) => {
				const uids = (await imap.search(filter)).slice(-max);
				const messages = (await imap.headers(uids)).map((m) => {
					const h = parseHeaders(m.headers.toString("latin1"));
					const one = (name: string) => decodeWords(h.get(name)?.[0] ?? "");
					const sent = new Date(h.get("date")?.[0] ?? "");
					const date = m.received ?? (Number.isNaN(sent.getTime()) ? null : sent);
					return { uid: m.uid, id: `${box.uidvalidity}.${m.uid}`, date: date ? date.toISOString() : "", from: one("from"), to: one("to"), subject: one("subject"), snippet: "" };
				});
				return { messages: messages.sort((a, b) => b.uid - a.uid).map(({ uid: _uid, ...m }) => m) };
			});
		},

		/** One message: headers, text and HTML bodies, and its attachments (fetch them with attachment()). */
		async message(id: string): Promise<MailDetail> {
			const w = await which();
			if (w.kind === "gmail") {
				const m = await gmail.message(id);
				return { id: m.id, date: m.date, from: m.from, to: m.to, cc: m.cc, subject: m.subject, snippet: m.snippet, text: m.text, html: m.html, attachments: m.attachments };
			}
			allowed(w.c, "read");
			const p = parseEmail(await fetchRaw(w.c, id));
			return {
				id,
				date: p.date ? p.date.toISOString() : "",
				from: p.from,
				to: p.to,
				cc: p.cc,
				subject: p.subject,
				snippet: p.text.replace(/\s+/g, " ").slice(0, 200),
				text: p.text,
				html: p.html,
				attachments: p.attachments.map((a, i) => ({ attachmentId: String(i), filename: a.filename, mimeType: a.contentType, size: a.data.length })),
			};
		},

		/** The whole message as RFC 822 source (a Buffer). */
		async raw(id: string): Promise<Buffer> {
			const w = await which();
			if (w.kind === "gmail") return gmail.raw(id);
			allowed(w.c, "read");
			return fetchRaw(w.c, id);
		},

		/** An attachment's bytes (a Buffer). */
		async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
			const w = await which();
			if (w.kind === "gmail") return gmail.attachment(messageId, attachmentId);
			allowed(w.c, "read");
			if (typeof attachmentId !== "string" || !/^\d{1,4}$/.test(attachmentId)) throw new MailError("invalid attachment id", 422);
			const a = parseEmail(await fetchRaw(w.c, messageId)).attachments[Number(attachmentId)];
			if (!a) throw new MailError("no such attachment", 404);
			return a.data;
		},

		/** Sends an email from the mailbox. Returns the message's id. */
		async send(mail: SendMail): Promise<{ id: string }> {
			const w = await which();
			if (w.kind === "gmail") return { id: (await gmail.send(mail)).id };
			const c = w.c;
			const messageId = `${randomBytes(16).toString("hex")}@${c.account.split("@")[1] || "ledger.localhost"}`;
			const from = c.from_name ? `${/^[\x20-\x7e]*$/.test(c.from_name) ? `"${c.from_name}"` : `=?UTF-8?B?${Buffer.from(c.from_name).toString("base64")}?=`} <${c.account}>` : c.account;
			// Validates every address before anything is checked against the server.
			const message = buildMime(mail, { from, date: new Date(), messageId, omitBcc: true });
			allowed(c, "send");
			const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim());
			try {
				await smtpSend(smtpServer(c), c.username, c.password, c.account, [...list(mail.to), ...list(mail.cc), ...list(mail.bcc)], message);
			} catch (e) {
				asMailError(e);
			}
			return { id: messageId };
		},
	};
}
