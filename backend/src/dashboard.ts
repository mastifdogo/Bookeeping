// The dashboard: a financial summary per currency, plus notifications and
// to-dos posted by modules (ctx.dashboard) and by Ledger itself.

import type { App } from "./app.ts";
import { queryRow, queryRows, type Queryable } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { today } from "./date.ts";
import { getBalanceSheet, getIncomeStatement } from "./reports.ts";
import { checkText } from "./text.ts";
import { CURRENCIES, type Currency } from "./types.ts";

export type ItemKind = "notification" | "todo";
export type ItemLevel = "info" | "success" | "warning" | "danger";
const LEVELS: readonly ItemLevel[] = ["info", "success", "warning", "danger"];

export interface DashboardItem {
	id: number;
	source: string;
	source_name: string;
	kind: ItemKind;
	key: string;
	title: string;
	body: string;
	level: ItemLevel;
	link: string;
	due_date: string | null;
	created_at: Date;
	updated_at: Date;
	expires_at: Date | null;
	closed_at: Date | null;
	closed_by: string | null;
}

/** What a module (or Ledger) posts. */
export interface ItemInput {
	key?: string;
	title: string;
	body?: string;
	level?: string;
	link?: string;
	/** To-dos: "YYYY-MM-DD". */
	due?: string | null;
	/** Notifications: hide after this time (Date or ISO string). */
	expiresAt?: string | Date | null;
}

const LINK_RE = /^\/(?![/\\])[^\s]{0,299}$/;

function validate(kind: ItemKind, input: ItemInput, needKey: boolean): Required<Omit<ItemInput, "due" | "expiresAt">> & { due: string | null; expiresAt: Date | null } {
	const v = new ValidationError();
	const o = (input ?? {}) as unknown as Record<string, unknown>;
	const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : o[k] === undefined || o[k] === null ? "" : null);
	const key = str("key");
	const title = str("title");
	const body = str("body");
	const level = str("level") || "info";
	const link = str("link");
	if (key === null || (needKey && key === "") || (key !== null && key.length > 100)) v.add("key", needKey ? "is required (1-100 characters)" : "must be at most 100 characters");
	if (title === null) v.add("title", "must be text");
	else checkText(v, "title", title, 1, 200);
	if (body === null) v.add("body", "must be text");
	else checkText(v, "body", body, 0, 2000);
	if (!LEVELS.includes(level as ItemLevel)) v.add("level", "must be info, success, warning or danger");
	if (link === null || (link !== "" && !LINK_RE.test(link))) v.add("link", 'must be a path inside Ledger, e.g. "/apps/invoicing"');
	let due: string | null = null;
	if (kind === "todo" && o.due !== undefined && o.due !== null) {
		if (typeof o.due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.due) || Number.isNaN(Date.parse(o.due))) v.add("due", "must be a date (YYYY-MM-DD)");
		else due = o.due;
	}
	let expiresAt: Date | null = null;
	if (kind === "notification" && o.expiresAt !== undefined && o.expiresAt !== null) {
		const d = o.expiresAt instanceof Date ? o.expiresAt : typeof o.expiresAt === "string" ? new Date(o.expiresAt) : new Date(NaN);
		if (Number.isNaN(d.getTime())) v.add("expiresAt", "must be a date and time");
		else expiresAt = d;
	}
	v.throwIfAny();
	return { key: key!, title: title!.trim(), body: body!.trim(), level, link: link!, due, expiresAt };
}

const ITEM_SELECT = `
	SELECT d.id, d.source, d.kind, d.key, d.title, d.body, d.level, d.link, d.due_date,
	       d.created_at, d.updated_at, d.expires_at, d.closed_at, u.username AS closed_by
	  FROM dashboard_items d LEFT JOIN users u ON u.id = d.closed_by`;

type Row = Omit<DashboardItem, "id" | "source_name"> & { id: bigint };

function toItem(app: App, r: Row): DashboardItem {
	const name = r.source === "ledger" ? "Ledger" : (app.modules.modules.get(r.source)?.manifest.name ?? r.source);
	return { ...r, id: Number(r.id), source_name: name };
}

/**
 * Posts or updates an item. With a key, posting again updates the same item;
 * a notification whose title or text changed shows again even if it was
 * dismissed. Without a key, a notification is always new.
 */
export async function postItem(app: App, source: string, kind: ItemKind, input: ItemInput): Promise<DashboardItem> {
	const x = validate(kind, input, kind === "todo");
	const key = x.key || `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const reopen = kind === "notification" ? "CASE WHEN d.title <> EXCLUDED.title OR d.body <> EXCLUDED.body THEN NULL ELSE d.closed_at END" : "d.closed_at";
	const reopenBy = kind === "notification" ? "CASE WHEN d.title <> EXCLUDED.title OR d.body <> EXCLUDED.body THEN NULL ELSE d.closed_by END" : "d.closed_by";
	const row = await queryRow<{ id: bigint }>(
		app.db,
		`INSERT INTO dashboard_items AS d (source, kind, key, title, body, level, link, due_date, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (source, kind, key) DO UPDATE
		    SET title = EXCLUDED.title, body = EXCLUDED.body, level = EXCLUDED.level, link = EXCLUDED.link,
		        due_date = EXCLUDED.due_date, expires_at = EXCLUDED.expires_at, updated_at = now(),
		        closed_at = ${reopen}, closed_by = ${reopenBy}
		 RETURNING id`,
		[source, kind, key, x.title, x.body, x.level, x.link, x.due, x.expiresAt],
	);
	return getItem(app, row!.id);
}

export async function getItem(app: App, id: bigint | number): Promise<DashboardItem> {
	const r = await queryRow<Row>(app.db, ITEM_SELECT + ` WHERE d.id = $1`, [id]);
	if (!r) throw new NotFoundError();
	return toItem(app, r);
}

/** Closes (dismisses / completes) or reopens an item by id. Reopening applies to to-dos only. */
export async function setItemClosed(app: App, id: bigint, closed: boolean, userId: number | null): Promise<DashboardItem> {
	const r = await app.db.query(
		closed
			? `UPDATE dashboard_items SET closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, $2) WHERE id = $1`
			: `UPDATE dashboard_items SET closed_at = NULL, closed_by = NULL WHERE id = $1 AND kind = 'todo'`,
		closed ? [id, userId] : [id],
	);
	if (r.rowCount === 0) throw new NotFoundError();
	return getItem(app, id);
}

/** For modules: the same, addressed by their own key. */
export async function setClosedByKey(app: App, source: string, kind: ItemKind, key: string, closed: boolean): Promise<boolean> {
	const r = await app.db.query(
		closed
			? `UPDATE dashboard_items SET closed_at = COALESCE(closed_at, now()) WHERE source = $1 AND kind = $2 AND key = $3`
			: `UPDATE dashboard_items SET closed_at = NULL, closed_by = NULL WHERE source = $1 AND kind = $2 AND key = $3`,
		[source, kind, key],
	);
	return (r.rowCount ?? 0) > 0;
}

export async function removeByKey(app: App, source: string, kind: ItemKind, key: string): Promise<boolean> {
	const r = await app.db.query(`DELETE FROM dashboard_items WHERE source = $1 AND kind = $2 AND key = $3`, [source, kind, key]);
	return (r.rowCount ?? 0) > 0;
}

export async function listBySource(app: App, source: string, opts: { kind?: ItemKind; open?: boolean } = {}): Promise<DashboardItem[]> {
	const rows = await queryRows<Row>(
		app.db,
		ITEM_SELECT +
			` WHERE d.source = $1 AND ($2::text IS NULL OR d.kind = $2) AND ($3::boolean IS NULL OR (d.closed_at IS NULL) = $3)
			  ORDER BY d.created_at DESC LIMIT 500`,
		[source, opts.kind ?? null, opts.open ?? null],
	);
	return rows.map((r) => toItem(app, r));
}

/** Old dismissed/done items and expired notifications are deleted as the dashboard is read. */
async function cleanUp(db: Queryable): Promise<void> {
	await db.query(
		`DELETE FROM dashboard_items
		  WHERE (closed_at IS NOT NULL AND closed_at < now() - interval '30 days')
		     OR (expires_at IS NOT NULL AND expires_at < now() - interval '1 day')`,
	);
}

// ---------------------------------------------------------------------------
// The dashboard as a whole
// ---------------------------------------------------------------------------

export interface PeriodSummary {
	from: string;
	to: string;
	revenue_cents: bigint;
	expenses_cents: bigint;
	net_income_cents: bigint;
}

export interface CurrencySummary {
	currency: Currency;
	assets_cents: bigint;
	liabilities_cents: bigint;
	/** Assets minus liabilities. */
	net_worth_cents: bigint;
	month: PeriodSummary;
	year: PeriodSummary;
	/** The largest expense accounts this month. */
	top_expenses: { account_code: string; account_name: string; amount_cents: bigint }[];
}

export async function financialSummary(app: App): Promise<{ as_of: string; currencies: CurrencySummary[] }> {
	const day = today();
	const monthStart = day.slice(0, 8) + "01";
	const yearStart = day.slice(0, 5) + "01-01";
	const [bs, month, year] = await Promise.all([
		getBalanceSheet(app, day, null),
		getIncomeStatement(app, monthStart, day, null),
		getIncomeStatement(app, yearStart, day, null),
	]);
	const period = (is: typeof month, c: Currency, from: string): PeriodSummary => {
		const s = is.currencies.find((x) => x.currency === c);
		return {
			from,
			to: day,
			revenue_cents: s?.total_revenue_cents ?? 0n,
			expenses_cents: s?.total_expenses_cents ?? 0n,
			net_income_cents: s?.net_income_cents ?? 0n,
		};
	};
	const currencies: CurrencySummary[] = [];
	for (const c of CURRENCIES) {
		const b = bs.currencies.find((x) => x.currency === c);
		const m = month.currencies.find((x) => x.currency === c);
		const y = year.currencies.find((x) => x.currency === c);
		if (!b && !m && !y) continue;
		const assets = b?.total_assets_cents ?? 0n;
		const liabilities = b?.total_liabilities_cents ?? 0n;
		currencies.push({
			currency: c,
			assets_cents: assets,
			liabilities_cents: liabilities,
			net_worth_cents: assets - liabilities,
			month: period(month, c, monthStart),
			year: period(year, c, yearStart),
			top_expenses: [...(m?.expenses ?? [])]
				.sort((p, q) => (q.amount_cents > p.amount_cents ? 1 : q.amount_cents < p.amount_cents ? -1 : 0))
				.slice(0, 5),
		});
	}
	return { as_of: day, currencies };
}

export async function getDashboard(app: App) {
	await cleanUp(app.db);
	const [summary, rows] = await Promise.all([
		financialSummary(app),
		queryRows<Row>(
			app.db,
			ITEM_SELECT +
				`
			 WHERE (d.kind = 'notification' AND d.closed_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > now()))
			    OR (d.kind = 'todo' AND (d.closed_at IS NULL OR d.closed_at > now() - interval '7 days'))
			 ORDER BY d.created_at DESC
			 LIMIT 300`,
		),
	]);
	const items = rows.map((r) => toItem(app, r));
	const todos = items
		.filter((i) => i.kind === "todo")
		.sort((a, b) => Number(a.closed_at !== null) - Number(b.closed_at !== null) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
	return { summary, notifications: items.filter((i) => i.kind === "notification"), todos };
}

/**
 * A notification from Ledger itself (updates, backups), for code without an
 * App such as the root updater and `ledger backup run`. Posting again
 * replaces it and shows it again even if it was dismissed.
 */
export async function postLedgerNotice(db: Queryable, n: { key: string; title: string; body: string; level: ItemLevel; link: string }): Promise<void> {
	await db.query(
		`INSERT INTO dashboard_items (source, kind, key, title, body, level, link)
		 VALUES ('ledger', 'notification', $1, $2, $3, $4, $5)
		 ON CONFLICT (source, kind, key) DO UPDATE
		    SET title = EXCLUDED.title, body = EXCLUDED.body, level = EXCLUDED.level, link = EXCLUDED.link,
		        created_at = now(), updated_at = now(), closed_at = NULL, closed_by = NULL`,
		[n.key, n.title.slice(0, 200), n.body.slice(0, 2000), n.level, n.link],
	);
}

/** Hides a Ledger notification (e.g. a backup warning once backups work again). */
export async function closeLedgerNotice(db: Queryable, key: string): Promise<void> {
	await db.query(`UPDATE dashboard_items SET closed_at = now() WHERE source = 'ledger' AND kind = 'notification' AND key = $1 AND closed_at IS NULL`, [key]);
}
