// Fake AI providers (Anthropic, Ollama, OpenAI-compatible) and a fake Google
// OAuth + Gmail API, for the integration tests.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

const readBody = (req: IncomingMessage) =>
	new Promise<Buffer>((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
const json = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(v));
};

async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void): Promise<string> {
	const server = createServer(async (req, res) => handler(req, res, await readBody(req)));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => new Promise((r) => server.close(r)));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface FakeAi {
	base: string;
	requests: { path: string; headers: IncomingMessage["headers"]; body: any }[];
}

/** Answers "OK" to plain prompts and {"answer": <last prompt>} when asked for JSON. */
export async function fakeAi(t: TestContext): Promise<FakeAi> {
	const ai: FakeAi = { base: "", requests: [] };
	ai.base = await listen(t, (req, res, raw) => {
		const body = JSON.parse(raw.toString() || "{}");
		ai.requests.push({ path: req.url ?? "", headers: req.headers, body });
		const last = body.messages?.at(-1)?.content;
		const prompt = typeof last === "string" ? last : (last?.find?.((b: any) => b.type === "text")?.text ?? "");
		const wantsJson = !!(body.output_config?.format || body.format || body.response_format);
		const answer = wantsJson ? JSON.stringify({ answer: prompt }) : "OK";
		if (req.url === "/v1/messages") {
			if (req.headers["x-api-key"] !== "sk-test") return json(res, 401, { error: { message: "invalid x-api-key" } });
			return json(res, 200, { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: answer }], usage: { input_tokens: 12, output_tokens: 3 } });
		}
		if (req.url === "/api/chat") return json(res, 200, { model: body.model, message: { role: "assistant", content: answer }, prompt_eval_count: 7, eval_count: 2 });
		if (req.url?.startsWith("/v1/models")) return json(res, 200, { data: [{ id: "models/model-b" }, { id: "model-a" }] });
		if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "qwen2.5vl:7b" }] });
		// A server that knows neither max_tokens nor JSON schemas.
		if (req.url === "/picky/v1/chat/completions") {
			if (body.max_tokens !== undefined) return json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } });
			if (body.response_format?.type === "json_schema") return json(res, 400, { error: { message: "response_format.type must be text or json_object" } });
			return json(res, 200, { model: body.model, choices: [{ finish_reason: body.max_completion_tokens < 5 ? "length" : "stop", message: { content: answer } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
		}
		if (req.url === "/v1/chat/completions") return json(res, 200, { model: body.model, choices: [{ message: { content: answer } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
		json(res, 404, { error: "not found" });
	});
	return ai;
}

export interface FakeGmail {
	base: string;
	/** Messages in the mailbox: id → RFC 822 parts we hand back. */
	sent: string[];
	revoked: string[];
	lastChallenge: string;
	/** Whether the user leaves "send" ticked on Google's page. */
	grantSend: boolean;
}

export async function fakeGmail(t: TestContext): Promise<FakeGmail> {
	const g: FakeGmail = { base: "", sent: [], revoked: [], lastChallenge: "", grantSend: true };
	const b64 = (s: string) => Buffer.from(s).toString("base64url");
	g.base = await listen(t, (req, res, raw) => {
		const url = new URL(req.url ?? "/", "http://x");
		const form = new URLSearchParams(raw.toString());
		if (url.pathname === "/o/oauth2/v2/auth") return json(res, 200, {});
		if (req.method === "POST" && url.pathname === "/token") {
			if (form.get("client_secret") !== "gsecret") return json(res, 401, { error: "invalid_client" });
			if (form.get("grant_type") === "authorization_code") {
				// PKCE: the verifier must hash to the challenge sent to the consent page.
				const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
				if (form.get("code") !== "good-code" || challenge !== g.lastChallenge || form.get("redirect_uri") !== "http://127.0.0.1") {
					return json(res, 400, { error: "invalid_grant", error_description: "Bad code" });
				}
				const scope = ["https://www.googleapis.com/auth/gmail.readonly", ...(g.grantSend ? ["https://www.googleapis.com/auth/gmail.send"] : [])].join(" ");
				return json(res, 200, { access_token: "acc", refresh_token: "ref-1", expires_in: 3600, scope });
			}
			if (form.get("refresh_token") === "ref-1") return json(res, 200, { access_token: "acc", expires_in: 3600 });
			return json(res, 400, { error: "invalid_grant" });
		}
		if (req.method === "POST" && url.pathname === "/revoke") {
			g.revoked.push(form.get("token") ?? "");
			return json(res, 200, {});
		}
		if (req.headers.authorization !== "Bearer acc") return json(res, 401, { error: { message: "Invalid Credentials" } });
		const p = url.pathname;
		if (p === "/gmail/v1/users/me/profile") return json(res, 200, { emailAddress: "me@example.com", messagesTotal: 2 });
		if (p === "/gmail/v1/users/me/messages" && req.method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			return json(res, 200, q.includes("bill") ? { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], nextPageToken: "p2" } : {});
		}
		let m = /^\/gmail\/v1\/users\/me\/messages\/(m\d)$/.exec(p);
		if (m) {
			const id = m[1]!;
			const headers = [
				{ name: "From", value: "Hydro <bills@hydro.example>" },
				{ name: "To", value: "me@example.com" },
				{ name: "Subject", value: `Your bill ${id}` },
			];
			const fmt = url.searchParams.get("format");
			if (fmt === "raw") return json(res, 200, { id, raw: b64(`Subject: Your bill ${id}\r\n\r\nAmount due: $42.00\r\n`) });
			const payload =
				fmt === "metadata"
					? { headers }
					: {
							mimeType: "multipart/mixed",
							headers,
							parts: [
								{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Amount due: $42.00") } }, { mimeType: "text/html", body: { data: b64("<p>Amount due</p>") } }] },
								{ mimeType: "application/pdf", filename: "bill.pdf", body: { attachmentId: "att1", size: 4 } },
							],
						};
			return json(res, 200, { id, threadId: `t${id.slice(1)}`, internalDate: "1793000000000", snippet: "Amount due", labelIds: ["INBOX"], payload });
		}
		m = /^\/gmail\/v1\/users\/me\/messages\/(m\d)\/attachments\/att1$/.exec(p);
		if (m) return json(res, 200, { data: Buffer.from("%PDF").toString("base64url"), size: 4 });
		if (p === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
			g.sent.push(Buffer.from(JSON.parse(raw.toString()).raw, "base64url").toString());
			return json(res, 200, { id: "sent1", threadId: "st1" });
		}
		json(res, 404, { error: { message: "not found" } });
	});
	return g;
}

export interface FakeMail {
	imapPort: number;
	smtpPort: number;
	/** Every IMAP command line received. */
	imapLog: string[];
	/** Messages handed to the SMTP server. */
	sent: { from: string; to: string[]; data: string }[];
}

/** A tiny IMAP server (one folder, messages by UID) and SMTP server, both without TLS. */
export async function fakeMail(t: TestContext, messages: Map<number, Buffer>, user = "me@proton.me", pass = "bridge-pass"): Promise<FakeMail> {
	const m: FakeMail = { imapPort: 0, smtpPort: 0, imapLog: [], sent: [] };
	const quoted = (s: string) => `"${s}"`;
	// Enough of quoted-printable to search encoded names.
	const decodeQ = (x: string) => x.replace(/((?:=[0-9A-F]{2})+)/g, (h) => Buffer.from(h.replace(/=/g, ""), "hex").toString("utf8"));
	const imap = net.createServer((sock) => {
		sock.write("* OK fake IMAP ready\r\n");
		let buf = Buffer.alloc(0);
		let pending: { head: string; need: number } | null = null;
		const run = (line: string) => {
			m.imapLog.push(line);
			const [tag, cmd, ...rest] = line.split(" ");
			const args = rest.join(" ");
			const C = (cmd ?? "").toUpperCase();
			if (C === "LOGIN") sock.write(args === `${quoted(user)} ${quoted(pass)}` ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
			else if (C === "EXAMINE") sock.write(args === quoted("INBOX") ? `* ${messages.size} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [READ-ONLY] done\r\n` : `${tag} NO no such mailbox\r\n`);
			else if (C === "UID" && rest[0] === "SEARCH") {
				const f = /FROM (?:"([^"]*)"|(\S+))/.exec(args);
				const from = f?.[1] ?? f?.[2];
				const hits = [...messages.entries()].filter(([, raw]) => !from || decodeQ(raw.toString("utf8")).toLowerCase().includes(from.toLowerCase())).map(([uid]) => uid);
				sock.write(`* SEARCH ${hits.join(" ")}\r\n${tag} OK done\r\n`);
			} else if (C === "UID" && rest[0] === "FETCH") {
				const uids = (rest[1] ?? "").split(",").map(Number);
				for (const uid of uids) {
					const raw = messages.get(uid);
					if (!raw) continue;
					if (args.includes("HEADER.FIELDS")) {
						const head = Buffer.from(raw.toString("latin1").split("\r\n\r\n")[0] + "\r\n\r\n", "latin1");
						sock.write(`* ${uid} FETCH (UID ${uid} INTERNALDATE "03-Mar-2026 15:00:00 +0000" RFC822.SIZE ${raw.length} BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE)] {${head.length}}\r\n`);
						sock.write(head);
						sock.write(")\r\n");
					} else if (args.includes("BODY.PEEK[]")) {
						sock.write(`* ${uid} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`);
						sock.write(raw);
						sock.write(")\r\n");
					} else sock.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${raw.length})\r\n`);
				}
				sock.write(`${tag} OK done\r\n`);
			} else if (C === "LOGOUT") {
				sock.write(`* BYE\r\n${tag} OK bye\r\n`);
				sock.end();
			} else sock.write(`${tag} BAD unknown\r\n`);
		};
		sock.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				if (pending && pending.need > 0) {
					// A literal: its bytes, then the rest of the command line.
					const need = pending.need;
					if (buf.length < need) return;
					pending = { head: pending.head + buf.subarray(0, need).toString("utf8"), need: 0 };
					buf = buf.subarray(need);
				}
				const i = buf.indexOf("\r\n");
				if (i < 0) return;
				const line = (pending?.head ?? "") + buf.subarray(0, i).toString("utf8");
				buf = buf.subarray(i + 2);
				pending = null;
				const lit = /\{(\d+)\}$/.exec(line);
				if (lit) {
					pending = { head: line.slice(0, lit.index), need: Number(lit[1]) };
					sock.write("+ go ahead\r\n");
				} else run(line);
			}
		});
	});
	const smtp = net.createServer((sock) => {
		sock.write("220 fake SMTP\r\n");
		let buf = "";
		let cur = { from: "", to: [] as string[], data: "" };
		let inData = false;
		let authed = false;
		sock.on("data", (d) => {
			buf += d.toString("latin1");
			for (;;) {
				if (inData) {
					const end = buf.indexOf("\r\n.\r\n");
					if (end < 0) return;
					cur.data = buf.slice(0, end).replace(/^\.\./gm, ".");
					buf = buf.slice(end + 5);
					inData = false;
					m.sent.push(cur);
					cur = { from: "", to: [], data: "" };
					sock.write("250 queued\r\n");
					continue;
				}
				const i = buf.indexOf("\r\n");
				if (i < 0) return;
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const C = line.toUpperCase();
				if (C.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
				else if (C.startsWith("AUTH PLAIN")) {
					authed = Buffer.from(line.slice(11), "base64").toString() === `\0${user}\0${pass}`;
					sock.write(authed ? "235 ok\r\n" : "535 5.7.8 bad username or password\r\n");
				} else if (C.startsWith("MAIL FROM:")) {
					if (!authed) sock.write("530 sign in first\r\n");
					else {
						cur.from = line.slice(10).replace(/[<>]/g, "");
						sock.write("250 ok\r\n");
					}
				} else if (C.startsWith("RCPT TO:")) {
					const to = line.slice(8).replace(/[<>]/g, "");
					if (to.startsWith("nobody@")) sock.write("550 no such user\r\n");
					else {
						cur.to.push(to);
						sock.write("250 ok\r\n");
					}
				} else if (C === "DATA") {
					inData = true;
					sock.write("354 go ahead\r\n");
				} else if (C === "QUIT") {
					sock.write("221 bye\r\n");
					sock.end();
				} else sock.write("500 unknown\r\n");
			}
		});
	});
	for (const [server, key] of [[imap, "imapPort"], [smtp, "smtpPort"]] as const) {
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		m[key] = (server.address() as AddressInfo).port;
		t.after(() => new Promise((r) => server.close(() => r(undefined))));
	}
	return m;
}
