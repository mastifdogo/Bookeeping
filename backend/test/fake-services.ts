// Fake AI providers (Anthropic, Ollama, OpenAI-compatible) and a fake Google
// OAuth + Gmail API, for the integration tests.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
