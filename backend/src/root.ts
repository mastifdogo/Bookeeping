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
import { listOrganizations, MAIN_ORG } from "./orgs.ts";
import { ACCOUNT_TYPES, isCurrency, type AccountType, type User } from "./types.ts";
import { syncUnreconciledLater } from "./unreconciled.ts";

export type RootAction = {
	id: number;
	/** "books": the current organization's accounts; "users": people who log in. */
	scope: "books" | "users";
	action: "account.update" | "account.delete" | "user.update" | "user.delete";
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

async function begin(tx: Queryable, action: RootAction["action"], target: string, summary: string, by: string, undo: Record<string, unknown> = {}): Promise<bigint> {
	await asRoot(tx);
	const r = await queryRow<{ id: bigint }>(tx, `INSERT INTO root_actions (action, target, summary, undo, done_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`, [
		action,
		target,
		summary.slice(0, 1000),
		JSON.stringify(undo),
		by,
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
			user.username,
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
		const id = await begin(tx, "account.update", code, `Changed account ${acc.code} ${acc.name}: ${what}`, user.username);
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
async function removeUserFrom(db: Pool, userId: bigint, username: string, by: string, summary: string, partOf: number | null): Promise<bigint> {
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
			if (has) done.push({ db: d.name, id: Number(await removeUserFrom(d.db, u.id, u.username, user.username, summary, -1)) });
		}
		const id = await removeUserFrom(app.main, u.id, u.username, user.username, summary, null);
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
		const id = await begin(tx, "user.update", u.username, `Renamed user ${u.username} to ${next}`, user.username, { user_id: String(u.id), before: u.username, after: next });
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
	const books = await queryRows<ActionRow>(app.db, ACTION_SELECT + ` WHERE action LIKE 'account.%' ORDER BY id DESC LIMIT 500`);
	const users = await queryRows<ActionRow>(app.main, ACTION_SELECT + ` WHERE action LIKE 'user.%' AND NOT undo ? 'part_of' ORDER BY id DESC LIMIT 500`);
	return [...books.map((r) => ({ ...r, id: Number(r.id), scope: "books" as const })), ...users.map((r) => ({ ...r, id: Number(r.id), scope: "users" as const }))].sort(
		(a, b) => new Date(b.done_at).getTime() - new Date(a.done_at).getTime(),
	);
}

/** Puts back what a root action changed or deleted. */
export async function reverseRootAction(app: App, scope: RootAction["scope"], id: bigint, user: User): Promise<RootAction> {
	const db = scope === "books" ? app.db : app.main;
	const a = await queryRow<{ action: RootAction["action"]; reversed_at: Date | null; part_of: string | null }>(db, `SELECT action, reversed_at, undo->>'part_of' AS part_of FROM root_actions WHERE id = $1`, [id]);
	if (!a || (scope === "books") !== a.action.startsWith("account.") || a.part_of !== null) throw new NotFoundError();
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
			const acc = `(SELECT (undo->'account'->0->>'id')::bigint FROM root_actions WHERE id = $1)`;
			await tx.query(`UPDATE accounts SET parent_id = ${acc} WHERE id IN (SELECT (c->>'id')::bigint FROM jsonb_array_elements((SELECT undo->'children' FROM root_actions WHERE id = $1)) c)`, [id]);
			await tx.query(`UPDATE documents SET account_id = ${acc} WHERE id IN (SELECT (c->>'id')::bigint FROM jsonb_array_elements((SELECT undo->'documents' FROM root_actions WHERE id = $1)) c)`, [id]);
		}
		await tx.query(`UPDATE root_actions SET reversed_at = now(), reversed_by = $2 WHERE id = $1`, [id, user.username]);
	});
	await syncUnreconciledLater(app);
	return getAction(db, scope, id);
}
