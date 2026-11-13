// Financial statements. All amounts are in each account's natural sign
// (assets/expenses debit-positive; liabilities/equity/revenue
// credit-positive) and reported per currency: currencies are never added.

import type { App } from "./app.ts";
import { queryRows } from "./db.ts";
import { invalid } from "./errors.ts";
import { today } from "./date.ts";
import type { AccountType, Currency } from "./types.ts";

export interface ReportLine {
	account_code: string;
	account_name: string;
	/** The account's own postings. */
	amount_cents: bigint;
	/** 0 for a top-level account, 1 for its sub-accounts, and so on. Lines come parent first, then its sub-accounts. */
	depth: number;
	parent_code: string | null;
	/** Whether sub-account lines follow this one. */
	has_children: boolean;
	/** amount_cents plus every sub-account line below it. */
	total_cents: bigint;
}

export interface BalanceSheetSection {
	currency: Currency;
	assets: ReportLine[];
	liabilities: ReportLine[];
	equity: ReportLine[];
	/** Revenue minus expenses to date, not yet closed to an equity account. */
	net_income_cents: bigint;
	total_assets_cents: bigint;
	total_liabilities_cents: bigint;
	/** Equity accounts plus net income. */
	total_equity_cents: bigint;
	/** Assets = liabilities + equity (always true for a valid ledger). */
	balanced: boolean;
}

export interface BalanceSheet {
	as_of: string;
	currencies: BalanceSheetSection[];
}

export interface IncomeStatementSection {
	currency: Currency;
	revenue: ReportLine[];
	expenses: ReportLine[];
	total_revenue_cents: bigint;
	total_expenses_cents: bigint;
	net_income_cents: bigint;
}

export interface IncomeStatement {
	from: string;
	to: string;
	currencies: IncomeStatementSection[];
}

interface AccountSum {
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
	natural: bigint;
	/** Position in the chart: parents come before their sub-accounts. */
	depth: number;
	parent_code: string | null;
	has_children: boolean;
	total: bigint;
}

const lineOf = (s: AccountSum): ReportLine => ({ account_code: s.code, account_name: s.name, amount_cents: s.natural, depth: s.depth, parent_code: s.parent_code, has_children: s.has_children, total_cents: s.total });

/**
 * The natural-sign balance of each account over entries dated in [from, to]
 * (from may be null), as a tree per currency and type: a parent, then its
 * sub-accounts by code. An account is listed when it or one of its
 * sub-accounts has a non-zero total.
 */
async function accountSums(app: App, from: string | null, to: string, currency: Currency | null, types: AccountType[]): Promise<AccountSum[]> {
	const rows = await queryRows<{ id: bigint; parent_id: bigint | null; code: string; name: string; type: AccountType; currency: Currency; sum: bigint }>(
		app.db,
		`SELECT a.id, a.parent_id, a.code, a.name, a.type, a.currency,
		        COALESCE((SELECT sum(t.amount) FROM transactions t JOIN journal_entries e ON e.id = t.journal_entry_id
		                   WHERE t.account_id = a.id AND e.entry_date <= $2 AND ($1::date IS NULL OR e.entry_date >= $1)), 0)::bigint AS sum
		   FROM accounts a
		  WHERE ($3::text IS NULL OR a.currency = $3)
		    AND a.type::text = ANY($4)
		  ORDER BY a.currency, a.code`,
		[from, to, currency, types],
	);
	type Node = AccountSum & { id: bigint; parent_id: bigint | null; kids: Node[] };
	const nodes = new Map<bigint, Node>();
	for (const r of rows) {
		const natural = r.type === "asset" || r.type === "expense" ? r.sum : -r.sum;
		nodes.set(r.id, { id: r.id, parent_id: r.parent_id, code: r.code, name: r.name, type: r.type, currency: r.currency, natural, depth: 0, parent_code: null, has_children: false, total: natural, kids: [] });
	}
	const roots: Node[] = [];
	for (const n of nodes.values()) {
		const p = n.parent_id === null ? undefined : nodes.get(n.parent_id);
		if (p) p.kids.push(n);
		else roots.push(n); // top-level (or its parent is outside this report's types and currency)
	}
	const out: AccountSum[] = [];
	// Depth-first; a branch is kept when anything in it has a balance.
	const walk = (n: Node, depth: number, parent: string | null): { shown: boolean; total: bigint; lines: AccountSum[] } => {
		let total = n.natural;
		const below: AccountSum[] = [];
		for (const k of n.kids) {
			const r = walk(k, depth + 1, n.code);
			if (r.shown) {
				total += r.total;
				below.push(...r.lines);
			}
		}
		if (n.natural === 0n && below.length === 0) return { shown: false, total: 0n, lines: [] };
		const { id: _i, parent_id: _p, kids: _k, ...line } = n;
		return { shown: true, total, lines: [{ ...line, depth, parent_code: parent, has_children: below.length > 0, total }, ...below] };
	};
	for (const r of roots) out.push(...walk(r, 0, null).lines);
	return out;
}

export async function getBalanceSheet(app: App, asOf: string | null, currency: Currency | null): Promise<BalanceSheet> {
	const day = asOf ?? today();
	const sums = await accountSums(app, null, day, currency, ["asset", "liability", "equity", "revenue", "expense"]);

	const sections = new Map<Currency, BalanceSheetSection>();
	for (const s of sums) {
		let sec = sections.get(s.currency);
		if (!sec) {
			sec = {
				currency: s.currency,
				assets: [],
				liabilities: [],
				equity: [],
				net_income_cents: 0n,
				total_assets_cents: 0n,
				total_liabilities_cents: 0n,
				total_equity_cents: 0n,
				balanced: false,
			};
			sections.set(s.currency, sec);
		}
		const line = lineOf(s);
		switch (s.type) {
			case "asset":
				sec.assets.push(line);
				sec.total_assets_cents += s.natural;
				break;
			case "liability":
				sec.liabilities.push(line);
				sec.total_liabilities_cents += s.natural;
				break;
			case "equity":
				sec.equity.push(line);
				sec.total_equity_cents += s.natural;
				break;
			case "revenue":
				sec.net_income_cents += s.natural;
				break;
			case "expense":
				sec.net_income_cents -= s.natural;
				break;
		}
	}
	const currencies = [...sections.values()];
	for (const sec of currencies) {
		sec.total_equity_cents += sec.net_income_cents;
		sec.balanced = sec.total_assets_cents === sec.total_liabilities_cents + sec.total_equity_cents;
	}
	return { as_of: day, currencies };
}

export async function getIncomeStatement(app: App, from: string | null, to: string | null, currency: Currency | null): Promise<IncomeStatement> {
	const end = to ?? today();
	const start = from ?? `${end.slice(0, 4)}-01-01`; // default: year to date
	if (end < start) invalid("to", "must not be before from");
	const sums = await accountSums(app, start, end, currency, ["revenue", "expense"]);

	const is: IncomeStatement = { from: start, to: end, currencies: [] };
	for (const s of sums) {
		let sec = is.currencies.at(-1);
		if (!sec || sec.currency !== s.currency) {
			sec = { currency: s.currency, revenue: [], expenses: [], total_revenue_cents: 0n, total_expenses_cents: 0n, net_income_cents: 0n };
			is.currencies.push(sec);
		}
		const line = lineOf(s);
		if (s.type === "revenue") {
			sec.revenue.push(line);
			sec.total_revenue_cents += s.natural;
		} else {
			sec.expenses.push(line);
			sec.total_expenses_cents += s.natural;
		}
		sec.net_income_cents = sec.total_revenue_cents - sec.total_expenses_cents;
	}
	return is;
}
