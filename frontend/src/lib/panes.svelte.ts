// Side-by-side panes. The main pane is the current page; others show another
// page in a same-origin iframe (rendered without the sidebar). Panes fill the
// window's height and share its width: each has a weight, and dragging the
// edge between two panes moves weight from one to the other. Order is CSS
// `order`, so reordering never moves an iframe in the DOM (that would reload it).
// Remembered in this browser only.

export interface Pane {
	id: string;
	/** null for the main pane. */
	path: string | null;
	weight: number;
	order: number;
}

const STORAGE_KEY = 'ledger.panes';
export const MAIN_ID = 'main';
export const MIN_PANE_PX = 260;
const MAX_PANES = 6;

function load(): Pane[] {
	try {
		const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		if (!Array.isArray(v)) return [];
		const panes = v.filter(
			(p): p is Pane =>
				p &&
				typeof p.id === 'string' &&
				(p.path === null || (typeof p.path === 'string' && p.path.startsWith('/') && !p.path.startsWith('//'))) &&
				Number.isFinite(p.weight) &&
				p.weight > 0 &&
				Number.isFinite(p.order)
		);
		return panes.some((p) => p.id === MAIN_ID) ? panes.slice(0, MAX_PANES) : [];
	} catch {
		return [];
	}
}

class Panes {
	list = $state<Pane[]>(load());

	/** Panes in display order. */
	get ordered(): Pane[] {
		return [...this.list].sort((a, b) => a.order - b.order);
	}

	get split(): boolean {
		return this.list.length > 1;
	}

	get full(): boolean {
		return this.list.length >= MAX_PANES;
	}

	save() {
		try {
			if (this.split) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list));
			else localStorage.removeItem(STORAGE_KEY);
		} catch {
			// storage blocked: panes last until the page is reloaded
		}
	}

	/** Opens `path` in a new pane to the right. */
	open(path: string) {
		if (this.full) return;
		if (!this.split) this.list = [{ id: MAIN_ID, path: null, weight: 1, order: 0 }];
		const avg = this.list.reduce((s, p) => s + p.weight, 0) / this.list.length;
		const order = Math.max(...this.list.map((p) => p.order)) + 1;
		this.list.push({
			id: Math.random().toString(36).slice(2, 10),
			path,
			weight: avg,
			order
		});
		this.save();
	}

	close(id: string) {
		this.list = this.list.filter((p) => p.id !== id);
		if (this.list.length <= 1) this.list = [];
		this.save();
	}

	navigated(id: string, path: string) {
		const p = this.list.find((x) => x.id === id);
		if (p && p.path !== path) {
			p.path = path;
			this.save();
		}
	}

	/** Moves pane `id` to where pane `target` is (dragging a header onto another pane). */
	move(id: string, target: string) {
		const order = this.ordered.map((p) => p.id);
		const from = order.indexOf(id);
		const to = order.indexOf(target);
		if (from < 0 || to < 0 || from === to) return;
		order.splice(to, 0, order.splice(from, 1)[0]!);
		for (const p of this.list) p.order = order.indexOf(p.id);
		this.save();
	}

	/**
	 * Resizes the edge after pane `id` by `dx` pixels, given the container's
	 * width. Neither neighbour gets narrower than MIN_PANE_PX.
	 */
	resize(id: string, dx: number, containerPx: number) {
		const ordered = this.ordered;
		const i = ordered.findIndex((p) => p.id === id);
		const a = ordered[i];
		const b = ordered[i + 1];
		if (!a || !b || containerPx <= 0) return;
		const total = ordered.reduce((s, p) => s + p.weight, 0);
		const perPx = total / containerPx;
		const min = MIN_PANE_PX * perPx;
		const pair = a.weight + b.weight;
		const wa = Math.min(Math.max(a.weight + dx * perPx, min), pair - min);
		if (pair - 2 * min <= 0) return;
		a.weight = wa;
		b.weight = pair - wa;
	}
}

export const panes = new Panes();
