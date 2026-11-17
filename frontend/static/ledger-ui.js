// Ledger's page helpers, loaded by every Ledger page and added by Ledger to
// every module page it serves (/m/<id>/). Plain script, no dependencies.
//
// 1. Resizable list columns and form fields. Drag the right edge of a column
//    heading (th) or of a text field, dropdown or number box to make it wider
//    or narrower; double-click the edge to put it back. Sizes are remembered
//    in this browser, per page. An element inside [data-no-resize] is left
//    alone.
//
// 2. Forms that fill themselves in from an entry's "rate" tag (quantity,
//    unit and price, shared by Ledger and every module). Put
//    data-ledger-entry="<journal entry id>" on a form (or any element), and
//    data-ledger-fill="quantity" | "unit" | "rate" | "rate_cents" | "amount" |
//    "amount_cents" | "description" | "date" on fields inside it: empty fields
//    are filled when the entry is set or changes, and the element gets a
//    "ledger-rate" event with the rate in event.detail. LedgerUI.rateOf(id)
//    returns it too: { quantity, unit, rate_cents, amount_cents } or null.
(() => {
	if (window.LedgerUI) return;
	const EDGE = 6;
	const MIN = 36;
	const SKIP_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'submit', 'button', 'reset', 'image']);

	// ---- Remembered sizes, per page (numbers in the path count as one page: /journal/12 and /journal/13 share). ----
	const pageKey = () => 'ledger.sizes:' + location.pathname.replace(/\/\d+(?=\/|$)/g, '/#');
	const load = () => {
		try {
			return JSON.parse(localStorage.getItem(pageKey()) || '{}') || {};
		} catch {
			return {};
		}
	};
	const store = (sizes) => {
		try {
			if (Object.keys(sizes).length) localStorage.setItem(pageKey(), JSON.stringify(sizes));
			else localStorage.removeItem(pageKey());
		} catch {
			// storage blocked: sizes last until the page is left
		}
	};

	const isField = (el) =>
		el instanceof HTMLElement &&
		((el.tagName === 'INPUT' && !SKIP_TYPES.has(el.type)) || el.tagName === 'SELECT') &&
		!el.closest('[data-no-resize]');
	const isHead = (el) => el instanceof HTMLElement && el.tagName === 'TH' && !!el.closest('table') && !el.closest('[data-no-resize]');

	const clean = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 40);
	const text = (el) => clean(el.textContent || '');
	// A label's own words, not the options of a dropdown inside it.
	const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
	function fieldKey(el) {
		const label = el.closest('label');
		const own = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (label ? ownText(label) : '');
		if (own) return 'f:' + own;
		return 'f:#' + [...document.querySelectorAll('input, select')].filter(isField).indexOf(el);
	}
	const tables = () => [...document.querySelectorAll('table')];
	const headRow = (th) => th.parentElement;
	const colKey = (th) => 'c:' + tables().indexOf(th.closest('table')) + ':' + [...headRow(th).children].indexOf(th) + ':' + text(th);

	// A table's columns keep the widths they are given only with a fixed layout: freeze every heading in the row at its current width first.
	function freeze(table, row) {
		if (table.dataset.ledgerFrozen) return;
		const ths = [...row.children];
		const widths = ths.map((c) => c.getBoundingClientRect().width);
		ths.forEach((c, i) => (c.style.width = widths[i] + 'px'));
		table.style.tableLayout = 'fixed';
		table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
		table.dataset.ledgerFrozen = '1';
	}
	function unfreeze(table, row) {
		for (const c of row.children) c.style.width = '';
		table.style.tableLayout = '';
		table.style.width = '';
		delete table.dataset.ledgerFrozen;
	}
	const fitTable = (table, row) => (table.style.width = [...row.children].reduce((a, c) => a + (parseFloat(c.style.width) || c.getBoundingClientRect().width), 0) + 'px');

	function setWidth(el, px) {
		px = Math.max(MIN, Math.round(px));
		if (isHead(el)) {
			const table = el.closest('table');
			freeze(table, headRow(el));
			el.style.width = px + 'px';
			fitTable(table, headRow(el));
		} else {
			el.style.width = px + 'px';
			el.style.flex = 'none';
			el.style.maxWidth = 'none';
		}
	}

	// Puts remembered sizes back (on load and whenever the page draws new rows or fields).
	function restore() {
		const sizes = load();
		const keys = Object.keys(sizes);
		if (!keys.length) return;
		for (const el of document.querySelectorAll('input, select')) {
			if (!isField(el)) continue;
			const px = sizes[fieldKey(el)];
			if (px && el.style.width !== px + 'px') setWidth(el, px);
		}
		if (!keys.some((k) => k.startsWith('c:'))) return;
		for (const th of document.querySelectorAll('th')) {
			if (!isHead(th)) continue;
			const px = sizes[colKey(th)];
			if (px && th.style.width !== px + 'px') setWidth(th, px);
		}
	}

	function edgeTarget(e) {
		const el = e.target instanceof Element ? e.target.closest('th, input, select') : null;
		if (!el || !(isField(el) || isHead(el))) return null;
		const r = el.getBoundingClientRect();
		return e.clientX >= r.right - EDGE && e.clientX <= r.right + 2 ? el : null;
	}

	let dragging = null;
	document.addEventListener(
		'pointermove',
		(e) => {
			if (dragging) return;
			document.documentElement.classList.toggle('ledger-resize-edge', !!edgeTarget(e));
		},
		{ passive: true }
	);
	document.addEventListener(
		'pointerdown',
		(e) => {
			if (e.button !== 0) return;
			const el = edgeTarget(e);
			if (!el) return;
			// The edge resizes; it doesn't focus the field, open the dropdown or click the heading.
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startW = el.getBoundingClientRect().width;
			dragging = el;
			document.documentElement.classList.add('ledger-resizing');
			const move = (ev) => setWidth(el, startW + ev.clientX - startX);
			const up = () => {
				document.removeEventListener('pointermove', move, true);
				document.removeEventListener('pointerup', up, true);
				document.removeEventListener('pointercancel', up, true);
				document.documentElement.classList.remove('ledger-resizing');
				dragging = null;
				const sizes = load();
				sizes[isHead(el) ? colKey(el) : fieldKey(el)] = Math.round(el.getBoundingClientRect().width);
				store(sizes);
			};
			document.addEventListener('pointermove', move, true);
			document.addEventListener('pointerup', up, true);
			document.addEventListener('pointercancel', up, true);
		},
		true
	);
	// A click on the edge of a heading that sorts or opens something shouldn't do it.
	document.addEventListener('click', (e) => edgeTarget(e) && (e.preventDefault(), e.stopPropagation()), true);
	document.addEventListener(
		'dblclick',
		(e) => {
			const el = edgeTarget(e);
			if (!el) return;
			e.preventDefault();
			const sizes = load();
			if (isHead(el)) {
				const table = el.closest('table');
				const row = headRow(el);
				delete sizes[colKey(el)];
				const left = [...row.children].some((c) => sizes[colKey(c)]);
				if (left) {
					el.style.width = '';
					el.style.width = el.getBoundingClientRect().width + 'px';
					fitTable(table, row);
				} else unfreeze(table, row);
			} else {
				delete sizes[fieldKey(el)];
				el.style.width = el.style.flex = el.style.maxWidth = '';
			}
			store(sizes);
		},
		true
	);

	const style = document.createElement('style');
	style.textContent = `
		html.ledger-resize-edge, html.ledger-resize-edge *, html.ledger-resizing, html.ledger-resizing * { cursor: col-resize !important; }
		html.ledger-resizing { user-select: none; }
		:where(th) { position: relative; }
		:where(th:not(:last-child))::after { content: ''; position: absolute; top: 25%; right: 0; height: 50%; border-right: 1px solid color-mix(in srgb, currentColor 25%, transparent); pointer-events: none; }
		table[data-ledger-frozen] th, table[data-ledger-frozen] td { overflow: hidden; text-overflow: ellipsis; }
	`;
	(document.head || document.documentElement).appendChild(style);

	// ---- Rate tags fill forms in ----
	const rates = new Map();
	function rateOf(id) {
		id = String(id || '').trim();
		if (!/^[1-9]\d{0,17}$/.test(id)) return Promise.resolve(null);
		if (!rates.has(id)) {
			rates.set(
				id,
				fetch('/api/v1/journal-entries/' + id, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
					.then((r) => (r.ok ? r.json() : null))
					.then((e) => {
						if (!e) return null;
						const t = (e.tags || []).find((x) => x.tag === 'rate');
						const rate = t
							? { quantity: t.quantity, unit: t.unit, rate_cents: t.rate_cents, amount_cents: t.quantity != null && t.rate_cents != null ? Math.round(t.quantity * t.rate_cents) : null }
							: null;
						return { rate, entry: e };
					})
					.catch(() => null)
			);
			setTimeout(() => rates.delete(id), 30000);
		}
		return rates.get(id).then((x) => (x ? x.rate : null));
	}
	const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
	async function fill(box) {
		const id = box.getAttribute('data-ledger-entry');
		if (!id || box.dataset.ledgerFilled === id) return;
		box.dataset.ledgerFilled = id;
		const rate = await rateOf(id);
		const got = await rates.get(String(id).trim());
		const entry = got ? got.entry : null;
		if (box.getAttribute('data-ledger-entry') !== id) return;
		const values = {
			quantity: rate && rate.quantity != null ? String(rate.quantity) : '',
			unit: rate ? rate.unit || '' : '',
			rate: rate ? dollars(rate.rate_cents) : '',
			rate_cents: rate && rate.rate_cents != null ? String(rate.rate_cents) : '',
			amount: rate ? dollars(rate.amount_cents) : '',
			amount_cents: rate && rate.amount_cents != null ? String(rate.amount_cents) : '',
			description: entry ? entry.description || '' : '',
			date: entry ? entry.entry_date || '' : ''
		};
		for (const f of box.querySelectorAll('[data-ledger-fill]')) {
			const v = values[f.getAttribute('data-ledger-fill')];
			if (!v || !('value' in f) || (f.value !== '' && !f.hasAttribute('data-ledger-overwrite'))) continue;
			f.value = v;
			f.dispatchEvent(new Event('input', { bubbles: true }));
			f.dispatchEvent(new Event('change', { bubbles: true }));
		}
		box.dispatchEvent(new CustomEvent('ledger-rate', { bubbles: true, detail: rate }));
	}
	const fillAll = () => document.querySelectorAll('[data-ledger-entry]').forEach(fill);

	// ---- Watch the page as it changes ----
	let queued = false;
	const later = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			restore();
			fillAll();
		});
	};
	const start = () => {
		new MutationObserver(later).observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ledger-entry'] });
		later();
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
	// SvelteKit and other client-side routers change pages without a reload: sizes are per page.
	addEventListener('popstate', later);

	window.LedgerUI = { rateOf, refill: (box) => (delete box.dataset.ledgerFilled, fill(box)), restoreSizes: restore };
})();
