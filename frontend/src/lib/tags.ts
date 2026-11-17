// Tags on journal entries, shared by Ledger and every module. "rate" is an
// item, description, quantity and rate (an entry can have several), so
// modules' forms can fill themselves in.

import { formatCents, parseAmount } from './money.ts';

export const STANDARD_TAGS = ['paid', 'billed', 'overdue', 'customer', 'vendor', 'rate'] as const;

export interface TagLike {
	id?: number;
	tag: string;
	entity: { id: number; name: string } | null;
	description?: string | null;
	quantity?: number | null;
	unit?: string | null;
	rate_cents?: number | null;
}

/** "paid", "customer: Acme", "rate: Labour, 7.5 hours, 80.00 = 600.00" (description, quantity, rate). */
export function tagLabel(t: TagLike): string {
	if (t.entity) return `${t.tag}: ${t.entity.name}`;
	if (t.tag !== 'rate') return t.tag;
	const q = t.quantity != null ? `${t.quantity}${t.unit ? ' ' + t.unit : ''}` : '';
	const r = t.rate_cents != null ? `${formatCents(t.rate_cents)}${t.unit && t.quantity == null ? ' / ' + t.unit : ''}` : '';
	const total = t.quantity != null && t.rate_cents != null ? ` = ${formatCents(Math.round(t.quantity * t.rate_cents))}` : '';
	return `rate: ${[t.description ?? '', q, r].filter(Boolean).join(', ')}${total}`;
}

/** What the tag form holds. `id` is the rate item being changed ('' adds a new one). */
export interface TagForm {
	tag: string;
	custom: string;
	entity: string;
	id: string;
	description: string;
	quantity: string;
	unit: string;
	rate: string;
}
export const emptyTagForm = (): TagForm => ({ tag: 'paid', custom: '', entity: '', id: '', description: '', quantity: '', unit: '', rate: '' });

export type TagBody = {
	tag: string;
	entity_id?: number | null;
	id?: number | null;
	description?: string | null;
	quantity?: number | null;
	unit?: string | null;
	rate_cents?: number | null;
};

const QTY_RE = /^\s*(-?[\d,]*\.?\d+)\s*([A-Za-z][A-Za-z0-9 ./_-]{0,19})?\s*$/;

/**
 * A rate item typed in one go, "description,quantity,rate" (e.g. "Labour,
 * 7.5 hours, 80.00"), split into its fields; null when the text isn't that.
 * The description may itself hold commas: the last two parts are the numbers.
 */
export function parseRateItem(text: string): { description: string; quantity: string; unit: string; rate: string } | null {
	const parts = text.split(',');
	if (parts.length < 3) return null;
	const rate = parts.pop()!.trim();
	const qty = parts.pop()!.trim();
	const m = QTY_RE.exec(qty);
	if (!m || (rate !== '' && parseAmount(rate.replace(/^\$/, '')) === null)) return null;
	return { description: parts.join(',').trim(), quantity: m[1], unit: (m[2] ?? '').trim(), rate };
}

/** The request body for the form, or an error message to show. */
export function tagBody(f: TagForm): TagBody | string {
	const tag = (f.tag === '' ? f.custom : f.tag).trim().toLowerCase();
	if (!tag) return 'Choose a tag.';
	if (tag === 'customer' || tag === 'vendor') {
		if (!Number(f.entity)) return `Choose which ${tag}.`;
		return { tag, entity_id: Number(f.entity) };
	}
	if (tag !== 'rate') return { tag };
	// "Labour, 7.5 hours, 80.00" typed in the description fills the other fields.
	if (!f.quantity.trim() && !f.rate.trim()) {
		const p = parseRateItem(f.description);
		if (p) f = { ...f, description: p.description, quantity: p.quantity, unit: f.unit.trim() || p.unit, rate: p.rate };
	}
	const body: TagBody = { tag };
	if (Number(f.id)) body.id = Number(f.id);
	if (f.description.trim()) {
		if (f.description.trim().length > 100) return 'The description can be at most 100 characters.';
		body.description = f.description.trim();
	}
	if (f.quantity.trim()) {
		const q = Number(f.quantity.trim().replaceAll(',', ''));
		if (!Number.isFinite(q)) return 'The quantity must be a number, e.g. 7.5.';
		body.quantity = q;
	}
	if (f.rate.trim()) {
		const c = parseAmount(f.rate.trim().replace(/^\$/, ''));
		if (c === null) return 'The rate must be an amount, e.g. 80.00.';
		body.rate_cents = c;
	}
	if (body.quantity == null && body.rate_cents == null) return 'An item needs a quantity, a rate or both, e.g. Labour, 7.5, 80.00.';
	if (f.unit.trim()) body.unit = f.unit.trim();
	return body;
}
