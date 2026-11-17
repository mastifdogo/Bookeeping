// The dashboard's tiles: where each goes on a 12-column grid and how big it
// is (Settings → UI). A row is ROW_REM tall. Each user has their own layout;
// none saved means the standard one.

export const COLUMNS = 12;
export const ROW_REM = 2.5;

export type TileId = 'summary-CAD' | 'summary-USD' | 'notifications' | 'todos' | 'entries';
export interface Tile {
	id: TileId;
	x: number;
	y: number;
	w: number;
	h: number;
	hidden: boolean;
}

export const TILE_LABELS: Record<TileId, string> = {
	'summary-CAD': 'CAD summary',
	'summary-USD': 'USD summary',
	notifications: 'Notifications',
	todos: 'To-do',
	entries: 'Recent entries'
};
export const TILE_IDS = Object.keys(TILE_LABELS) as TileId[];

/** The standard layout: summaries side by side (one alone takes the width), then notifications and to-dos, then recent entries. */
export function standardLayout(currencies: string[] = ['CAD', 'USD']): Tile[] {
	const both = currencies.includes('CAD') && currencies.includes('USD');
	const t = (id: TileId, x: number, y: number, w: number, h: number): Tile => ({ id, x, y, w, h, hidden: false });
	return [
		t('summary-CAD', 1, 1, both || !currencies.includes('CAD') ? 6 : 12, 9),
		t('summary-USD', both ? 7 : 1, 1, both || !currencies.includes('USD') ? 6 : 12, 9),
		t('notifications', 1, 10, 6, 6),
		t('todos', 7, 10, 6, 6),
		t('entries', 1, 16, 12, 9)
	];
}

/** A saved layout with any tile it lacks added at the bottom, and every tile kept on the grid. */
export function completeLayout(saved: Tile[] | null | undefined, currencies?: string[]): Tile[] {
	if (!saved || saved.length === 0) return standardLayout(currencies);
	const out = saved.filter((t) => TILE_IDS.includes(t.id)).map((t) => clamp({ ...t, hidden: t.hidden === true }));
	let bottom = Math.max(1, ...out.map((t) => t.y + t.h));
	for (const s of standardLayout(currencies)) {
		if (out.some((t) => t.id === s.id)) continue;
		out.push({ ...s, y: bottom });
		bottom += s.h;
	}
	return out;
}

export function clamp(t: Tile): Tile {
	const w = Math.min(COLUMNS, Math.max(1, Math.round(t.w)));
	const h = Math.min(30, Math.max(1, Math.round(t.h)));
	return { ...t, w, h, x: Math.min(COLUMNS - w + 1, Math.max(1, Math.round(t.x))), y: Math.min(60, Math.max(1, Math.round(t.y))) };
}

/** Tiles in reading order (top to bottom, then left to right), for narrow screens. */
export function readingOrder(tiles: Tile[]): Tile[] {
	return [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
}
