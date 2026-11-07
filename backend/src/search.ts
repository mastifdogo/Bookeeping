// The search bar: accounts, journal entries and whatever modules add with
// ctx.search.provide(). Pages and settings are matched in the browser.

import type { App } from "./app.ts";
import { queryRows } from "./db.ts";
import { log } from "./log.ts";
import type { User } from "./types.ts";

export interface SearchResult {
	title: string;
	subtitle: string;
	/** A path inside Ledger. */
	href: string;
}

export interface SearchGroup {
	/** "accounts", "entries" or "module:<id>". */
	source: string;
	label: string;
	results: SearchResult[];
}

export type SearchProvider = (query: string, opts: { limit: number; user: { username: string; role: string } }) => unknown;

const MODULE_TIMEOUT_MS = 2000;
const LOCAL_PATH_RE = /^\/(?![/\\])[^\s]{0,500}$/;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** "1,234.5" or "$12" as cents, or null. */
function amountCents(q: string): bigint | null {
	const m = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(q.trim());
	if (!m) return null;
	return BigInt(m[1]!.replaceAll(",", "")) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

const money = (c: bigint) => {
	const neg = c < 0n;
	const a = neg ? -c : c;
	return `${neg ? "-" : ""}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(a % 100n).toString().padStart(2, "0")}`;
};

async function searchAccounts(app: App, q: string, limit: number): Promise<SearchResult[]> {
	const rows = await queryRows<{ code: string; name: string; type: string; currency: string; is_active: boolean }>(
		app.db,
		`SELECT code, name, type::text, currency, is_active FROM accounts
		  WHERE code ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%'
		  ORDER BY (code ILIKE $1 || '%') DESC, is_active DESC, code
		  LIMIT $2`,
		[likeEscape(q), limit],
	);
	return rows.map((a) => ({
		title: `${a.code} ${a.name}`,
		subtitle: `${a.type} · ${a.currency}${a.is_active ? "" : " · inactive"}`,
		href: `/accounts/${encodeURIComponent(a.code)}`,
	}));
}

async function searchEntries(app: App, q: string, limit: number): Promise<SearchResult[]> {
	const id = /^#?(\d{1,18})$/.exec(q.trim())?.[1] ?? null;
	const cents = amountCents(q);
	const rows = await queryRows<{ id: bigint; entry_date: string; description: string; reference: string; total: bigint | null; currency: string | null; memo: string | null }>(
		app.db,
		`SELECT e.id, e.entry_date, e.description, e.reference,
		        (SELECT sum(t.amount) FILTER (WHERE t.amount > 0)::bigint FROM transactions t WHERE t.journal_entry_id = e.id) AS total,
		        (SELECT min(t.currency) FROM transactions t WHERE t.journal_entry_id = e.id) AS currency,
		        (SELECT t.memo FROM transactions t WHERE t.journal_entry_id = e.id AND $1 <> '' AND t.memo ILIKE '%' || $1 || '%' LIMIT 1) AS memo
		   FROM journal_entries e
		  WHERE ($2::bigint IS NOT NULL AND e.id = $2)
		     OR e.description ILIKE '%' || $1 || '%'
		     OR e.reference ILIKE '%' || $1 || '%'
		     OR EXISTS (SELECT 1 FROM transactions t WHERE t.journal_entry_id = e.id
		                 AND (t.memo ILIKE '%' || $1 || '%' OR ($3::bigint IS NOT NULL AND abs(t.amount) = $3)))
		  ORDER BY ($2::bigint IS NOT NULL AND e.id = $2) DESC, e.entry_date DESC, e.id DESC
		  LIMIT $4`,
		[likeEscape(q), id, cents, limit],
	);
	return rows.map((e) => ({
		title: `#${e.id} ${e.description}`,
		subtitle: [e.entry_date, e.total !== null ? `${money(e.total)} ${e.currency ?? ""}`.trim() : "", e.reference, e.memo ?? ""].filter(Boolean).join(" · "),
		href: `/journal/${e.id}`,
	}));
}

/** Results a module returned, cleaned up; anything malformed is dropped. */
function cleanModuleResults(v: unknown, limit: number): SearchResult[] {
	if (!Array.isArray(v)) return [];
	const out: SearchResult[] = [];
	for (const x of v) {
		const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
		if (typeof o.title !== "string" || typeof o.href !== "string" || !LOCAL_PATH_RE.test(o.href)) continue;
		out.push({ title: o.title.slice(0, 200), subtitle: typeof o.subtitle === "string" ? o.subtitle.slice(0, 300) : "", href: o.href });
		if (out.length >= limit) break;
	}
	return out;
}

export async function search(app: App, query: string, user: User, limit = 8): Promise<{ query: string; groups: SearchGroup[] }> {
	const q = query.trim().slice(0, 200);
	if (q.length < 1) return { query: q, groups: [] };
	const modules = [...app.modules.modules.values()].filter((m) => !m.error && m.searchProviders.length > 0);
	const [accounts, entries, ...fromModules] = await Promise.all([
		searchAccounts(app, q, limit),
		searchEntries(app, q, limit),
		...modules.map(async (m): Promise<SearchGroup> => {
			const results: SearchResult[] = [];
			for (const fn of m.searchProviders) {
				let timer: NodeJS.Timeout | undefined;
				try {
					const v = await Promise.race([
						Promise.resolve(fn(q, { limit, user: { username: user.username, role: user.role } })),
						new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${MODULE_TIMEOUT_MS} ms`)), MODULE_TIMEOUT_MS))),
					]);
					results.push(...cleanModuleResults(v, limit - results.length));
				} catch (err) {
					log.warn("module search failed", { module: m.manifest.id, err: (err as Error).message });
				} finally {
					clearTimeout(timer);
				}
			}
			return { source: `module:${m.manifest.id}`, label: m.manifest.name, results };
		}),
	]);
	const groups: SearchGroup[] = [
		{ source: "accounts", label: "Accounts", results: accounts },
		{ source: "entries", label: "Journal entries", results: entries },
		...fromModules,
	];
	return { query: q, groups: groups.filter((g) => g.results.length > 0) };
}
