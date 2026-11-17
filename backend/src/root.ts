// Root mode: what an admin can do with root mode on (Settings → Account)
// that Ledger otherwise refuses — change an account's type or currency,
// delete an account with everything posted to it, rename or delete a user.
//
// Each action runs in one database transaction that sets ledger.root = 'on'
// (the database guards step aside only for it) and writes a root_actions
// row holding everything it changed or deleted, copied inside the database
// (never through JavaScript, so amounts and ids keep their exact values).
// Reversing an action puts those rows back.

import type { Pool } from "pg";
import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { formatCents } from "./money.ts";
import { inOrg, listOrganizations, MAIN_ORG } from "./orgs.ts";
import { ACCOUNT_TYPES, isCurrency, type AccountType, type User } from "./types.ts";
import { syncUnreconciledLater } from "./unreconciled.ts";

export type RootAction = {
	id: number;
	/** "books": the current organization's accounts; "users": people who log in. */
	scope: "books" | "users";
	action: "account.update" | "account.delete" | "user.update" | "user.delete" | "entry.delete" | "line.delete" | "line.update" | "module.delete" | "module.update";
	target: string;
	summary: string;
	done_by: string;
	done_at: Date;
	reversed_by: string | null;
	reversed_at: Date | null;
};

/** Refuses unless root mode is on for this admin's session. */
export function requireRoot(user: User, serverAdmin = false): void {
	if (!user.root || user.role !== "admin") throw new HttpError(403, "turn on root mode under Settings → Account first", "forbidden");
	if (serverAdmin && !user.server_admin) throw new HttpError(403, "only admins of the main books can change users in root mode", "forbidden");
}

const asRoot = (tx: Queryable) => tx.query(`SELECT set_config('ledger.root', 'on', true)`);

/** Who is acting: their name and the root session it belongs to. */
type Who = { username: string; root_session?: string | null };

async function begin(tx: Queryable, action: RootAction["action"], target: string, summary: string, who: Who, undo: Record<string, unknown> = {}): Promise<bigint> {
	await asRoot(tx);
	const r = await queryRow<{ id: bigint }>(tx, `INSERT INTO root_actions (action, target, summary, undo, done_by, session) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`, [
		action,
		target,
		summary.slice(0, 1000),
		JSON.stringify(undo),
		who.username,
		who.root_session ?? null,
	]);
	return r!.id;
}

/** Copies the rows `select` returns (placeholders from $2) into the action's undo under key. */
async function keep(tx: Queryable, id: bigint, key: string, select: string, params: unknown[] = []): Promise<void> {
	await tx.query(`UPDATE root_actions SET undo = undo || jsonb_build_object('${key}', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (${select}) t)) WHERE id = $1`, [id, ...params]);
}

/** Inserts the rows kept under key back into table, with their own ids. */
async function putBack(tx: Queryable, id: bigint, table: string, key: string): Promise<void> {
	await tx.query(
		`INSERT INTO ${table} OVERRIDING SYSTEM VALUE
		 SELECT * FROM jsonb_populate_recordset(NULL::${table}, (SELECT coalesce(undo->'${key}', '[]'::jsonb) FROM root_actions WHERE id = $1))`,
		[id],
	);
}

// ---------------------------------------------------------------------------
// Bookkeeping accounts
// ---------------------------------------------------------------------------

/** The entries with a line in the account, plus the reversals of those and the entries they reverse. */
async function entriesOf(tx: Queryable, accountId: bigint): Promise<bigint[]> {
	let ids = (await queryRows<{ id: bigint }>(tx, `SELECT DISTINCT journal_entry_id AS id FROM transactions WHERE account_id = $1`, [accountId])).map((r) => r.id);
	for (let i = 0; i < 10; i++) {
		const more = await queryRows<{ id: bigint }>(
			tx,
			`SELECT id FROM journal_entries WHERE reverses_id = ANY($1::bigint[]) AND NOT (id = ANY($1::bigint[]))
			 UNION SELECT reverses_id FROM journal_entries WHERE id = ANY($1::bigint[]) AND reverses_id IS NOT NULL AND NOT (reverses_id = ANY($1::bigint[]))`,
			[ids],
		);
		if (more.length === 0) break;
		ids = [...ids, ...more.map((r) => r.id)];
	}
	return ids;
}

export interface DeletePreview {
	code: string;
	name: string;
	entries: number;
	lines: number;
	reconciliations: number;
	sub_accounts: number;
}

/** What deleting the account would delete with it. */
export async function previewAccountDelete(app: App, code: string): Promise<DeletePreview> {
	const acc = await queryRow<{ id: bigint; code: string; name: string }>(app.db, `SELECT id, code, name FROM accounts WHERE code = $1`, [code]);
	if (!acc) throw new NotFoundError();
	const entries = await entriesOf(app.db, acc.id);
	const n = await queryRow<{ lines: bigint; recs: bigint; subs: bigint }>(
		app.db,
		`SELECT (SELECT count(*) FROM transactions WHERE journal_entry_id = ANY($2::bigint[])) AS lines,
		        (SELECT count(*) FROM reconciliations WHERE account_id = $1) AS recs,
		        (SELECT count(*) FROM accounts WHERE parent_id = $1) AS subs`,
		[acc.id, entries],
	);
	return { code: acc.code, name: acc.name, entries: entries.length, lines: Number(n!.lines), reconciliations: Number(n!.recs), sub_accounts: Number(n!.subs) };
}

/**
 * Deletes an account and every journal entry with a line in it (whole
 * entries, with their reversals), its reconciliations and the logs that
 * point at them. Sub-accounts move to the top level. Kept for reversing.
 */
export async function rootDeleteAccount(app: App, code: string, user: User): Promise<RootAction> {
	const p = await previewAccountDelete(app, code);
	const id = await withTx(app.db, {}, async (tx) => {
		const acc = await queryRow<{ id: bigint }>(tx, `SELECT id FROM accounts WHERE code = $1 FOR UPDATE`, [code]);
		if (!acc) throw new NotFoundError();
		const a = acc.id;
		const e = await entriesOf(tx, a);
		const id = await begin(
			tx,
			"account.delete",
			code,
			`Deleted account ${p.code} ${p.name}` + (e.length ? ` and ${e.length} journal entr${e.length === 1 ? "y" : "ies"} (${p.lines} lines)` : "") + (p.reconciliations ? `, ${p.reconciliations} reconciliation${p.reconciliations === 1 ? "" : "s"}` : ""),
			user,
		);
		const lines = `SELECT id FROM transactions WHERE journal_entry_id = ANY($3::bigint[])`;
		const recs = `SELECT id FROM reconciliations WHERE account_id = $2`;
		await keep(tx, id, "account", `SELECT * FROM accounts WHERE id = $2`, [a]);
		await keep(tx, id, "children", `SELECT id FROM accounts WHERE parent_id = $2`, [a]);
		await keep(tx, id, "documents", `SELECT id FROM documents WHERE account_id = $2`, [a]);
		await keep(tx, id, "entries", `SELECT * FROM journal_entries WHERE id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "lines", `SELECT * FROM transactions WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "recs", `SELECT * FROM reconciliations WHERE account_id = $2`, [a]);
		await keep(tx, id, "rec_lines", `SELECT * FROM reconciliation_lines WHERE reconciliation_id IN (${recs}) OR transaction_id IN (${lines})`, [a, e]);
		await keep(tx, id, "amounts", `SELECT * FROM transaction_changes WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "moves", `SELECT * FROM transaction_moves WHERE journal_entry_id = ANY($3::bigint[]) OR old_account_id = $2 OR new_account_id = $2`, [a, e]);
		await keep(tx, id, "dates", `SELECT * FROM journal_entry_date_changes WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "links", `SELECT * FROM journal_entry_links WHERE entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "code_changes", `SELECT * FROM account_code_changes WHERE account_id = $2`, [a]);
		await keep(tx, id, "tags", `SELECT * FROM journal_entry_tags WHERE entry_id = ANY($2::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = ANY($1::bigint[])`, [e]);

		await tx.query(
			`DELETE FROM reconciliation_lines WHERE reconciliation_id IN (SELECT id FROM reconciliations WHERE account_id = $1)
			    OR transaction_id IN (SELECT id FROM transactions WHERE journal_entry_id = ANY($2::bigint[]))`,
			[a, e],
		);
		await tx.query(`DELETE FROM reconciliations WHERE account_id = $1`, [a]);
		await tx.query(`DELETE FROM transaction_changes WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM transaction_moves WHERE journal_entry_id = ANY($2::bigint[]) OR old_account_id = $1 OR new_account_id = $1`, [a, e]);
		await tx.query(`DELETE FROM journal_entry_date_changes WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entry_links WHERE entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM transactions WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entries WHERE id = ANY($1::bigint[]) AND reverses_id IS NOT NULL`, [e]);
		await tx.query(`DELETE FROM journal_entries WHERE id = ANY($1::bigint[])`, [e]);
		await tx.query(`UPDATE accounts SET parent_id = NULL WHERE parent_id = $1`, [a]);
		await tx.query(`DELETE FROM accounts WHERE id = $1`, [a]);
		return id;
	});
	await syncUnreconciledLater(app);
	return getAction(app.db, "books", id);
}

/** Changes what Ledger otherwise keeps fixed on an account with postings: its type (and its currency, while it has none). */
export async function rootUpdateAccount(app: App, code: string, input: { type?: string; currency?: string }, user: User): Promise<RootAction> {
	const v = new ValidationError();
	if (input.type !== undefined && !(ACCOUNT_TYPES as readonly string[]).includes(input.type)) v.add("type", `must be one of ${ACCOUNT_TYPES.join(", ")}`);
	if (input.currency !== undefined && !isCurrency(input.currency)) v.add("currency", "must be CAD or USD");
	if (input.type === undefined && input.currency === undefined) v.add("", "give a type or a currency");
	v.throwIfAny();
	const id = await withTx(app.db, {}, async (tx) => {
		const acc = await queryRow<{ id: bigint; code: string; name: string; type: AccountType; currency: string; lines: boolean }>(
			tx,
			`SELECT a.id, a.code, a.name, a.type, a.currency, EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id) AS lines FROM accounts a WHERE a.code = $1 FOR UPDATE`,
			[code],
		);
		if (!acc) throw new NotFoundError();
		const type = input.type ?? acc.type;
		const currency = input.currency ?? acc.currency.trim();
		if (type === acc.type && currency === acc.currency.trim()) {
			v.add("", "that is what it is already");
			v.throwIfAny();
		}
		if (currency !== acc.currency.trim() && acc.lines) {
			throw new ConflictError(`${acc.code} has lines in ${acc.currency.trim()}; its currency can't change while it has postings (each entry must balance in its own currency). Delete them or the account instead.`);
		}
		const what = [type !== acc.type ? `type ${acc.type} → ${type}` : "", currency !== acc.currency.trim() ? `currency ${acc.currency.trim()} → ${currency}` : ""].filter(Boolean).join(", ");
		const id = await begin(tx, "account.update", code, `Changed account ${acc.code} ${acc.name}: ${what}`, user);
		await keep(tx, id, "before", `SELECT * FROM accounts WHERE id = $2`, [acc.id]);
		await keep(tx, id, "children", `SELECT id, parent_id FROM accounts WHERE parent_id = $2`, [acc.id]);
		// A sub-account sits under an account of its own type and currency, and a tag fits the type: what no longer fits comes loose.
		await tx.query(
			`UPDATE accounts SET type = $2::text::account_type, currency = $3::text,
			        kind = CASE WHEN kind IS NULL OR (kind IN ('chequing', 'savings') AND $2::text = 'asset') OR (kind = 'credit_card' AND $2::text = 'liability') OR (kind = 'clearing' AND $2::text IN ('asset', 'liability')) THEN kind END,
			        parent_id = CASE WHEN parent_id IS NULL OR EXISTS (SELECT 1 FROM accounts p WHERE p.id = accounts.parent_id AND p.type::text = $2::text AND btrim(p.currency) = $3::text) THEN parent_id END
			  WHERE id = $1`,
			[acc.id, type, currency],
		);
		await tx.query(`UPDATE accounts SET parent_id = NULL WHERE parent_id = $1 AND (type::text <> $2 OR btrim(currency) <> $3)`, [acc.id, type, currency]);
		return id;
	});
	return getAction(app.db, "books", id);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Every database: the main one and each ready organization's. */
async function databases(app: App): Promise<{ name: string; db: Pool }[]> {
	const out: { name: string; db: Pool }[] = [];
	for (const o of await listOrganizations(app)) {
		if (o.id === MAIN_ORG || o.status !== "ready") continue;
		out.push({ name: o.db_name, db: app.orgs.forDb(o.db_name) });
	}
	return out;
}

/** Columns in this database that point at users and don't go with the user (not ON DELETE CASCADE), with their table's primary key. */
async function userRefs(tx: Queryable): Promise<{ table: string; column: string; key: string }[]> {
	return queryRows(
		tx,
		`SELECT format('%I.%I', n.nspname, c.relname) AS table, a.attname AS column,
		        (SELECT format('%I', ka.attname) FROM pg_index i JOIN pg_attribute ka ON ka.attrelid = i.indrelid AND ka.attnum = i.indkey[0]
		          WHERE i.indrelid = c.oid AND i.indisprimary AND i.indnatts = 1) AS key
		   FROM pg_constraint k
		   JOIN pg_class c ON c.oid = k.conrelid
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		   JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
		  WHERE k.contype = 'f' AND k.confrelid = 'public.users'::regclass AND k.confdeltype <> 'c' AND array_length(k.conkey, 1) = 1
		  ORDER BY 1, 2`,
	);
}

/** Takes the user out of one database, keeping what it took for reversing. Returns the action id. */
async function removeUserFrom(db: Pool, userId: bigint, username: string, by: Who, summary: string, partOf: number | null): Promise<bigint> {
	return withTx(db, {}, async (tx) => {
		const id = await begin(tx, "user.delete", username, summary, by, partOf === null ? {} : { part_of: partOf });
		await keep(tx, id, "user", `SELECT * FROM users WHERE id = $2`, [userId]);
		await keep(tx, id, "user_settings", `SELECT * FROM user_settings WHERE user_id = $2`, [userId]);
		await keep(tx, id, "memberships", `SELECT * FROM memberships WHERE user_id = $2`, [userId]);
		for (const r of await userRefs(tx)) {
			if (!r.key) {
				await tx.query(`UPDATE ${r.table} SET ${r.column} = NULL WHERE ${r.column} = $1`, [userId]);
				continue;
			}
			await tx.query(
				`UPDATE root_actions SET undo = jsonb_set(undo, '{refs}', coalesce(undo->'refs', '[]'::jsonb) ||
				        jsonb_build_array(jsonb_build_object('t', $2::text, 'c', $3::text, 'k', $4::text,
				          'ids', (SELECT coalesce(jsonb_agg(${r.key}::text), '[]'::jsonb) FROM ${r.table} WHERE ${r.column} = $5))))
				  WHERE id = $1`,
				[id, r.table, r.column, r.key, userId],
			);
			await tx.query(`UPDATE ${r.table} SET ${r.column} = NULL WHERE ${r.column} = $1`, [userId]);
		}
		await tx.query(`DELETE FROM users WHERE id = $1`, [userId]);
		return id;
	});
}

/**
 * Deletes a user from the main database and every organization's. What
 * pointed at them (who posted an entry, who changed it, ...) is set to
 * nobody and remembered, so reversing puts it all back.
 */
export async function rootDeleteUser(app: App, username: string, user: User): Promise<RootAction> {
	const u = await queryRow<{ id: bigint; username: string; role: string; is_active: boolean }>(app.main, `SELECT id, username, role, is_active FROM users WHERE username = $1`, [username]);
	if (!u) throw new NotFoundError();
	if (Number(u.id) === user.id) throw new ConflictError("you can't delete yourself");
	if (u.role === "admin" && u.is_active) {
		const others = await queryRow<{ n: bigint }>(app.main, `SELECT count(*) AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1`, [u.id]);
		if ((others?.n ?? 0n) === 0n) throw new ConflictError("Ledger needs at least one active admin; make someone else an admin first");
	}
	const summary = `Deleted user ${u.username} (${u.role})`;
	const done: { db: string; id: number }[] = [];
	try {
		for (const d of await databases(app)) {
			const has = await queryRow(d.db, `SELECT 1 FROM users WHERE id = $1`, [u.id]);
			if (has) done.push({ db: d.name, id: Number(await removeUserFrom(d.db, u.id, u.username, user, summary, -1)) });
		}
		const id = await removeUserFrom(app.main, u.id, u.username, user, summary, null);
		await app.main.query(`UPDATE root_actions SET undo = undo || jsonb_build_object('orgs', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(done)]);
		return getAction(app.main, "users", id);
	} catch (err) {
		// The main database refused: put the user back where they were already taken out.
		for (const o of done) await reverseUserDelete(app.orgs.forDb(o.db), BigInt(o.id), user.username).catch((e: Error) => log.error("root: putting a user back failed", { db: o.db, err: e.message }));
		throw err;
	}
}

/** Renames a user everywhere (their sessions keep working). */
export async function rootRenameUser(app: App, username: string, newName: string, user: User): Promise<RootAction> {
	const next = newName.trim().toLowerCase();
	const v = new ValidationError();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(next)) v.add("username", "must be 1-64 characters: lowercase letters, digits, '.', '_' or '-'");
	v.throwIfAny();
	const id = await withTx(app.main, {}, async (tx) => {
		const u = await queryRow<{ id: bigint; username: string }>(tx, `SELECT id, username FROM users WHERE username = $1 FOR UPDATE`, [username]);
		if (!u) throw new NotFoundError();
		if (u.username === next) {
			v.add("username", "is the same as before");
			v.throwIfAny();
		}
		if (await queryRow(tx, `SELECT 1 FROM users WHERE username = $1`, [next])) {
			v.add("username", `${next} is taken`);
			v.throwIfAny();
		}
		const id = await begin(tx, "user.update", u.username, `Renamed user ${u.username} to ${next}`, user, { user_id: String(u.id), before: u.username, after: next });
		await tx.query(`UPDATE users SET username = $2 WHERE id = $1`, [u.id, next]);
		return id;
	});
	await renameCopies(app, username, next);
	return getAction(app.main, "users", id);
}

async function renameCopies(app: App, from: string, to: string): Promise<void> {
	for (const d of await databases(app)) await d.db.query(`UPDATE users SET username = $2 WHERE username = $1`, [from, to]);
}

async function reverseUserDelete(db: Pool, id: bigint, by: string): Promise<void> {
	await withTx(db, {}, async (tx) => {
		await asRoot(tx);
		await putBack(tx, id, "users", "user");
		await putBack(tx, id, "user_settings", "user_settings");
		await putBack(tx, id, "memberships", "memberships");
		const a = await queryRow<{ uid: bigint; refs: { t: string; c: string; k: string; ids: string[] }[] | null }>(tx, `SELECT (undo->'user'->0->>'id')::bigint AS uid, undo->'refs' AS refs FROM root_actions WHERE id = $1`, [id]);
		for (const r of a?.refs ?? []) {
			if (!/^[a-z0-9_".]+$/i.test(r.t) || !/^[a-z0-9_"]+$/i.test(r.c) || !/^[a-z0-9_"]+$/i.test(r.k)) continue;
			if (r.ids.length) await tx.query(`UPDATE ${r.t} SET ${r.c} = $1 WHERE ${r.k}::text = ANY($2::text[])`, [a!.uid, r.ids]);
		}
		await tx.query(`UPDATE root_actions SET reversed_at = now(), reversed_by = $2 WHERE id = $1`, [id, by]);
	});
}

// ---------------------------------------------------------------------------
// The log, and reversing
// ---------------------------------------------------------------------------

const ACTION_SELECT = `SELECT id, action, target, summary, done_by, done_at, reversed_by, reversed_at FROM root_actions`;
type ActionRow = Omit<RootAction, "id" | "scope"> & { id: bigint };

async function getAction(db: Queryable, scope: RootAction["scope"], id: bigint): Promise<RootAction> {
	const r = await queryRow<ActionRow>(db, ACTION_SELECT + ` WHERE id = $1`, [id]);
	if (!r) throw new NotFoundError();
	return { ...r, id: Number(r.id), scope };
}

/** Root actions on this organization's books, and on users. */
export async function listRootActions(app: App): Promise<RootAction[]> {
	const books = await queryRows<ActionRow>(app.db, ACTION_SELECT + ` WHERE action NOT LIKE 'user.%' ORDER BY id DESC LIMIT 500`);
	const users = await queryRows<ActionRow>(app.main, ACTION_SELECT + ` WHERE action LIKE 'user.%' AND NOT undo ? 'part_of' ORDER BY id DESC LIMIT 500`);
	return [...books.map((r) => ({ ...r, id: Number(r.id), scope: "books" as const })), ...users.map((r) => ({ ...r, id: Number(r.id), scope: "users" as const }))].sort(
		(a, b) => new Date(b.done_at).getTime() - new Date(a.done_at).getTime(),
	);
}

/** Puts back what a root action changed or deleted. */
export async function reverseRootAction(app: App, scope: RootAction["scope"], id: bigint, user: { username: string }): Promise<RootAction> {
	const db = scope === "books" ? app.db : app.main;
	const a = await queryRow<{ action: RootAction["action"]; reversed_at: Date | null; part_of: string | null }>(db, `SELECT action, reversed_at, undo->>'part_of' AS part_of FROM root_actions WHERE id = $1`, [id]);
	if (!a || (scope === "users") !== a.action.startsWith("user.") || a.part_of !== null) throw new NotFoundError();
	if (a.reversed_at) throw new ConflictError("this root action was already reversed");
	if (a.action === "user.delete") {
		await reverseUserDelete(app.main, id, user.username);
		const orgs = (await queryRow<{ orgs: { db: string; id: number }[] | null }>(app.main, `SELECT undo->'orgs' AS orgs FROM root_actions WHERE id = $1`, [id]))?.orgs ?? [];
		for (const o of orgs) await reverseUserDelete(app.orgs.forDb(o.db), BigInt(o.id), user.username);
		return getAction(db, scope, id);
	}
	if (a.action === "user.update") {
		const r = await queryRow<{ before: string; after: string }>(app.main, `SELECT undo->>'before' AS before, undo->>'after' AS after FROM root_actions WHERE id = $1`, [id]);
		await withTx(app.main, {}, async (tx) => {
			const now = await queryRow(tx, `SELECT 1 FROM users WHERE username = $1 FOR UPDATE`, [r!.after]);
			if (!now) throw new ConflictError(`there is no user ${r!.after} any more`);
			if (await queryRow(tx, `SELECT 1 FROM users WHERE username = $1`, [r!.before])) throw new ConflictError(`${r!.before} is taken by another user now`);
			await tx.query(`UPDATE users SET username = $2 WHERE username = $1`, [r!.after, r!.before]);
			await tx.query(`UPDATE root_actions SET reversed_at = now(), reversed_by = $2 WHERE id = $1`, [id, user.username]);
		});
		await renameCopies(app, r!.after, r!.before);
		return getAction(db, scope, id);
	}
	await withTx(app.db, {}, async (tx) => {
		await asRoot(tx);
		if (a.action === "account.update") {
			const gone = await queryRow<{ gone: boolean }>(tx, `SELECT NOT EXISTS (SELECT 1 FROM accounts WHERE id = (SELECT (undo->'before'->0->>'id')::bigint FROM root_actions WHERE id = $1)) AS gone`, [id]);
			if (gone?.gone) throw new ConflictError("that account was deleted since; reverse its deletion first");
			await tx.query(
				`UPDATE accounts a SET type = b.type, currency = b.currency, kind = b.kind, parent_id = b.parent_id
				   FROM jsonb_populate_recordset(NULL::accounts, (SELECT undo->'before' FROM root_actions WHERE id = $1)) b
				  WHERE a.id = b.id`,
				[id],
			);
			await tx.query(
				`UPDATE accounts a SET parent_id = (c->>'parent_id')::bigint
				   FROM jsonb_array_elements((SELECT undo->'children' FROM root_actions WHERE id = $1)) c
				  WHERE a.id = (c->>'id')::bigint`,
				[id],
			);
		} else if (a.action === "entry.delete") {
			await putBackEntries(tx, id);
		} else if (a.action === "line.delete") {
			await putBack(tx, id, "transactions", "lines");
			await putBack(tx, id, "reconciliation_lines", "rec_lines");
			await putBack(tx, id, "transaction_changes", "amounts");
			await putBack(tx, id, "transaction_moves", "moves");
		} else if (a.action === "line.update") {
			await tx.query(
				`UPDATE transactions t SET account_id = b.account_id, currency = b.currency, amount = b.amount
				   FROM jsonb_populate_recordset(NULL::transactions, (SELECT undo->'before' FROM root_actions WHERE id = $1)) b
				  WHERE t.id = b.id`,
				[id],
			);
		} else if (a.action === "module.delete" || a.action === "module.update") {
			const u = await queryRow<{ schema: string; tbl: string }>(tx, `SELECT undo->>'schema' AS schema, undo->>'table' AS tbl FROM root_actions WHERE id = $1`, [id]);
			const t = await moduleTable(tx, u?.schema ?? "", u?.tbl ?? "");
			if (a.action === "module.delete") {
				await putBack(tx, id, t.name, "row");
			} else {
				const cols = t.columns.filter((c) => c !== "id").map((c) => `"${c}"`);
				await tx.query(
					`UPDATE ${t.name} t SET (${cols.join(", ")}) = (${cols.map((c) => `b.${c}`).join(", ")})
					   FROM jsonb_populate_recordset(NULL::${t.name}, (SELECT undo->'row' FROM root_actions WHERE id = $1)) b
					  WHERE t.id = b.id`,
					[id],
				);
			}
		} else {
			await putBack(tx, id, "accounts", "account");
			await putBack(tx, id, "journal_entries", "entries");
			await putBack(tx, id, "transactions", "lines");
			await putBack(tx, id, "reconciliations", "recs");
			await putBack(tx, id, "reconciliation_lines", "rec_lines");
			await putBack(tx, id, "transaction_changes", "amounts");
			await putBack(tx, id, "transaction_moves", "moves");
			await putBack(tx, id, "journal_entry_date_changes", "dates");
			await putBack(tx, id, "journal_entry_links", "links");
			await putBack(tx, id, "account_code_changes", "code_changes");
			await putBack(tx, id, "journal_entry_tags", "tags");
			const acc = `(SELECT (undo->'account'->0->>'id')::bigint FROM root_actions WHERE id = $1)`;
			await tx.query(`UPDATE accounts SET parent_id = ${acc} WHERE id IN (SELECT (c->>'id')::bigint FROM jsonb_array_elements((SELECT undo->'children' FROM root_actions WHERE id = $1)) c)`, [id]);
			await tx.query(`UPDATE documents SET account_id = ${acc} WHERE id IN (SELECT (c->>'id')::bigint FROM jsonb_array_elements((SELECT undo->'documents' FROM root_actions WHERE id = $1)) c)`, [id]);
		}
		await tx.query(`UPDATE root_actions SET reversed_at = now(), reversed_by = $2 WHERE id = $1`, [id, user.username]);
	});
	await syncUnreconciledLater(app);
	return getAction(db, scope, id);
}

// ---------------------------------------------------------------------------
// Entries and lines: delete anything, change any line
// ---------------------------------------------------------------------------

async function putBackEntries(tx: Queryable, id: bigint): Promise<void> {
	await putBack(tx, id, "journal_entries", "entries");
	await putBack(tx, id, "transactions", "lines");
	await putBack(tx, id, "reconciliation_lines", "rec_lines");
	await putBack(tx, id, "transaction_changes", "amounts");
	await putBack(tx, id, "transaction_moves", "moves");
	await putBack(tx, id, "journal_entry_date_changes", "dates");
	await putBack(tx, id, "journal_entry_links", "links");
	await putBack(tx, id, "journal_entry_tags", "tags");
}

/** Deletes a journal entry whole (with the entry that reverses it, or that it reverses). */
export async function rootDeleteEntry(app: App, entryId: bigint, user: User): Promise<RootAction> {
	const id = await withTx(app.db, {}, async (tx) => {
		const head = await queryRow<{ description: string; entry_date: string }>(tx, `SELECT description, entry_date FROM journal_entries WHERE id = $1 FOR UPDATE`, [entryId]);
		if (!head) throw new NotFoundError();
		const pair = await queryRows<{ id: bigint }>(tx, `SELECT id FROM journal_entries WHERE reverses_id = $1 UNION SELECT reverses_id FROM journal_entries WHERE id = $1 AND reverses_id IS NOT NULL`, [entryId]);
		const e = [entryId, ...pair.map((r) => r.id)];
		const id = await begin(tx, "entry.delete", String(entryId), `Deleted entry #${entryId} (${head.entry_date}, ${head.description})${pair.length ? ` and its reversal #${pair.map((r) => r.id).join(", #")}` : ""}`, user);
		await keep(tx, id, "entries", `SELECT * FROM journal_entries WHERE id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "lines", `SELECT * FROM transactions WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "rec_lines", `SELECT * FROM reconciliation_lines WHERE transaction_id IN (SELECT id FROM transactions WHERE journal_entry_id = ANY($2::bigint[]))`, [e]);
		await keep(tx, id, "amounts", `SELECT * FROM transaction_changes WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "moves", `SELECT * FROM transaction_moves WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "dates", `SELECT * FROM journal_entry_date_changes WHERE journal_entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "links", `SELECT * FROM journal_entry_links WHERE entry_id = ANY($2::bigint[])`, [e]);
		await keep(tx, id, "tags", `SELECT * FROM journal_entry_tags WHERE entry_id = ANY($2::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entry_tags WHERE entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM reconciliation_lines WHERE transaction_id IN (SELECT id FROM transactions WHERE journal_entry_id = ANY($1::bigint[]))`, [e]);
		await tx.query(`DELETE FROM transaction_changes WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM transaction_moves WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entry_date_changes WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entry_links WHERE entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM transactions WHERE journal_entry_id = ANY($1::bigint[])`, [e]);
		await tx.query(`DELETE FROM journal_entries WHERE id = ANY($1::bigint[]) AND reverses_id IS NOT NULL`, [e]);
		await tx.query(`DELETE FROM journal_entries WHERE id = ANY($1::bigint[])`, [e]);
		return id;
	});
	await syncUnreconciledLater(app);
	return getAction(app.db, "books", id);
}

async function lineOf(tx: Queryable, entryId: bigint, lineNumber: number) {
	const l = await queryRow<{ id: bigint; code: string; name: string; amount: bigint; currency: string }>(
		tx,
		`SELECT t.id, a.code, a.name, t.amount, t.currency FROM transactions t JOIN accounts a ON a.id = t.account_id
		  WHERE t.journal_entry_id = $1 AND t.line_number = $2 FOR UPDATE OF t`,
		[entryId, lineNumber],
	);
	if (!l) throw new NotFoundError();
	return l;
}

const side = (amount: bigint) => `${formatCents(amount < 0n ? -amount : amount)} ${amount < 0n ? "Cr" : "Dr"}`;

/** Deletes one line of an entry. The entry may be left unbalanced, or with a single line, until root mode is left. */
export async function rootDeleteLine(app: App, entryId: bigint, lineNumber: number, user: User): Promise<RootAction> {
	const id = await withTx(app.db, {}, async (tx) => {
		const l = await lineOf(tx, entryId, lineNumber);
		const id = await begin(tx, "line.delete", `${entryId}/${lineNumber}`, `Deleted line ${lineNumber} of entry #${entryId}: ${l.code} ${l.name}, ${side(l.amount)}`, user);
		await keep(tx, id, "lines", `SELECT * FROM transactions WHERE id = $2`, [l.id]);
		await keep(tx, id, "rec_lines", `SELECT * FROM reconciliation_lines WHERE transaction_id = $2`, [l.id]);
		await keep(tx, id, "amounts", `SELECT * FROM transaction_changes WHERE transaction_id = $2`, [l.id]);
		await keep(tx, id, "moves", `SELECT * FROM transaction_moves WHERE transaction_id = $2`, [l.id]);
		await tx.query(`DELETE FROM reconciliation_lines WHERE transaction_id = $1`, [l.id]);
		await tx.query(`DELETE FROM transaction_changes WHERE transaction_id = $1`, [l.id]);
		await tx.query(`DELETE FROM transaction_moves WHERE transaction_id = $1`, [l.id]);
		await tx.query(`DELETE FROM transactions WHERE id = $1`, [l.id]);
		return id;
	});
	await syncUnreconciledLater(app);
	return getAction(app.db, "books", id);
}

/** Changes a line's account (any account, any currency) or amount; the entry need not balance until root mode is left. */
export async function rootUpdateLine(app: App, entryId: bigint, lineNumber: number, input: { account_code?: string; debit_cents?: bigint; credit_cents?: bigint }, user: User): Promise<RootAction> {
	const v = new ValidationError();
	const amountGiven = input.debit_cents !== undefined || input.credit_cents !== undefined;
	const debit = input.debit_cents ?? 0n;
	const credit = input.credit_cents ?? 0n;
	if (amountGiven && (debit < 0n || credit < 0n || debit > 0n === credit > 0n)) v.add("", "give a debit or a credit, not both and not neither");
	if (!amountGiven && input.account_code === undefined) v.add("", "give an account or an amount");
	v.throwIfAny();
	const id = await withTx(app.db, {}, async (tx) => {
		const l = await lineOf(tx, entryId, lineNumber);
		let to: { id: bigint; code: string; name: string; currency: string } | undefined;
		if (input.account_code !== undefined) {
			to = await queryRow(tx, `SELECT id, code, name, currency FROM accounts WHERE code = $1 FOR SHARE`, [input.account_code]);
			if (!to) {
				v.add("account_code", `account ${JSON.stringify(input.account_code)} does not exist`);
				v.throwIfAny();
			}
		}
		const amount = amountGiven ? debit - credit : l.amount;
		const what = [to && to.code !== l.code ? `account ${l.code} → ${to.code}` : "", amount !== l.amount ? `${side(l.amount)} → ${side(amount)}` : ""].filter(Boolean).join(", ");
		if (!what) {
			v.add("", "that is what it is already");
			v.throwIfAny();
		}
		const id = await begin(tx, "line.update", `${entryId}/${lineNumber}`, `Changed line ${lineNumber} of entry #${entryId}: ${what}`, user);
		await keep(tx, id, "before", `SELECT * FROM transactions WHERE id = $2`, [l.id]);
		// The line's currency follows its account.
		await tx.query(`UPDATE transactions SET account_id = COALESCE($2, account_id), currency = COALESCE($3, currency), amount = $4 WHERE id = $1`, [l.id, to?.id ?? null, to?.currency ?? null, amount]);
		return id;
	});
	await syncUnreconciledLater(app);
	return getAction(app.db, "books", id);
}

// ---------------------------------------------------------------------------
// Modules' own records (ctx.root)
// ---------------------------------------------------------------------------

/** A table of a module's schema with an id column: its quoted name and columns. */
async function moduleTable(tx: Queryable, schema: string, table: string): Promise<{ name: string; columns: string[] }> {
	const ok = /^mod_[a-z0-9_]{1,40}$/.test(schema) && /^[a-z_][a-z0-9_]{0,62}$/.test(table);
	const cols = ok ? await queryRows<{ column_name: string }>(tx, `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]) : [];
	const columns = cols.map((c) => c.column_name).filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
	if (!columns.includes("id")) {
		const v = new ValidationError();
		v.add("table", `${JSON.stringify(table)} is not a table of this module with an id column`);
		v.throwIfAny();
	}
	return { name: `"${schema}"."${table}"`, columns };
}

/** Deletes one row of a module's table in root mode, kept so it can be put back. */
export async function rootModuleDelete(app: App, mod: { id: string; name: string; schema: string }, table: string, rowId: unknown, user: User, summary?: string): Promise<RootAction> {
	requireRoot(user);
	const id = await withTx(app.db, {}, async (tx) => {
		const t = await moduleTable(tx, mod.schema, table);
		const id = await begin(tx, "module.delete", `${mod.id}:${table}:${String(rowId)}`, summary?.trim() || `${mod.name}: deleted ${table} ${String(rowId)}`, user, { schema: mod.schema, table });
		await keep(tx, id, "row", `SELECT * FROM ${t.name} WHERE id::text = $2`, [String(rowId)]);
		const r = await tx.query(`DELETE FROM ${t.name} WHERE id::text = $1`, [String(rowId)]);
		if ((r.rowCount ?? 0) === 0) throw new NotFoundError();
		return id;
	});
	return getAction(app.db, "books", id);
}

/** Changes columns of one row of a module's table in root mode, keeping the row as it was. */
export async function rootModuleUpdate(app: App, mod: { id: string; name: string; schema: string }, table: string, rowId: unknown, set: Record<string, unknown>, user: User, summary?: string): Promise<RootAction> {
	requireRoot(user);
	const keys = set && typeof set === "object" ? Object.keys(set) : [];
	const id = await withTx(app.db, {}, async (tx) => {
		const t = await moduleTable(tx, mod.schema, table);
		const v = new ValidationError();
		if (keys.length === 0) v.add("set", "give the columns to change");
		for (const k of keys) if (k === "id" || !t.columns.includes(k)) v.add("set", `${JSON.stringify(k)} is not a column that can be changed`);
		v.throwIfAny();
		const id = await begin(tx, "module.update", `${mod.id}:${table}:${String(rowId)}`, summary?.trim() || `${mod.name}: changed ${table} ${String(rowId)} (${keys.join(", ")})`, user, { schema: mod.schema, table });
		await keep(tx, id, "row", `SELECT * FROM ${t.name} WHERE id::text = $2`, [String(rowId)]);
		const r = await tx.query(`UPDATE ${t.name} SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id::text = $1`, [String(rowId), ...keys.map((k) => set[k])]);
		if ((r.rowCount ?? 0) === 0) throw new NotFoundError();
		return id;
	});
	return getAction(app.db, "books", id);
}

// ---------------------------------------------------------------------------
// Leaving root mode: the books must be intact
// ---------------------------------------------------------------------------

/** What is wrong with the entries in this database: too few lines, or debits and credits that differ. */
async function checkBooks(db: Queryable): Promise<string[]> {
	const few = await queryRows<{ id: bigint; n: number }>(db, `SELECT e.id, count(t.id)::int AS n FROM journal_entries e LEFT JOIN transactions t ON t.journal_entry_id = e.id GROUP BY e.id HAVING count(t.id) < 2 ORDER BY e.id LIMIT 50`);
	const off = await queryRows<{ id: bigint; currency: string; off: bigint }>(
		db,
		`SELECT journal_entry_id AS id, btrim(currency) AS currency, sum(amount)::bigint AS off FROM transactions GROUP BY 1, 2 HAVING sum(amount) <> 0 ORDER BY 1 LIMIT 50`,
	);
	const fewIds = new Set(few.map((f) => f.id));
	return [
		...few.map((f) => `entry #${f.id} has ${f.n === 0 ? "no lines" : "only one line"}`),
		...off.filter((o) => !fewIds.has(o.id)).map((o) => `entry #${o.id} doesn't balance in ${o.currency}: debits and credits differ by ${formatCents(o.off < 0n ? -o.off : o.off)}`),
	];
}

/** Everything that keeps root mode from being left: broken entries in any set of books, and what modules report. */
export async function rootProblems(app: App): Promise<string[]> {
	const out: string[] = [];
	const orgs = (await listOrganizations(app)).filter((o) => o.status === "ready");
	for (const o of orgs) {
		const prefix = orgs.length > 1 ? `${o.name}: ` : "";
		await inOrg(o, async () => {
			for (const p of await checkBooks(app.db)) out.push(prefix + p);
			for (const m of app.modules.modules.values()) {
				if (m.error) continue;
				for (const fn of m.rootChecks) {
					try {
						const found = await fn();
						if (Array.isArray(found)) for (const p of found.slice(0, 50)) out.push(`${prefix}${m.manifest.name}: ${String(p).slice(0, 300)}`);
					} catch (err) {
						out.push(`${prefix}${m.manifest.name}: its check failed (${(err as Error).message.slice(0, 200)})`);
					}
				}
			}
		});
	}
	return out;
}

/** Reverses, newest first, everything not yet reversed that was done in a root session; returns how many. */
export async function reverseRootSession(app: App, session: string, by: { username: string }): Promise<number> {
	let n = 0;
	for (const o of (await listOrganizations(app)).filter((x) => x.status === "ready")) {
		await inOrg(o, async () => {
			const ids = await queryRows<{ id: bigint }>(app.db, `SELECT id FROM root_actions WHERE session = $1 AND reversed_at IS NULL AND action NOT LIKE 'user.%' ORDER BY id DESC`, [session]);
			for (const a of ids) {
				await reverseRootAction(app, "books", a.id, by);
				n++;
			}
		});
	}
	const users = await queryRows<{ id: bigint }>(app.main, `SELECT id FROM root_actions WHERE session = $1 AND reversed_at IS NULL AND action LIKE 'user.%' AND NOT undo ? 'part_of' ORDER BY id DESC`, [session]);
	for (const a of users) {
		await reverseRootAction(app, "users", a.id, by);
		n++;
	}
	return n;
}

async function closeRootSession(app: App, session: string): Promise<void> {
	await app.main.query(`UPDATE root_actions SET closed = true WHERE session = $1 AND NOT closed`, [session]);
	for (const d of await databases(app)) await d.db.query(`UPDATE root_actions SET closed = true WHERE session = $1 AND NOT closed`, [session]);
}

export class RootNotIntactError extends HttpError {
	readonly problems: string[];
	constructor(problems: string[], message: string) {
		super(409, message, "root_not_intact");
		this.problems = problems;
	}
}

/**
 * The check made when root mode is left. With the books intact the root
 * session is closed. Otherwise it is refused (so the admin can go back and
 * fix it) unless `reverse` is set: then everything done in this root session
 * is reversed first. Returns how many actions were reversed.
 */
export async function leaveRootMode(app: App, user: { username: string; root_session: string | null }, reverse: boolean): Promise<number> {
	const session = user.root_session;
	let problems = await rootProblems(app);
	let reversed = 0;
	if (problems.length > 0) {
		if (!reverse) throw new RootNotIntactError(problems, `the books are not intact: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}`);
		if (session) reversed = await reverseRootSession(app, session, user);
		problems = await rootProblems(app);
		if (problems.length > 0) {
			throw new RootNotIntactError(problems, `this root session was reversed (${reversed} action${reversed === 1 ? "" : "s"}), but the books are still not intact: ${problems.slice(0, 5).join("; ")}. Fix these in root mode.`);
		}
	}
	if (session) await closeRootSession(app, session);
	return reversed;
}

/**
 * Root sessions that ended without leaving root mode (the login timed out,
 * the server restarted): if the books are broken they are reversed, newest
 * first, until the books are intact again; then they are closed.
 */
export async function sweepRootSessions(app: App): Promise<void> {
	const live = new Set((await queryRows<{ s: string }>(app.main, `SELECT root_session AS s FROM sessions WHERE root AND root_session IS NOT NULL AND expires_at > now()`)).map((r) => r.s));
	const open = new Map<string, Date>();
	const collect = async (db: Queryable) => {
		for (const r of await queryRows<{ session: string; at: Date }>(db, `SELECT session, max(done_at) AS at FROM root_actions WHERE session IS NOT NULL AND NOT closed GROUP BY session`)) {
			if (!live.has(r.session) && (open.get(r.session) ?? new Date(0)) < r.at) open.set(r.session, r.at);
		}
	};
	await collect(app.main);
	for (const d of await databases(app)) await collect(d.db);
	if (open.size === 0) return;
	const sessions = [...open.entries()].sort((a, b) => b[1].getTime() - a[1].getTime()).map((e) => e[0]);
	for (const s of sessions) {
		if ((await rootProblems(app)).length === 0) break;
		const n = await reverseRootSession(app, s, { username: "ledger" }).catch((err: Error) => {
			log.error("root: reversing an abandoned root session failed", { session: s, err: err.message });
			return 0;
		});
		log.warn("root: an abandoned root session left the books broken; reversed it", { session: s, actions: n });
	}
	for (const s of sessions) await closeRootSession(app, s);
}
