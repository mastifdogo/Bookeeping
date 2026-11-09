import type { AccountType } from '#lib/api/client.ts';

/**
 * The code a new account of this type would get: the next round number after
 * the highest one in the type's range (1xxx assets, 2xxx liabilities, 3xxx
 * equity, 4xxx revenue, 5xxx expenses), else the first free number there.
 */
export function suggestCode(accounts: { code: string }[], type: AccountType): string {
	const start = { asset: 1000, liability: 2000, equity: 3000, revenue: 4000, expense: 5000 }[type];
	const end = start + 1000;
	const used = new Set(accounts.map((a) => a.code));
	const inRange = accounts.map((a) => Number(a.code)).filter((n) => Number.isInteger(n) && n >= start && n < end);
	if (inRange.length === 0) return String(start);
	const next = Math.floor(Math.max(...inRange) / 10) * 10 + 10;
	if (next < end && !used.has(String(next))) return String(next);
	for (let n = start; n < end; n++) if (!used.has(String(n))) return String(n);
	return '';
}
