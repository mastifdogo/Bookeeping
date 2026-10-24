// Small GitHub REST helpers for modules (used by the app's preview and the
// root installer). LEDGER_UPDATE_API overrides the API base (tests).

import { validateManifest, type ModuleManifest } from "./modules.ts";

export function githubApi(): string {
	return process.env.LEDGER_UPDATE_API || "https://api.github.com";
}

const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "ledger" };
const TAG_RE = /^[A-Za-z0-9._-]{1,100}$/;

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
	if (res.status === 404) throw new Error("not found on GitHub (check the name, and that it has a published release)");
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	return res.json();
}

export interface ModuleRelease {
	tag: string;
	/** Source archive of the tagged release. */
	tarball: string;
}

/** The latest published release of a repository. */
export async function latestModuleRelease(apiBase: string, repo: string): Promise<ModuleRelease> {
	const body = (await getJson(`${apiBase}/repos/${repo}/releases/latest`)) as { tag_name?: unknown; tarball_url?: unknown };
	const tag = typeof body.tag_name === "string" ? body.tag_name : "";
	if (!TAG_RE.test(tag)) throw new Error(`unexpected release tag ${JSON.stringify(tag)}`);
	const tarball = typeof body.tarball_url === "string" && /^https?:\/\//.test(body.tarball_url) ? body.tarball_url : `${apiBase}/repos/${repo}/tarball/${tag}`;
	return { tag, tarball };
}

/** The ledger-module.json of a repository at a tag. */
export async function fetchManifest(apiBase: string, repo: string, tag: string): Promise<ModuleManifest> {
	const body = (await getJson(`${apiBase}/repos/${repo}/contents/ledger-module.json?ref=${encodeURIComponent(tag)}`)) as {
		content?: unknown;
		encoding?: unknown;
	};
	if (typeof body.content !== "string" || body.encoding !== "base64") throw new Error("ledger-module.json could not be read");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
	} catch {
		throw new Error("ledger-module.json is not valid JSON");
	}
	return validateManifest(parsed);
}
