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
	/** Renames a repository: the new name serves everything, the old one redirects (same id). */
	rename(from: string, to: string): void;
	/** Gives a repository an id without releases (for repository-identity checks). */
	repo(name: string): void;
	requests: string[];
}

export async function fakeGitHub(t: TestContext): Promise<FakeGitHub> {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-fakegh-"));
	const releases = new Map<string, { tag: string; tarball: string; manifest: Buffer }>();
	const requests: string[] = [];
	// Repository ids; an old name (after a rename) points at the same id.
	const ids = new Map<string, number>();
	const canonical = new Map<number, string>();
	let nextId = 1000;
	const idOf = (name: string) => {
		if (!ids.has(name)) {
			ids.set(name, ++nextId);
			canonical.set(nextId, name);
		}
		return ids.get(name)!;
	};
	const server: Server = createServer(async (req, res) => {
		const url = req.url ?? "";
		requests.push(url);
		const repoInfo = /^\/repos\/([^/]+\/[^/?]+)$/.exec(url);
		if (repoInfo && ids.has(repoInfo[1]!)) {
			const id = ids.get(repoInfo[1]!)!;
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ id, full_name: canonical.get(id) }));
		}
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
			idOf(repo);
		},
		rename(from, to) {
			const id = idOf(from);
			ids.set(to, id);
			canonical.set(id, to);
			const r = releases.get(from);
			if (r) releases.set(to, r);
		},
		repo(name) {
			idOf(name);
		},
	};
}
