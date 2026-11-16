// The Unreconciled clearing account. When a reconciliation is finished, the
// lines of the reconciled account that weren't ticked move there (the line
// itself changes account; the database logs every move). Each line in it
// gets a dashboard to-do, and a "danger" notice stays up until the account
// is back at zero. A person moves each line on to where it belongs: back to
// the bank once it clears, or to another account.

import type { App } from "./app.ts";
import { closeLedgerNotice, listBySource, postItem, postLedgerNotice, setClosedByKey } from "./dashboard.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { formatCents } from "./money.ts";
import { trimSpace } from "./text.ts";
import type { Currency } from "./types.ts";

/** Ledger's own Unreconciled accounts (one per currency). */
export const UNRECONCILED_WHERE = `a.module_id = 'ledger' AND a.module_key = 'unreconciled'`;

/**
 * Moves posted lines to another account inside tx. The database refuses it
 * for a line ticked on a reconciliation, and logs each move with who made it
 * (and the reconciliation, when one made it).
 */
export async function moveLines(tx: Queryable, ids: bigint[], toAccountId: bigint, actorId: number | null, reason: string, reconciliationId: bigint | null): Promise<void> {
	if (ids.length === 0) return;
	await tx.query(`SELECT set_config('ledger.amend_by', $1, true), set_config('ledger.amend_reason', $2, true), set_config('ledger.amend_reconciliation', $3, true)`, [
		String(actorId ?? "system"),
		reason.slice(0, 500),
		reconciliationId === null ? "" : String(reconciliationId),
	]);
	await tx.query(`UPDATE transactions SET account_id = $2 WHERE id = ANY($1::bigint[]) AND account_id <> $2`, [ids, toAccountId]);
	await tx.query(`SELECT set_config('ledger.amend_reconciliation', '', true)`);
}

export interface UnreconciledAccount {
	code: string;
	name: string;
	currency: Currency;
	/** Debit-positive. */
	balance_cents: bigint;
	line_count: number;
}

/** Each Unreconciled account that has lines in it, with its balance. */
export async function unreconciledSummary(db: Queryable): Promise<UnreconciledAccount[]> {
	const rows = await queryRows<{ code: string; name: string; currency: Currency; balance: bigint; n: bigint }>(
		db,
		`SELECT a.code, a.name, a.currency, COALESCE(sum(t.amount), 0)::bigint AS balance, count(t.id) AS n
		   FROM accounts a JOIN transactions t ON t.account_id = a.id
		  WHERE ${UNRECONCILED_WHERE}
		  GROUP BY a.id ORDER BY a.code`,
	);
	return rows.map((r) => ({ code: r.code, name: r.name, currency: r.currency, balance_cents: r.balance, line_count: Number(r.n) }));
}

const todoKey = (transactionId: bigint | number) => `unreconciled-${transactionId}`;

/**
 * Brings the dashboard in line with what sits in Unreconciled: a to-do for
 * each line there (closed once it has moved on), and the danger notice while
 * any Unreconciled account isn't at zero.
 */
export async function syncUnreconciled(app: App): Promise<void> {
	const lines = await queryRows<{ id: bigint; entry_id: bigint; entry_date: string; description: string; amount: bigint; currency: Currency; code: string; from_code: string | null; from_name: string | null; statement_date: string | null }>(
		app.db,
		`SELECT t.id, t.journal_entry_id AS entry_id, je.entry_date, je.description, t.amount, t.currency, a.code,
		        fa.code AS from_code, fa.name AS from_name, r.statement_date
		   FROM transactions t
		   JOIN accounts a ON a.id = t.account_id
		   JOIN journal_entries je ON je.id = t.journal_entry_id
		   LEFT JOIN LATERAL (SELECT m.old_account_id, m.reconciliation_id FROM transaction_moves m
		                       WHERE m.transaction_id = t.id ORDER BY m.id DESC LIMIT 1) last ON true
		   LEFT JOIN accounts fa ON fa.id = last.old_account_id
		   LEFT JOIN reconciliations r ON r.id = last.reconciliation_id
		  WHERE ${UNRECONCILED_WHERE}
		  ORDER BY je.entry_date, t.id`,
	);
	const there = new Set<string>();
	for (const l of lines) {
		there.add(todoKey(l.id));
		const amount = `${formatCents(l.amount < 0n ? -l.amount : l.amount)} ${l.currency}`;
		const from = l.from_code
			? `Moved from ${l.from_code} ${l.from_name ?? ""}${l.statement_date ? ` when the statement to ${l.statement_date} was reconciled` : ""}: it wasn't ticked on the statement.`
			: "Posted here by a reconciliation finished with a difference.";
		await postItem(app, "ledger", "todo", {
			key: todoKey(l.id),
			title: `Unreconciled: ${l.description || `entry ${l.entry_id}`}, ${amount} (${l.entry_date})`.slice(0, 200),
			body: `${from} Move it to the right account on the entry's page: back to the bank once it clears, or to where it belongs.`,
			level: "danger",
			link: `/journal/${l.entry_id}`,
		});
		await setClosedByKey(app, "ledger", "todo", todoKey(l.id), false);
	}
	for (const t of await listBySource(app, "ledger", { kind: "todo", open: true })) {
		if (t.key.startsWith("unreconciled-") && !there.has(t.key)) await setClosedByKey(app, "ledger", "todo", t.key, true);
	}
	const off = (await unreconciledSummary(app.db)).filter((a) => a.balance_cents !== 0n);
	if (off.length === 0) {
		await closeLedgerNotice(app.db, "unreconciled");
		return;
	}
	const n = lines.filter((l) => off.some((a) => a.code === l.code)).length;
	await postLedgerNotice(app.db, {
		key: "unreconciled",
		title: "Danger: unreconciled transactions",
		body: `${n} transaction${n === 1 ? "" : "s"} (${off.map((a) => `${formatCents(a.balance_cents)} ${a.currency}`).join(", ")}) sit in ${off.map((a) => a.name).join(" and ")} until each is moved to the right account.`,
		level: "danger",
		link: `/accounts/${encodeURIComponent(off[0]!.code)}`,
	});
}

/** Runs syncUnreconciled, logging instead of failing the request that changed the books. */
export function syncUnreconciledLater(app: App): Promise<void> {
	return syncUnreconciled(app).catch((err: Error) => log.warn("unreconciled to-dos not updated", { err: err.message }));
}

/**
 * Moves one line of an entry out of an Unreconciled account to another
 * account in the same currency (back to the bank once it clears, or to
 * where it belongs).
 */
export async function moveUnreconciledLine(app: App, entryId: bigint, lineNumber: number, input: { account_code: string; reason?: string }, actorId: number | null): Promise<void> {
	const v = new ValidationError();
	const reason = trimSpace(input.reason ?? "");
	if (reason.length > 500) v.add("reason", "must be at most 500 characters");
	if (!input.account_code) v.add("account_code", "is required");
	v.throwIfAny();
	await withTx(app.db, {}, async (tx) => {
		const line = await queryRow<{ id: bigint; currency: Currency; unreconciled: boolean }>(
			tx,
			`SELECT t.id, t.currency, (${UNRECONCILED_WHERE}) AS unreconciled
			   FROM transactions t JOIN accounts a ON a.id = t.account_id
			  WHERE t.journal_entry_id = $1 AND t.line_number = $2`,
			[entryId, lineNumber],
		);
		if (!line) throw new NotFoundError();
		if (!line.unreconciled) throw new ConflictError("only a line in the Unreconciled account can be moved to another account");
		const to = await queryRow<{ id: bigint; currency: string; is_active: boolean; unreconciled: boolean }>(
			tx,
			`SELECT a.id, a.currency, a.is_active, (${UNRECONCILED_WHERE}) AS unreconciled FROM accounts a WHERE a.code = $1 FOR SHARE`,
			[input.account_code],
		);
		if (!to) v.add("account_code", `account ${JSON.stringify(input.account_code)} does not exist`);
		else if (to.unreconciled) v.add("account_code", "choose the account the line belongs in, not Unreconciled");
		else if (to.currency.trim() !== line.currency.trim()) v.add("account_code", `must be a ${line.currency.trim()} account, like the line`);
		else if (!to.is_active) v.add("account_code", "that account is inactive");
		v.throwIfAny();
		await moveLines(tx, [line.id], to!.id, actorId, reason, null);
	});
	await syncUnreconciledLater(app);
}

/** One move of a posted line to another account. */
export interface EntryMove {
	id: number;
	line_number: number;
	from_code: string;
	from_name: string;
	to_code: string;
	to_name: string;
	/** The reconciliation that moved it, if one did. */
	reconciliation_id: number | null;
	reason: string;
	changed_by: string | null;
	changed_at: Date;
}

export async function entryMoves(db: Queryable, entryId: bigint): Promise<EntryMove[]> {
	const rows = await queryRows<{ id: bigint; line_number: number; fc: string; fn: string; tc: string; tn: string; rid: bigint | null; reason: string; username: string | null; changed_at: Date }>(
		db,
		`SELECT m.id, t.line_number, fa.code AS fc, fa.name AS fn, ta.code AS tc, ta.name AS tn, m.reconciliation_id AS rid, m.reason, u.username, m.changed_at
		   FROM transaction_moves m
		   JOIN transactions t ON t.id = m.transaction_id
		   JOIN accounts fa ON fa.id = m.old_account_id
		   JOIN accounts ta ON ta.id = m.new_account_id
		   LEFT JOIN users u ON u.id = m.changed_by
		  WHERE m.journal_entry_id = $1 ORDER BY m.id`,
		[entryId],
	);
	return rows.map((r) => ({ id: Number(r.id), line_number: r.line_number, from_code: r.fc, from_name: r.fn, to_code: r.tc, to_name: r.tn, reconciliation_id: r.rid === null ? null : Number(r.rid), reason: r.reason, changed_by: r.username, changed_at: r.changed_at }));
}
