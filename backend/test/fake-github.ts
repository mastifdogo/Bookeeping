// A fake GitHub API serving module releases (source tarballs and manifests)
// built from local directories.

import { createServer, type Server } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export interface FakeGitHub {
	base: string;
	/** Publishes `dir` as the latest release `tag` of `repo` (e.g. "o/hello"). */
	publish(repo: string, tag: string, dir: string, edit?: (stage: string) => Promise<void>): Promise<void>;
	requests: string[];
}

export async function fakeGitHub(t: TestContext): Promise<FakeGitHub> {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-fakegh-"));
	const releases = new Map<string, { tag: string; tarball: string; manifest: Buffer }>();
	const requests: string[] = [];
	const server: Server = createServer(async (req, res) => {
		const url = req.url ?? "";
		requests.push(url);
		let m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url);
		if (m && releases.has(m[1]!)) {
			const r = releases.get(m[1]!)!;
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ tag_name: r.tag, tarball_url: `${base}/dl/${encodeURIComponent(m[1]!)}/${r.tag}` }));
		}
		m = /^\/repos\/([^/]+\/[^/]+)\/contents\/ledger-module\.json\?ref=(.+)$/.exec(url);
		if (m && releases.get(m[1]!)?.tag === decodeURIComponent(m[2]!)) {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ encoding: "base64", content: releases.get(m[1]!)!.manifest.toString("base64") }));
		}
		m = /^\/dl\/([^/]+)\/(.+)$/.exec(url);
		if (m) {
			const r = releases.get(decodeURIComponent(m[1]!));
			if (r && r.tag === m[2]) {
				res.writeHead(200, { "Content-Type": "application/gzip" });
				return res.end(await readFile(r.tarball));
			}
		}
		res.writeHead(404, { "Content-Type": "application/json" }).end('{"message":"Not Found"}');
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(async () => {
		await new Promise((r) => server.close(r));
		await rm(root, { recursive: true, force: true });
	});
	return {
		base,
		requests,
		async publish(repo, tag, dir, edit) {
			// GitHub source archives have one top directory: owner-repo-sha.
			const top = `${repo.replace("/", "-")}-${Math.random().toString(16).slice(2, 9)}`;
			const stage = path.join(root, "stage", top);
			await rm(path.join(root, "stage"), { recursive: true, force: true });
			await mkdir(stage, { recursive: true });
			await cp(dir, stage, { recursive: true });
			if (edit) await edit(stage);
			const tarball = path.join(root, `${repo.replace("/", "-")}-${tag}.tar.gz`);
			execFileSync("tar", ["-czf", tarball, "-C", path.join(root, "stage"), top]);
			releases.set(repo, { tag, tarball, manifest: await readFile(path.join(stage, "ledger-module.json")) });
		},
	};
}
