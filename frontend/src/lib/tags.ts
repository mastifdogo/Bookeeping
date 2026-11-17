// Tags on journal entries, shared by Ledger and every module. "rate" carries
// how many of what at what price, so modules' forms can fill themselves in.

import { formatCents, parseAmount } from './money.ts';

export const STANDARD_TAGS = ['paid', 'billed', 'overdue', 'customer', 'vendor', 'rate'] as const;

export interface TagLike {
	tag: string;
	entity: { id: number; name: string } | null;
	quantity?: number | null;
	unit?: string | null;
	rate_cents?: number | null;
}

/** "paid", "customer: Acme", "rate: 7.5 hours × 80.00 = 600.00". */
export function tagLabel(t: TagLike): string {
	if (t.entity) return `${t.tag}: ${t.entity.name}`;
	if (t.tag !== 'rate') return t.tag;
	const q = t.quantity != null ? `${t.quantity}${t.unit ? ' ' + t.unit : ''}` : '';
	const r = t.rate_cents != null ? `${formatCents(t.rate_cents)}${t.unit && t.quantity == null ? ' / ' + t.unit : ''}` : '';
	const total = t.quantity != null && t.rate_cents != null ? ` = ${formatCents(Math.round(t.quantity * t.rate_cents))}` : '';
	return `rate: ${q && r ? `${q} × ${r}` : q || r}${total}`;
}

/** What the tag form holds. */
export interface TagForm {
	tag: string;
	custom: string;
	entity: string;
	quantity: string;
	unit: string;
	rate: string;
}
export const emptyTagForm = (): TagForm => ({ tag: 'paid', custom: '', entity: '', quantity: '', unit: '', rate: '' });

export type TagBody = { tag: string; entity_id?: number | null; quantity?: number | null; unit?: string | null; rate_cents?: number | null };

/** The request body for the form, or an error message to show. */
export function tagBody(f: TagForm): TagBody | string {
	const tag = (f.tag === '' ? f.custom : f.tag).trim().toLowerCase();
	if (!tag) return 'Choose a tag.';
	if (tag === 'customer' || tag === 'vendor') {
		if (!Number(f.entity)) return `Choose which ${tag}.`;
		return { tag, entity_id: Number(f.entity) };
	}
	if (tag !== 'rate') return { tag };
	const body: TagBody = { tag };
	if (f.quantity.trim()) {
		const q = Number(f.quantity.trim().replaceAll(',', ''));
		if (!Number.isFinite(q)) return 'The quantity must be a number, e.g. 7.5.';
		body.quantity = q;
	}
	if (f.rate.trim()) {
		const c = parseAmount(f.rate);
		if (c === null) return 'The rate must be an amount, e.g. 80.00.';
		body.rate_cents = c;
	}
	if (body.quantity == null && body.rate_cents == null) return 'A rate needs a quantity, a price or both.';
	if (f.unit.trim()) body.unit = f.unit.trim();
	return body;
}
