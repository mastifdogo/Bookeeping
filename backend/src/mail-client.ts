// Minimal IMAP4rev1 (read-only) and SMTP (submission) clients over node:net
// and node:tls, with no dependencies. Enough for mail.ts: log in, open a
// folder read-only (EXAMINE, so nothing is marked as read), search, fetch
// headers or whole messages, and hand a finished message to an SMTP server.
//
// Works with ordinary mail hosts over TLS (993 / 465) or STARTTLS (143 / 587)
// and with Proton Mail Bridge, which offers STARTTLS on local ports with a
// certificate of its own (trustCertificate).

import net from "node:net";
import tls from "node:tls";

export class MailError extends Error {}

export type Security = "tls" | "starttls" | "none";

export interface ServerOptions {
	host: string;
	port: number;
	security: Security;
	/** Accept a certificate no authority signed (Proton Mail Bridge makes its own). */
	trustCertificate?: boolean;
	timeoutMs?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIMEOUT_MS = 60_000;

function open(o: ServerOptions): net.Socket {
	const s = o.security === "tls" ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: !o.trustCertificate }) : net.connect({ host: o.host, port: o.port });
	const ms = o.timeoutMs ?? TIMEOUT_MS;
	s.setTimeout(ms, () => s.destroy(new Error(`no response from ${o.host} within ${ms / 1000} s`)));
	return s;
}

/** Turns a plain connection into a TLS one (after STARTTLS was accepted). */
function upgrade(sock: net.Socket, o: ServerOptions): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		sock.removeAllListeners("data");
		const t = tls.connect({ socket: sock, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: !o.trustCertificate }, () => resolve(t));
		t.once("error", (e) => reject(new MailError(`could not secure the connection to ${o.host}: ${e.message}`)));
	});
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

/** IMAP quoted string. */
export function quote(s: string): string {
	s = String(s);
	if (/[\r\n\0]/.test(s)) throw new MailError("value contains a line break");
	return `"${s.replace(/["\\]/g, (c) => "\\" + c)}"`;
}

/** A search value: quoted when plain ASCII, else sent as a literal. */
const arg = (s: string): string | Buffer => (/^[\x20-\x7e]*$/.test(s) ? quote(s) : Buffer.from(s, "utf8"));

interface Line {
	text: string;
	literals: Buffer[];
}

export interface ImapSearch {
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	since?: Date;
	before?: Date;
}

export interface ImapHeader {
	uid: number;
	/** When the server received it. */
	received: Date | null;
	size: number;
	headers: Buffer;
}

const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

export class ImapClient {
	private o: ServerOptions;
	private socket!: net.Socket;
	private chunks: Buffer[] = [];
	private total = 0;
	/** Bytes required before the pending literal can be parsed. */
	private need = 0;
	private tag = 0;
	private waiter: { onLine: (r: Line) => void; reject: (e: Error) => void } | null = null;
	private closed = false;

	constructor(o: ServerOptions) {
		this.o = o;
	}

	private bind(sock: net.Socket) {
		this.socket = sock;
		sock.on("data", (d: Buffer) => this.onData(d));
		sock.on("close", () => {
			this.closed = true;
			this.waiter?.reject(new MailError("the mail server closed the connection"));
		});
		sock.on("error", (err) => this.waiter?.reject(new MailError(err.message)));
	}

	async connect(): Promise<void> {
		const { host, port } = this.o;
		await new Promise<void>((resolve, reject) => {
			const onConnectError = (err: Error) => reject(new MailError(`could not connect to ${host}:${port}: ${err.message}`));
			const sock = open(this.o);
			sock.once("error", onConnectError);
			this.bind(sock);
			this.waiter = {
				onLine: (r) => {
					this.waiter = null;
					sock.off("error", onConnectError);
					if (/^\* (OK|PREAUTH)/i.test(r.text)) resolve();
					else reject(new MailError(`unexpected greeting: ${r.text.slice(0, 200)}`));
				},
				reject,
			};
		});
		if (this.o.security === "starttls") {
			await this.command(["STARTTLS"]).catch((e: Error) => {
				throw new MailError(`${host} did not accept STARTTLS: ${e.message}`);
			});
			const plain = this.socket;
			plain.removeAllListeners("close");
			plain.removeAllListeners("error");
			plain.on("error", () => undefined);
			this.chunks = [];
			this.total = 0;
			this.bind(await upgrade(plain, this.o));
		}
	}

	private onData(d: Buffer) {
		this.chunks.push(d);
		this.total += d.length;
		if (this.total < this.need) return;
		this.pump();
	}

	/** Reads one response line, with any {n} literals it contains, or null if more data is needed. */
	private readLine(): Line | null {
		if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
		const buf = this.chunks[0];
		if (!buf) return null;
		let pos = 0;
		let text = "";
		const literals: Buffer[] = [];
		for (;;) {
			const eol = buf.indexOf("\r\n", pos);
			if (eol < 0) return null;
			const seg = buf.toString("utf8", pos, eol);
			const m = /\{(\d+)\+?\}$/.exec(seg);
			if (!m) {
				text += seg;
				pos = eol + 2;
				break;
			}
			const start = eol + 2;
			const end = start + Number(m[1]);
			if (buf.length < end) {
				this.need = end;
				return null;
			}
			literals.push(Buffer.from(buf.subarray(start, end)));
			text += seg.slice(0, m.index) + `{literal${literals.length - 1}}`;
			pos = end;
		}
		this.need = 0;
		const rest = buf.subarray(pos);
		this.chunks = rest.length > 0 ? [rest] : [];
		this.total = rest.length;
		return { text, literals };
	}

	private pump() {
		while (this.waiter) {
			const r = this.readLine();
			if (!r) return;
			this.waiter.onLine(r);
		}
	}

	/**
	 * Sends a command and collects its untagged responses; throws on NO/BAD.
	 * Buffers among the parts are sent as literals (for text that isn't ASCII).
	 */
	command(parts: (string | Buffer)[]): Promise<{ untagged: Line[]; text: string }> {
		if (this.closed) return Promise.reject(new MailError("not connected"));
		const tag = `A${++this.tag}`;
		// Split into what is written at once: up to each literal's {n}, then its bytes.
		const writes: Buffer[] = [];
		let cur = `${tag}`;
		for (const p of parts) {
			if (typeof p === "string") cur += ` ${p}`;
			else {
				writes.push(Buffer.from(`${cur} {${p.length}}\r\n`));
				writes.push(p);
				cur = "";
			}
		}
		const tail = Buffer.from(`${cur}\r\n`);
		// writes = [head0, lit0, head1, lit1, ...]; each literal is followed by the next head (or the tail).
		const queue: Buffer[] = [];
		for (let i = 0; i < writes.length; i += 2) queue.push(writes[i]!);
		const literals = writes.filter((_, i) => i % 2 === 1);
		return new Promise((resolve, reject) => {
			const untagged: Line[] = [];
			let sent = 0;
			this.waiter = {
				onLine: (r) => {
					if (r.text.startsWith(tag + " ")) {
						this.waiter = null;
						const m = /^\S+ (OK|NO|BAD)\s?(.*)$/i.exec(r.text);
						if (m && m[1]!.toUpperCase() === "OK") resolve({ untagged, text: m[2] ?? "" });
						else reject(new MailError(m ? m[2] || m[1]! : r.text));
					} else if (r.text.startsWith("+")) {
						// The server is ready for the literal: send it, then what follows it.
						if (sent < literals.length) {
							const next = sent + 1 < queue.length ? queue[sent + 1]! : tail;
							this.socket.write(Buffer.concat([literals[sent]!, next]));
							sent++;
						}
					} else untagged.push(r);
				},
				reject,
			};
			this.socket.write(queue.length > 0 ? queue[0]! : tail);
			this.pump();
		});
	}

	async login(user: string, password: string): Promise<void> {
		await this.command(["LOGIN", arg(user), arg(password)]).catch((err: Error) => {
			throw new MailError(`the mail server refused the login: ${err.message}`);
		});
	}

	/** Opens a folder read-only; returns { uidvalidity, exists }. */
	async examine(folder: string): Promise<{ uidvalidity: number; exists: number }> {
		const r = await this.command(["EXAMINE", arg(folder)]).catch((err: Error) => {
			throw new MailError(`could not open the folder ${JSON.stringify(folder)}: ${err.message}`);
		});
		let uidvalidity: number | null = null;
		let exists = 0;
		for (const u of [...r.untagged, { text: r.text, literals: [] }]) {
			const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
			if (v) uidvalidity = Number(v[1]);
			const e = /^\* (\d+) EXISTS/i.exec(u.text);
			if (e) exists = Number(e[1]);
		}
		if (uidvalidity === null) throw new MailError("the mail server did not report UIDVALIDITY");
		return { uidvalidity, exists };
	}

	/** UIDs of the messages that match, oldest first. */
	async search(q: ImapSearch): Promise<number[]> {
		const parts: (string | Buffer)[] = [];
		const text = [q.from, q.to, q.subject, q.text].filter((x): x is string => typeof x === "string" && x !== "");
		const utf8 = text.some((t) => !/^[\x20-\x7e]*$/.test(t));
		if (q.from) parts.push("FROM", arg(q.from));
		if (q.to) parts.push("TO", arg(q.to));
		if (q.subject) parts.push("SUBJECT", arg(q.subject));
		if (q.text) parts.push("TEXT", arg(q.text));
		if (q.since) parts.push(`SINCE ${imapDate(q.since)}`);
		if (q.before) parts.push(`BEFORE ${imapDate(q.before)}`);
		if (parts.length === 0) parts.push("ALL");
		const r = await this.command(["UID SEARCH", ...(utf8 ? ["CHARSET UTF-8"] : []), ...parts]);
		const uids: number[] = [];
		for (const u of r.untagged) {
			const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
			if (m) uids.push(...m[1]!.trim().split(/\s+/).filter(Boolean).map(Number));
		}
		return uids.filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
	}

	/** From, To, Cc, Subject and Date of each message, without setting \Seen. */
	async headers(uids: number[]): Promise<ImapHeader[]> {
		if (uids.length === 0) return [];
		const r = await this.command([`UID FETCH ${uids.map(Number).join(",")} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE)])`]);
		const out: ImapHeader[] = [];
		for (const u of r.untagged) {
			const uid = /\bUID (\d+)/i.exec(u.text);
			if (!/FETCH/i.test(u.text) || !uid || u.literals.length === 0) continue;
			const when = /INTERNALDATE "([^"]+)"/i.exec(u.text);
			const d = when ? new Date(when[1]!.replace(/^(\s?\d+)-(\w+)-(\d+)/, "$1 $2 $3")) : null;
			out.push({ uid: Number(uid[1]), received: d && !Number.isNaN(d.getTime()) ? d : null, size: Number(/RFC822\.SIZE (\d+)/i.exec(u.text)?.[1] ?? 0), headers: u.literals[0]! });
		}
		return out;
	}

	async size(uid: number): Promise<number | null> {
		const r = await this.command([`UID FETCH ${Number(uid)} (RFC822.SIZE)`]);
		for (const u of r.untagged) {
			const m = /RFC822\.SIZE (\d+)/i.exec(u.text);
			if (m) return Number(m[1]);
		}
		return null;
	}

	/** The raw message, without setting \Seen. */
	async fetch(uid: number): Promise<Buffer | null> {
		const r = await this.command([`UID FETCH ${Number(uid)} (BODY.PEEK[])`]);
		for (const u of r.untagged) if (/FETCH/i.test(u.text) && u.literals.length > 0) return u.literals[0]!;
		return null;
	}

	async logout(): Promise<void> {
		if (this.closed) return;
		await this.command(["LOGOUT"]).catch(() => undefined);
		this.socket.end();
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
	}
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

class SmtpSession {
	private o: ServerOptions;
	private socket!: net.Socket;
	private buf = "";
	private waiter: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void } | null = null;
	private failed: Error | null = null;

	constructor(o: ServerOptions) {
		this.o = o;
	}

	private bind(sock: net.Socket) {
		this.socket = sock;
		this.buf = "";
		sock.on("data", (d: Buffer) => {
			this.buf += d.toString("latin1");
			this.pump();
		});
		const fail = (e: Error) => {
			this.failed = e;
			this.waiter?.reject(e);
			this.waiter = null;
		};
		sock.on("error", (e) => fail(new MailError(`${this.o.host}:${this.o.port}: ${e.message}`)));
		sock.on("close", () => fail(new MailError("the mail server closed the connection")));
	}

	/** A whole reply: lines "250-..." up to the last "250 ...". */
	private pump() {
		if (!this.waiter) return;
		const lines = this.buf.split("\r\n");
		for (let i = 0; i < lines.length - 1; i++) {
			if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
				const reply = lines.slice(0, i + 1);
				this.buf = lines.slice(i + 1).join("\r\n");
				const w = this.waiter;
				this.waiter = null;
				w.resolve({ code: Number(reply[i]!.slice(0, 3)), text: reply.map((l) => l.slice(4)).join(" ") });
				return;
			}
		}
	}

	private reply(): Promise<{ code: number; text: string }> {
		if (this.failed) return Promise.reject(this.failed);
		return new Promise((resolve, reject) => {
			this.waiter = { resolve, reject };
			this.pump();
		});
	}

	/** Sends a line and expects a reply code; `what` names the step in the error. */
	async cmd(line: string | Buffer, expect: number[], what: string): Promise<{ code: number; text: string }> {
		this.socket.write(typeof line === "string" ? `${line}\r\n` : line);
		const r = await this.reply();
		if (!expect.includes(r.code)) throw new MailError(`${what}: the mail server answered ${r.code} ${r.text.slice(0, 300)}`);
		return r;
	}

	async start(user: string, password: string): Promise<void> {
		const { host, port } = this.o;
		const sock = open(this.o);
		this.bind(sock);
		const hello = await this.reply().catch((e: Error) => {
			throw new MailError(`could not connect to ${host}:${port}: ${e.message.replace(`${host}:${port}: `, "")}`);
		});
		if (hello.code !== 220) throw new MailError(`unexpected greeting from ${host}: ${hello.code} ${hello.text.slice(0, 200)}`);
		let ehlo = await this.cmd("EHLO ledger.localhost", [250], "hello");
		if (this.o.security === "starttls") {
			await this.cmd("STARTTLS", [220], "STARTTLS");
			sock.removeAllListeners("close");
			sock.removeAllListeners("error");
			sock.on("error", () => undefined);
			this.bind(await upgrade(sock, this.o));
			ehlo = await this.cmd("EHLO ledger.localhost", [250], "hello");
		}
		if (user === "") return;
		const login = /\bAUTH\b[^\r\n]*\bLOGIN\b/i.test(ehlo.text) && !/\bAUTH\b[^\r\n]*\bPLAIN\b/i.test(ehlo.text);
		const refused = (e: Error) => {
			throw new MailError(`the mail server refused the login: ${e.message.replace(/^login: the mail server answered /, "")}`);
		};
		if (login) {
			await this.cmd("AUTH LOGIN", [334], "login").catch(refused);
			await this.cmd(Buffer.from(user).toString("base64"), [334], "login").catch(refused);
			await this.cmd(Buffer.from(password).toString("base64"), [235], "login").catch(refused);
		} else {
			await this.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`, [235], "login").catch(refused);
		}
	}

	async quit(): Promise<void> {
		if (!this.failed) await this.cmd("QUIT", [221], "quit").catch(() => undefined);
		this.socket?.destroy();
	}

	close(): void {
		this.socket?.destroy();
	}
}

const bare = (address: string) => /<([^<>]+)>\s*$/.exec(address)?.[1] ?? address.trim();

/** Logs in to the SMTP server and leaves again (to check the settings). */
export async function smtpCheck(o: ServerOptions, user: string, password: string): Promise<void> {
	const s = new SmtpSession(o);
	try {
		await s.start(user, password);
		await s.quit();
	} finally {
		s.close();
	}
}

/** Hands a finished RFC 5322 message to the SMTP server for the recipients. */
export async function smtpSend(o: ServerOptions, user: string, password: string, from: string, recipients: string[], message: Buffer): Promise<void> {
	if (/[\r\n<>\s]/.test(bare(from)) || recipients.some((r) => /[\r\n<>\s]/.test(bare(r)))) throw new MailError("an address is not valid");
	const s = new SmtpSession(o);
	try {
		await s.start(user, password);
		await s.cmd(`MAIL FROM:<${bare(from)}>`, [250], "sender");
		for (const r of recipients) await s.cmd(`RCPT TO:<${bare(r)}>`, [250, 251], `recipient ${bare(r)}`);
		await s.cmd("DATA", [354], "message");
		// Lines are CRLF, and a line starting with a dot gets a second one.
		const body = message
			.toString("latin1")
			.replace(/\r?\n/g, "\r\n")
			.replace(/^\./gm, "..");
		await s.cmd(Buffer.from(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`, "latin1"), [250], "message");
		await s.quit();
	} finally {
		s.close();
	}
}
