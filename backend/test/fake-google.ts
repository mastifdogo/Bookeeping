// A fake Google OAuth + Drive API: the device flow, resumable uploads and a
// folder listing, enough for the backup code.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export interface FakeGoogle {
	oauth: string;
	api: string;
	files: { id: string; name: string; parents: string[]; size: number }[];
	/** Device-flow polls answered "pending" before approval. */
	pendingPolls: number;
	denied: boolean;
	revoked: string[];
	/** Make refresh-token grants fail with invalid_grant. */
	revokedGrant: boolean;
}

const body = (req: IncomingMessage) =>
	new Promise<Buffer>((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});

export async function fakeGoogle(t: TestContext): Promise<FakeGoogle> {
	let n = 0;
	const sessions = new Map<string, { name: string; parents: string[] }>();
	const g: FakeGoogle = { oauth: "", api: "", files: [], pendingPolls: 1, denied: false, revoked: [], revokedGrant: false };
	const json = (res: import("node:http").ServerResponse, status: number, v: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(v));
	};
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const raw = await body(req);
		const form = new URLSearchParams(raw.toString());
		const authed = req.headers.authorization === "Bearer access-1";
		if (req.method === "POST" && url.pathname === "/device/code") {
			if (form.get("client_id") !== "123-abc.apps.googleusercontent.com") return json(res, 401, { error: "invalid_client" });
			return json(res, 200, { device_code: "dev-1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 });
		}
		if (req.method === "POST" && url.pathname === "/token") {
			if (form.get("client_secret") !== "secret-1") return json(res, 401, { error: "invalid_client" });
			if (form.get("grant_type") === "refresh_token") {
				if (g.revokedGrant || form.get("refresh_token") !== "refresh-1") return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
				return json(res, 200, { access_token: "access-1", expires_in: 3600 });
			}
			if (g.denied) return json(res, 428, { error: "access_denied" });
			if (g.pendingPolls-- > 0) return json(res, 428, { error: "authorization_pending" });
			return json(res, 200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
		}
		if (req.method === "POST" && url.pathname === "/revoke") {
			g.revoked.push(form.get("token") ?? "");
			return json(res, 200, {});
		}
		if (!authed) return json(res, 401, { error: { message: "Invalid Credentials" } });
		if (req.method === "POST" && url.pathname === "/drive/v3/files") {
			const meta = JSON.parse(raw.toString());
			return json(res, 200, { id: `folder-${++n}`, name: meta.name });
		}
		if (req.method === "GET" && url.pathname === "/drive/v3/about") return json(res, 200, { user: { emailAddress: "me@example.com" } });
		if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
			const meta = JSON.parse(raw.toString());
			const id = `s${++n}`;
			sessions.set(id, meta);
			res.writeHead(200, { Location: `${g.api}/session/${id}` });
			return res.end();
		}
		if (req.method === "PUT" && url.pathname.startsWith("/session/")) {
			const s = sessions.get(url.pathname.slice(9));
			if (!s) return json(res, 404, {});
			const id = `file-${++n}`;
			g.files.push({ id, name: s.name, parents: s.parents, size: raw.length });
			return json(res, 200, { id });
		}
		if (req.method === "GET" && url.pathname === "/drive/v3/files") {
			const folder = /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")?.[1];
			const files = g.files.filter((f) => f.parents.includes(folder!)).sort((a, b) => b.name.localeCompare(a.name));
			return json(res, 200, { files: files.map((f) => ({ id: f.id, name: f.name })) });
		}
		if (req.method === "DELETE" && url.pathname.startsWith("/drive/v3/files/")) {
			g.files = g.files.filter((f) => f.id !== decodeURIComponent(url.pathname.slice(16)));
			res.writeHead(204);
			return res.end();
		}
		json(res, 404, { error: { message: "not found" } });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	g.oauth = base;
	g.api = base;
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return g;
}
