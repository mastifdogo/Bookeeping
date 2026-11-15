import type { App } from "./app.ts";
import { withTx, queryRow, queryRows } from "./db.ts";
import { log } from "./log.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { splitAmount } from "./money.ts";
import { checkText, trimSpace } from "./text.ts";
import { today } from "./date.ts";
import {
	ACCOUNT_CODE_RE,
	ACCOUNT_KINDS,
	KIND_TYPE,
	isAccountType,
	isCurrency,
	type Account,
	type AccountKind,
	type AccountCreate,
	type AccountLedger,
	type AccountType,
	type AccountUpdate,
	type Currency,
	type CurrencyInfo,
	type TrialBalance,
	type TrialBalanceRow,
} from "./types.ts";

const ACCOUNT_SELECT = `
	SELECT a.id, a.code, a.name, a.type, a.currency, a.description, a.is_active, a.kind, a.module_id, a.module_key,
	       COALESCE((SELECT sum(t.amount) FROM transactions t WHERE t.account_id = a.id), 0)::bigint AS balance,
	       (SELECT p.code FROM accounts p WHERE p.id = a.parent_id) AS parent_code,
	       COALESCE((WITH RECURSIVE sub AS (SELECT a.id UNION ALL SELECT c.id FROM accounts c JOIN sub ON c.parent_id = sub.id)
	                 SELECT sum(t.amount) FROM transactions t WHERE t.account_id IN (SELECT id FROM sub)), 0)::bigint AS total_balance,
	       a.created_at, a.updated_at
	  FROM accounts a`;

interface AccountRow {
	id: bigint;
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
	description: string;
	is_active: boolean;
	balance: bigint;
	kind: AccountKind | null;
	module_id: string | null;
	module_key: string | null;
	parent_code: string | null;
	total_balance: bigint;
	created_at: Date;
	updated_at: Date;
}

/** An account plus its internal database id. */
export type AccountWithId = Account & { id: bigint };

function toAccount(r: AccountRow): Account {
	return {
		code: r.code,
		name: r.name,
		type: r.type,
		currency: r.currency,
		description: r.description,
		is_active: r.is_active,
		balance_cents: r.balance,
		kind: r.kind,
		module_id: r.module_id,
		module_key: r.module_key,
		parent_code: r.parent_code,
		total_balance_cents: r.total_balance,
		created_at: r.created_at,
		updated_at: r.updated_at,
	};
}

export async function createAccount(app: App, input: AccountCreate): Promise<Account> {
	const v = new ValidationError();
	const code = trimSpace(input.code);
	if (!ACCOUNT_CODE_RE.test(code)) {
		v.add("code", "must be 1-32 characters: letters, digits, '.', '_' or '-', starting with a letter or digit");
	}
	checkText(v, "name", input.name, 1, 200);
	checkText(v, "description", input.description, 0, 1000);
	if (!isAccountType(input.type)) v.add("type", "must be one of asset, liability, equity, revenue, expense");
	if (!isCurrency(input.currency)) v.add("currency", "must be CAD or USD");
	const kind = checkKind(v, input.kind, input.type);
	v.throwIfAny();
	const parentId = input.parent_code ? await parentFor(app, v, { id: null, code, type: input.type, currency: input.currency }, input.parent_code) : null;
	v.throwIfAny();

	await app.db.query(
		`INSERT INTO accounts (code, name, type, currency, description, parent_id, kind)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[code, trimSpace(input.name), input.type, input.currency, trimSpace(input.description), parentId, kind],
	);
	return getAccount(app, code);
}

/** Checks an account tag against the account's type; returns it (null for none). */
function checkKind(v: ValidationError, kind: string | null | undefined, type: string): AccountKind | null {
	if (kind === null || kind === undefined || kind === "") return null;
	if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
		v.add("kind", `must be one of ${ACCOUNT_KINDS.join(", ")}`);
		return null;
	}
	const k = kind as AccountKind;
	if (!KIND_TYPE[k].includes(type as AccountType)) {
		v.add("kind", `${k.replace("_", " ")} accounts are ${KIND_TYPE[k].join(" or ")} accounts; this one is ${type}`);
		return null;
	}
	return k;
}

export const MAX_ACCOUNT_DEPTH = 5;

/**
 * Checks that `parentCode` can be the parent of an account (new when id is
 * null): it exists, has the same type and currency, isn't the account itself
 * or one of its sub-accounts, and the chart stays at most 5 levels deep.
 * Returns the parent's id, or null after adding the problem to v.
 */
async function parentFor(app: App, v: ValidationError, acc: { id: bigint | null; code: string; type: string; currency: string }, parentCode: string): Promise<bigint | null> {
	const pc = trimSpace(parentCode);
	const p = ACCOUNT_CODE_RE.test(pc) ? await queryRow<{ id: bigint; type: string; currency: string }>(app.db, `SELECT id, type, currency FROM accounts WHERE code = $1`, [pc]) : null;
	if (!p) {
		v.add("parent_code", `there is no account ${pc}`);
		return null;
	}
	if (acc.id !== null && p.id === acc.id) {
		v.add("parent_code", "an account can't be its own parent");
		return null;
	}
	if (p.type !== acc.type || p.currency.trim() !== acc.currency) {
		v.add("parent_code", `must be ${acc.type === "asset" || acc.type === "expense" || acc.type === "equity" ? "an" : "a"} ${acc.type} account in ${acc.currency}, like ${acc.code}`);
		return null;
	}
	// The parent's ancestors (it may not sit under the account itself) and how deep the tree would get.
	const up = await queryRows<{ id: bigint }>(
		app.db,
		`WITH RECURSIVE up AS (SELECT id, parent_id, 1 AS n FROM accounts WHERE id = $1
		                       UNION ALL SELECT a.id, a.parent_id, up.n + 1 FROM accounts a JOIN up ON a.id = up.parent_id WHERE up.n < 20)
		 SELECT id FROM up`,
		[p.id],
	);
	if (acc.id !== null && up.some((r) => r.id === acc.id)) {
		v.add("parent_code", `${pc} is under ${acc.code}; an account can't be under one of its own sub-accounts`);
		return null;
	}
	let below = 0;
	if (acc.id !== null) {
		const d = await queryRow<{ n: number }>(
			app.db,
			`WITH RECURSIVE down AS (SELECT id, 0 AS n FROM accounts WHERE id = $1
			                         UNION ALL SELECT a.id, down.n + 1 FROM accounts a JOIN down ON a.parent_id = down.id WHERE down.n < 20)
			 SELECT max(n)::int AS n FROM down`,
			[acc.id],
		);
		below = d?.n ?? 0;
	}
	if (up.length + 1 + below > MAX_ACCOUNT_DEPTH) {
		v.add("parent_code", `accounts can be nested at most ${MAX_ACCOUNT_DEPTH} levels deep`);
		return null;
	}
	return p.id;
}

async function getAccountRow(app: App, code: string): Promise<AccountRow> {
	if (!ACCOUNT_CODE_RE.test(code)) throw new NotFoundError();
	const row = await queryRow<AccountRow>(app.db, ACCOUNT_SELECT + ` WHERE a.code = $1`, [code]);
	if (!row) throw new NotFoundError();
	return row;
}

export async function getAccount(app: App, code: string): Promise<Account> {
	return toAccount(await getAccountRow(app, code));
}

export async function listAccounts(app: App, includeInactive: boolean): Promise<Account[]> {
	const rows = await queryRows<AccountRow>(app.db, ACCOUNT_SELECT + ` WHERE $1 OR a.is_active ORDER BY a.code`, [includeInactive]);
	return rows.map(toAccount);
}

/** Columns of module tables that hold an account code, by the documented naming: account_code, or ending in _account_code or _account. */
const CODE_COLUMN = /^(account_code|[a-z0-9_]*_account_code|[a-z0-9_]*_account)$/;

/**
 * Gives an account a new code. Journal lines point at the account itself, so
 * the books don't change. The code is also rewritten where modules keep it:
 * in their tables (columns named account_code, *_account_code or *_account)
 * and in their settings (text values under a key with "account" in it), so
 * a module set to post to the old code keeps posting to the same account.
 * All of it happens together or not at all.
 */
export async function changeAccountCode(app: App, code: string, newCode: string, userId: number | null): Promise<{ old_code: string; new_code: string; modules: string[] }> {
	const v = new ValidationError();
	const next = trimSpace(newCode);
	if (!ACCOUNT_CODE_RE.test(next)) v.add("code", "must be 1-32 letters, digits, dots, dashes or underscores, starting with a letter or digit");
	v.throwIfAny();
	const touched = new Set<string>();
	await withTx(app.db, {}, async (tx) => {
		const cur = await queryRow<{ id: bigint; code: string }>(tx, `SELECT id, code FROM accounts WHERE code = $1 FOR UPDATE`, [code]);
		if (!cur) throw new NotFoundError();
		if (cur.code === next) return;
		const taken = await queryRow<{ name: string }>(tx, `SELECT name FROM accounts WHERE code = $1`, [next]);
		if (taken) {
			v.add("code", `${next} is already the code of "${taken.name}"`);
			v.throwIfAny();
		}
		await tx.query(`UPDATE accounts SET code = $2 WHERE id = $1`, [cur.id, next]);
		await tx.query(`INSERT INTO account_code_changes (account_id, old_code, new_code, changed_by) VALUES ($1, $2, $3, $4)`, [cur.id, cur.code, next, userId]);

		// Module tables.
		const cols = await queryRows<{ table_schema: string; table_name: string; column_name: string }>(
			tx,
			`SELECT c.table_schema, c.table_name, c.column_name
			   FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
			  WHERE c.table_schema ~ '^mod_[a-z0-9_]+$' AND t.table_type = 'BASE TABLE' AND c.data_type IN ('text', 'character varying')`,
		);
		const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
		for (const c of cols.filter((x) => CODE_COLUMN.test(x.column_name))) {
			const r = await tx.query(`UPDATE ${ident(c.table_schema)}.${ident(c.table_name)} SET ${ident(c.column_name)} = $2 WHERE ${ident(c.column_name)} = $1`, [cur.code, next]);
			if ((r.rowCount ?? 0) > 0) touched.add(c.table_schema.slice(4).replace(/_/g, "-"));
		}
		// Module settings: account codes are text settings such as receivable_account.
		const settings = await queryRows<{ module_id: string; values: Record<string, unknown> }>(tx, `SELECT module_id, "values" FROM module_settings FOR UPDATE`);
		for (const s of settings) {
			let changed = false;
			for (const [k, val] of Object.entries(s.values)) {
				if (val === cur.code && /account/i.test(k)) {
					s.values[k] = next;
					changed = true;
				}
			}
			if (changed) {
				await tx.query(`UPDATE module_settings SET "values" = $2::jsonb, updated_at = now() WHERE module_id = $1`, [s.module_id, JSON.stringify(s.values)]);
				touched.add(s.module_id);
			}
		}
	});
	return { old_code: code, new_code: next, modules: [...touched].sort() };
}

export async function updateAccount(app: App, code: string, input: AccountUpdate, userId: number | null = null): Promise<Account> {
	const v = new ValidationError();
	if (input.code !== undefined) {
		const rest = input.name !== undefined || input.description !== undefined || input.is_active !== undefined || input.parent_code !== undefined || input.kind !== undefined;
		const done = await changeAccountCode(app, code, input.code, userId);
		code = done.new_code;
		for (const m of app.modules.modules.values()) {
			if (m.error) continue;
			for (const fn of m.accountCodeListeners) {
				Promise.resolve()
					.then(() => fn({ old_code: done.old_code, new_code: done.new_code }))
					.catch((err: Error) => log.error("module account-code listener failed", { module: m.manifest.id, err: err.message }));
			}
		}
		if (!rest) return getAccount(app, code);
	}
	if (input.name === undefined && input.description === undefined && input.is_active === undefined && input.parent_code === undefined && input.kind === undefined) {
		v.add("", "at least one of code, name, description, is_active, parent_code, kind is required");
	}
	if (input.name !== undefined) checkText(v, "name", input.name, 1, 200);
	if (input.description !== undefined) checkText(v, "description", input.description, 0, 1000);
	v.throwIfAny();
	let kind: AccountKind | null = null;
	if (input.kind) {
		kind = checkKind(v, input.kind, (await getAccountRow(app, code)).type);
		v.throwIfAny();
	}
	let parentId: bigint | null = null;
	if (input.parent_code) {
		const cur = await getAccountRow(app, code);
		parentId = await parentFor(app, v, { id: cur.id, code: cur.code, type: cur.type, currency: cur.currency }, input.parent_code);
		v.throwIfAny();
	}

	const r = await app.db.query(
		`UPDATE accounts
		    SET name        = COALESCE($2, name),
		        description = COALESCE($3, description),
		        is_active   = COALESCE($4, is_active),
		        parent_id   = CASE WHEN $5 THEN $6::bigint ELSE parent_id END,
		        kind        = CASE WHEN $7 THEN $8::text ELSE kind END
		  WHERE code = $1`,
		[
			code,
			input.name === undefined ? null : trimSpace(input.name),
			input.description === undefined ? null : trimSpace(input.description),
			input.is_active ?? null,
			input.parent_code !== undefined,
			parentId,
			input.kind !== undefined,
			kind,
		],
	);
	if (r.rowCount === 0) throw new NotFoundError();
	return getAccount(app, code);
}

/** The supported currencies. */
export async function listCurrencies(app: App): Promise<CurrencyInfo[]> {
	return queryRows<CurrencyInfo>(app.db, `SELECT code, name, minor_units FROM currencies ORDER BY code`);
}

/**
 * An account's postings in [from, to] with an opening balance (everything
 * before from) and a running balance per line. All amounts are in the
 * account's currency.
 */
export async function getAccountLedger(app: App, code: string, from: string | null, to: string | null): Promise<AccountLedger> {
	const acc = await getAccountRow(app, code);

	// One REPEATABLE READ snapshot so the opening balance and lines agree.
	return withTx(app.db, { isolation: "REPEATABLE READ", readOnly: true }, async (tx) => {
		let opening = 0n;
		if (from !== null) {
			const row = await queryRow<{ sum: bigint }>(
				tx,
				`SELECT COALESCE(sum(t.amount), 0)::bigint AS sum
				   FROM transactions t JOIN journal_entries e ON e.id = t.journal_entry_id
				  WHERE t.account_id = $1 AND e.entry_date < $2`,
				[acc.id, from],
			);
			opening = row!.sum;
		}
		const rows = await queryRows<{
			entry_id: bigint;
			line_id: bigint;
			entry_date: string;
			description: string;
			reference: string;
			memo: string;
			amount: bigint;
		}>(
			tx,
			`SELECT e.id AS entry_id, t.id AS line_id, e.entry_date, e.description, e.reference, t.memo, t.amount
			   FROM transactions t JOIN journal_entries e ON e.id = t.journal_entry_id
			  WHERE t.account_id = $1
			    AND ($2::date IS NULL OR e.entry_date >= $2)
			    AND ($3::date IS NULL OR e.entry_date <= $3)
			  ORDER BY e.entry_date, e.id, t.line_number`,
			[acc.id, from, to],
		);
		let running = opening;
		const lines = rows.map((r) => {
			running += r.amount;
			const [debit, credit] = splitAmount(r.amount);
			return {
				journal_entry_id: Number(r.entry_id),
				line_id: Number(r.line_id),
				entry_date: r.entry_date,
				description: r.description,
				reference: r.reference,
				memo: r.memo,
				debit_cents: debit,
				credit_cents: credit,
				running_balance_cents: running,
			};
		});
		return { account: toAccount(acc), opening_balance_cents: opening, closing_balance_cents: running, lines };
	});
}

/**
 * The balance of every account with postings on or before asOf, split into
 * debit and credit columns, with totals per currency. Amounts in different
 * currencies are never added together.
 */
export async function getTrialBalance(app: App, asOf: string | null, currency: Currency | null): Promise<TrialBalance> {
	const day = asOf ?? today();
	const rows = await queryRows<{ code: string; name: string; type: AccountType; currency: Currency; balance: bigint }>(
		app.db,
		`SELECT a.code, a.name, a.type, a.currency, sum(t.amount)::bigint AS balance
		   FROM accounts a
		   JOIN transactions t    ON t.account_id = a.id
		   JOIN journal_entries e ON e.id = t.journal_entry_id
		  WHERE e.entry_date <= $1
		    AND ($2::text IS NULL OR a.currency = $2)
		  GROUP BY a.id
		  ORDER BY a.currency, a.code`,
		[day, currency],
	);
	const tb: TrialBalance = { as_of: day, rows: [], totals: [] };
	for (const r of rows) {
		const [debit, credit] = splitAmount(r.balance);
		const row: TrialBalanceRow = {
			account_code: r.code,
			account_name: r.name,
			account_type: r.type,
			currency: r.currency,
			debit_cents: debit,
			credit_cents: credit,
		};
		// Rows are ordered by currency, so totals are built in order.
		let t = tb.totals.at(-1);
		if (!t || t.currency !== r.currency) {
			t = { currency: r.currency, debit_cents: 0n, credit_cents: 0n };
			tb.totals.push(t);
		}
		t.debit_cents += debit;
		t.credit_cents += credit;
		tb.rows.push(row);
	}
	return tb;
}

/**
 * A module's own clearing account: found by the module and its key (and
 * currency), whatever code it has now, and made the first time it is asked
 * for. One side of a transaction is posted there and the other side later,
 * so the account comes back to zero.
 */
export async function ensureClearingAccount(
	app: App,
	moduleId: string,
	moduleName: string,
	input: { key: string; name: string; currency: string; type?: string; description?: string },
): Promise<Account> {
	const v = new ValidationError();
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const key = typeof o.key === "string" ? o.key : "";
	if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key)) v.add("key", "must be lowercase letters, digits, _ or - (up to 40), starting with a letter");
	const type = o.type === undefined ? "asset" : o.type;
	if (type !== "asset" && type !== "liability") v.add("type", "a clearing account is an asset or a liability account");
	if (typeof o.name !== "string") v.add("name", "is required");
	else checkText(v, "name", o.name, 1, 200);
	if (!isCurrency(o.currency as string)) v.add("currency", "must be CAD or USD");
	if (o.description !== undefined && typeof o.description !== "string") v.add("description", "must be text");
	v.throwIfAny();
	const find = () => queryRow<AccountRow>(app.db, ACCOUNT_SELECT + ` WHERE a.module_id = $1 AND a.module_key = $2 AND a.currency = $3`, [moduleId, key, o.currency]);
	const found = await find();
	if (found) return toAccount(found);
	// A code that says what it is; a person can change it afterwards.
	const base = `CLR-${moduleId}-${key}`.toUpperCase().replace(/[^A-Z0-9._-]/g, "-").slice(0, 26);
	for (let n = 0; n < 50; n++) {
		const code = n === 0 ? `${base}${o.currency === "CAD" ? "" : `-${o.currency}`}`.slice(0, 32) : `${base}-${n + 1}`.slice(0, 32);
		{
			const r = await app.db.query(
				`INSERT INTO accounts (code, name, type, currency, description, kind, module_id, module_key) VALUES ($1, $2, $3, $4, $5, 'clearing', $6, $7)
				 ON CONFLICT DO NOTHING`,
				[code, trimSpace(o.name as string), type, o.currency, trimSpace((o.description as string | undefined) ?? `Clearing account of ${moduleName}: what is posted here is cleared again later, so its balance returns to zero.`), moduleId, key],
			);
			const made = await find();
			if (made) return toAccount(made);
			if ((r.rowCount ?? 0) === 0) continue; // the code is taken: try the next
		}
	}
	throw new ConflictError(`could not find a free code for the clearing account ${key}`);
}

/** Every clearing account (whoever made it), with what is sitting in it, for modules and the Accounts page. */
export async function listClearingAccounts(app: App): Promise<Account[]> {
	return (await queryRows<AccountRow>(app.db, ACCOUNT_SELECT + ` WHERE a.kind = 'clearing' ORDER BY a.code`)).map(toAccount);
}
