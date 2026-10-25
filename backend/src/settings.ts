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
	const r = await queryRow<{ sidebar: SidebarItem[] }>(app.db, `SELECT sidebar FROM user_settings WHERE user_id = $1`, [userId]);
	return { items: r?.sidebar ?? [] };
}

export async function putSidebar(app: App, userId: number, items: SidebarItem[]): Promise<{ items: SidebarItem[] }> {
	await app.db.query(
		`INSERT INTO user_settings (user_id, sidebar) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET sidebar = EXCLUDED.sidebar, updated_at = now()`,
		[userId, JSON.stringify(items)],
	);
	return { items };
}
