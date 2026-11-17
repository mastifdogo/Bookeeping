// Per-user preferences (user_settings). For now: the sidebar's order and
// which entries are hidden.

import type { App } from "./app.ts";
import { queryRow } from "./db.ts";
import { DecodeError } from "./decode.ts";
import { ValidationError } from "./errors.ts";

export interface SidebarItem {
	/** "core:<name>" for Ledger's own pages, "module:<id>" for a module's. */
	id: string;
	hidden: boolean;
}

const ITEM_ID_RE = /^(core:[a-z][a-z-]{0,31}|module:[a-z][a-z0-9-]{1,31})$/;
const MAX_ITEMS = 200;

export function decodeSidebar(v: unknown): SidebarItem[] {
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : null) as Record<string, unknown> | null;
	if (!o) throw new DecodeError("expected an object");
	for (const k of Object.keys(o)) if (k !== "items") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
	const items = o.items;
	const verr = new ValidationError();
	if (!Array.isArray(items)) {
		verr.add("items", "must be a list");
		verr.throwIfAny();
	}
	const list = items as unknown[];
	if (list.length > MAX_ITEMS) verr.add("items", `at most ${MAX_ITEMS} entries`);
	const seen = new Set<string>();
	const out: SidebarItem[] = [];
	list.forEach((x, i) => {
		const it = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
		for (const k of Object.keys(it)) if (k !== "id" && k !== "hidden") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
		if (typeof it.id !== "string" || !ITEM_ID_RE.test(it.id)) return verr.add(`items[${i}].id`, 'must look like "core:journal" or "module:invoicing"');
		if (seen.has(it.id)) return verr.add(`items[${i}].id`, "is listed twice");
		if (it.hidden !== undefined && typeof it.hidden !== "boolean") return verr.add(`items[${i}].hidden`, "must be true or false");
		seen.add(it.id);
		out.push({ id: it.id, hidden: it.hidden === true });
	});
	verr.throwIfAny();
	return out;
}

export async function getSidebar(app: App, userId: number): Promise<{ items: SidebarItem[] }> {
	const r = await queryRow<{ sidebar: SidebarItem[] }>(app.main, `SELECT sidebar FROM user_settings WHERE user_id = $1`, [userId]);
	return { items: r?.sidebar ?? [] };
}

export async function putSidebar(app: App, userId: number, items: SidebarItem[]): Promise<{ items: SidebarItem[] }> {
	await app.main.query(
		`INSERT INTO user_settings (user_id, sidebar) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET sidebar = EXCLUDED.sidebar, updated_at = now()`,
		[userId, JSON.stringify(items)],
	);
	return { items };
}

// The dashboard's tiles (Settings → UI): where each goes on a 12-column grid
// and how big it is. Tiles not listed are placed after the others.

export const DASHBOARD_TILES = ["summary-CAD", "summary-USD", "notifications", "todos", "entries"] as const;
export const DASHBOARD_COLUMNS = 12;
const MAX_ROWS = 60;

export interface DashboardTile {
	id: (typeof DASHBOARD_TILES)[number];
	/** Column it starts in, 1-12. */
	x: number;
	/** Row it starts in, 1 and up (a row is about 2.5rem). */
	y: number;
	/** Width in columns. */
	w: number;
	/** Height in rows. */
	h: number;
	hidden: boolean;
}

export function decodeDashboardLayout(v: unknown): { tiles: DashboardTile[] } {
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : null) as Record<string, unknown> | null;
	if (!o) throw new DecodeError("expected an object");
	for (const k of Object.keys(o)) if (k !== "tiles") throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
	const verr = new ValidationError();
	if (!Array.isArray(o.tiles)) {
		verr.add("tiles", "must be a list");
		verr.throwIfAny();
	}
	const seen = new Set<string>();
	const out: DashboardTile[] = [];
	const int = (x: unknown) => Number(x && typeof x === "object" ? (x as { source?: unknown }).source : x);
	(o.tiles as unknown[]).forEach((x, i) => {
		const t = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
		for (const k of Object.keys(t)) if (!["id", "x", "y", "w", "h", "hidden"].includes(k)) throw new DecodeError(`json: unknown field ${JSON.stringify(k)}`);
		if (!(DASHBOARD_TILES as readonly unknown[]).includes(t.id)) return verr.add(`tiles[${i}].id`, `must be one of ${DASHBOARD_TILES.join(", ")}`);
		if (seen.has(t.id as string)) return verr.add(`tiles[${i}].id`, "is listed twice");
		const [px, py, pw, ph] = [int(t.x), int(t.y), int(t.w), int(t.h)];
		const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
		if (!ok(pw, 1, DASHBOARD_COLUMNS)) return verr.add(`tiles[${i}].w`, `must be 1-${DASHBOARD_COLUMNS} columns`);
		if (!ok(px, 1, DASHBOARD_COLUMNS - pw + 1)) return verr.add(`tiles[${i}].x`, `must be a column from 1 so the tile fits in ${DASHBOARD_COLUMNS}`);
		if (!ok(ph, 1, 30)) return verr.add(`tiles[${i}].h`, "must be 1-30 rows");
		if (!ok(py, 1, MAX_ROWS)) return verr.add(`tiles[${i}].y`, `must be a row from 1 to ${MAX_ROWS}`);
		if (t.hidden !== undefined && typeof t.hidden !== "boolean") return verr.add(`tiles[${i}].hidden`, "must be true or false");
		seen.add(t.id as string);
		out.push({ id: t.id as DashboardTile["id"], x: px, y: py, w: pw, h: ph, hidden: t.hidden === true });
	});
	verr.throwIfAny();
	return { tiles: out };
}

/** The user's layout; an empty list means the standard one. */
export async function getDashboardLayout(app: App, userId: number): Promise<{ tiles: DashboardTile[] }> {
	const r = await queryRow<{ dashboard: { tiles: DashboardTile[] } | null }>(app.main, `SELECT dashboard FROM user_settings WHERE user_id = $1`, [userId]);
	return { tiles: r?.dashboard?.tiles ?? [] };
}

export async function putDashboardLayout(app: App, userId: number, layout: { tiles: DashboardTile[] }): Promise<{ tiles: DashboardTile[] }> {
	await app.main.query(
		`INSERT INTO user_settings (user_id, dashboard) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET dashboard = EXCLUDED.dashboard, updated_at = now()`,
		[userId, layout.tiles.length ? JSON.stringify(layout) : null],
	);
	return layout;
}
