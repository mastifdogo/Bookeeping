// Small GitHub REST helpers for modules (used by the app's preview and the
// root installer). LEDGER_UPDATE_API overrides the API base (tests).

import { validateManifest, type ModuleManifest } from "./modules.ts";

export function githubApi(): string {
	return process.env.LEDGER_UPDATE_API || "https://api.github.com";
}

const TAG_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Headers for a request to GitHub. Without a token GitHub allows a server's
 * address 60 requests an hour, which checking Ledger and a handful of
 * modules a few times uses up; LEDGER_GITHUB_TOKEN in ledger.env (any
 * GitHub token, no permissions needed for public repositories) raises it to
 * 5,000 and is only ever sent to GitHub's own hosts.
 */
export function githubHeaders(url: string, userAgent = "ledger"): Record<string, string> {
	const h: Record<string, string> = { "User-Agent": userAgent };
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		// not a URL: no token
	}
	if (host === "api.github.com") h.Accept = "application/vnd.github+json";
	const token = (process.env.LEDGER_GITHUB_TOKEN ?? "").trim();
	const base = new URL(githubApi()).hostname;
	if (token && /^[A-Za-z0-9_]{20,255}$/.test(token) && (host === base || host === "api.github.com")) h.Authorization = `Bearer ${token}`;
	return h;
}

/** What went wrong with a GitHub request, in words: a 403 or 429 is nearly always the hourly limit. */
export function githubProblem(res: Response): string {
	const remaining = res.headers.get("x-ratelimit-remaining");
	const reset = Number(res.headers.get("x-ratelimit-reset"));
	const retry = Number(res.headers.get("retry-after"));
	if ((res.status === 403 || res.status === 429) && (remaining === "0" || retry > 0 || !res.headers.has("x-ratelimit-remaining"))) {
		const when = reset > 0 ? new Date(reset * 1000) : retry > 0 ? new Date(Date.now() + retry * 1000) : null;
		const at = when ? ` Try again after ${when.toISOString().slice(11, 16)} UTC.` : " Try again in an hour.";
		const tokenSet = (process.env.LEDGER_GITHUB_TOKEN ?? "").trim() !== "";
		return (
			`GitHub's hourly limit for this server's internet address is used up (GitHub answered ${res.status}).${at}` +
			(tokenSet ? "" : " To raise the limit from 60 to 5,000 requests an hour, add LEDGER_GITHUB_TOKEN=<a GitHub token> to /etc/ledger/ledger.env and restart Ledger.")
		);
	}
	if (res.status === 401) return "GitHub refused the token in LEDGER_GITHUB_TOKEN (GitHub answered 401): it may have expired";
	return `GitHub answered ${res.status}`;
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { headers: githubHeaders(url), signal: AbortSignal.timeout(20_000) });
	if (res.status === 404) throw new Error("not found on GitHub (check the name, and that it has a published release)");
	if (!res.ok) throw new Error(githubProblem(res));
	return res.json();
}

/**
 * A repository's permanent id and current name. GitHub keeps the id when a
 * repository is renamed or transferred, and redirects the old name.
 */
export async function repoIdentity(apiBase: string, repo: string): Promise<{ id: number; full_name: string }> {
	const body = (await getJson(`${apiBase}/repos/${repo}`)) as { id?: unknown; full_name?: unknown };
	if (typeof body.id !== "number" || typeof body.full_name !== "string") throw new Error("GitHub returned no repository id");
	return { id: body.id, full_name: body.full_name };
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
