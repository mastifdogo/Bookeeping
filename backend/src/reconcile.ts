// Reconciling an account against a statement. The user enters the
// statement's date and ending balance, then ticks the journal lines that
// appear on it. When the cleared lines (plus everything cleared on earlier
// statements) add up to the statement balance, the reconciliation can be
// finished. Amounts use the account's natural sign, like the statement.

import type { App } from "./app.ts";
import { queryRow, queryRows, withTx, type Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import type { AccountType, Currency } from "./types.ts";

export interface Reconciliation {
	id: number;
	account_code: string;
	account_name: string;
	account_type: AccountType;
	currency: Currency;
	statement_date: string;
	statement_balance_cents: bigint;
	status: "open" | "finished";
	created_by: string | null;
	created_at: Date;
	finished_by: string | null;
	finished_at: Date | null;
	cleared_count: number;
}

export interface ReconciliationLine {
	transaction_id: number;
	journal_entry_id: number;
	entry_date: string;
	description: string;
	reference: string;
	memo: string;
	debit_cents: bigint;
	credit_cents: bigint;
	/** In the account's natural sign. */
	amount_cents: bigint;
	cleared: boolean;
}

export interface ReconciliationDetail {
	reconciliation: Reconciliation;
	/** Cleared on earlier (finished) statements. */
	opening_balance_cents: bigint;
	/** Opening plus the lines cleared on this statement. */
	cleared_balance_cents: bigint;
	/** Statement balance minus cleared balance; 0 means it can be finished. */
	difference_cents: bigint;
	lines: ReconciliationLine[];
}

const SELECT = `
	SELECT r.id, a.code AS account_code, a.name AS account_name, a.type::text AS account_type, a.currency::text AS currency,
	       r.statement_date, r.statement_balance_cents, r.status, cu.username AS created_by, r.created_at,
	       fu.username AS finished_by, r.finished_at, r.account_id,
	       (SELECT count(*) FROM reconciliation_lines l WHERE l.reconciliation_id = r.id) AS cleared_count
	  FROM reconciliations r
	  JOIN accounts a ON a.id = r.account_id
	  LEFT JOIN users cu ON cu.id = r.created_by
	  LEFT JOIN users fu ON fu.id = r.finished_by`;

type Row = Omit<Reconciliation, "id" | "cleared_count"> & { id: bigint; cleared_count: bigint; account_id: bigint };

function toRec(r: Row): Reconciliation {
	const { account_id: _, ...rest } = r;
	return { ...rest, id: Number(r.id), cleared_count: Number(r.cleared_count) };
}

/** Debit-positive amounts times this give the natural sign. */
const sign = (type: AccountType) => (type === "asset" || type === "expense" ? 1n : -1n);

export async function listReconciliations(app: App, accountCode: string | null): Promise<Reconciliation[]> {
	const rows = await queryRows<Row>(
		app.db,
		SELECT + ` WHERE ($1::text IS NULL OR a.code = $1) ORDER BY r.status = 'open' DESC, r.statement_date DESC, r.id DESC LIMIT 500`,
		[accountCode],
	);
	return rows.map(toRec);
}

async function loadRow(db: Queryable, id: bigint, lock = false): Promise<Row> {
	const r = await queryRow<Row>(db, SELECT + ` WHERE r.id = $1` + (lock ? " FOR UPDATE OF r" : ""), [id]);
	if (!r) throw new NotFoundError();
	return r;
}

/** The latest finished statement date for the account, if any. */
async function lastFinished(db: Queryable, accountId: bigint, exceptId: bigint | null): Promise<{ id: bigint; statement_date: string } | undefined> {
	return queryRow(
		db,
		`SELECT id, statement_date FROM reconciliations
		  WHERE account_id = $1 AND status = 'finished' AND ($2::bigint IS NULL OR id <> $2)
		  ORDER BY statement_date DESC, id DESC LIMIT 1`,
		[accountId, exceptId],
	);
}

export async function getReconciliation(app: App, id: bigint, db: Queryable = app.db): Promise<ReconciliationDetail> {
	const r = await loadRow(db, id);
	const s = sign(r.account_type);
	const opening = await queryRow<{ total: bigint | null }>(
		db,
		`SELECT sum(t.amount)::bigint AS total
		   FROM reconciliation_lines l
		   JOIN reconciliations r ON r.id = l.reconciliation_id
		   JOIN transactions t ON t.id = l.transaction_id
		  WHERE r.account_id = $1 AND r.status = 'finished' AND r.id <> $2`,
		[r.account_id, id],
	);
	// Lines on or before the statement date not cleared on another statement,
	// plus any cleared on this one.
	const lines = await queryRows<{ transaction_id: bigint; journal_entry_id: bigint; entry_date: string; description: string; reference: string; memo: string; amount: bigint; cleared: boolean }>(
		db,
		`SELECT t.id AS transaction_id, t.journal_entry_id, je.entry_date, je.description, je.reference, t.memo, t.amount,
		        l.reconciliation_id IS NOT NULL AS cleared
		   FROM transactions t
		   JOIN journal_entries je ON je.id = t.journal_entry_id
		   LEFT JOIN reconciliation_lines l ON l.transaction_id = t.id
		  WHERE t.account_id = $1
		    AND (l.reconciliation_id = $2 OR (l.reconciliation_id IS NULL AND je.entry_date <= $3))
		  ORDER BY je.entry_date, t.journal_entry_id, t.line_number`,
		[r.account_id, id, r.statement_date],
	);
	const openingCents = s * (opening?.total ?? 0n);
	let cleared = openingCents;
	const out: ReconciliationLine[] = lines.map((l) => {
		const amount = s * l.amount;
		if (l.cleared) cleared += amount;
		return {
			transaction_id: Number(l.transaction_id),
			journal_entry_id: Number(l.journal_entry_id),
			entry_date: l.entry_date,
			description: l.description,
			reference: l.reference,
			memo: l.memo,
			debit_cents: l.amount > 0n ? l.amount : 0n,
			credit_cents: l.amount < 0n ? -l.amount : 0n,
			amount_cents: amount,
			cleared: l.cleared,
		};
	});
	return {
		reconciliation: toRec(r),
		opening_balance_cents: openingCents,
		cleared_balance_cents: cleared,
		difference_cents: r.statement_balance_cents - cleared,
		lines: out,
	};
}

export async function createReconciliation(
	app: App,
	input: { account_code: string; statement_date: string; statement_balance_cents: bigint | undefined },
	userId: number | null,
): Promise<ReconciliationDetail> {
	const v = new ValidationError();
	if (!input.account_code) v.add("account_code", "is required");
	if (!input.statement_date) v.add("statement_date", "is required");
	if (input.statement_balance_cents === undefined) v.add("statement_balance_cents", "is required");
	v.throwIfAny();
	return withTx(app.db, {}, async (tx) => {
		const acc = await queryRow<{ id: bigint }>(tx, `SELECT id FROM accounts WHERE code = $1 FOR UPDATE`, [input.account_code]);
		if (!acc) {
			v.add("account_code", `account ${JSON.stringify(input.account_code)} does not exist`);
			v.throwIfAny();
		}
		const open = await queryRow(tx, `SELECT 1 FROM reconciliations WHERE account_id = $1 AND status = 'open'`, [acc!.id]);
		if (open) throw new ConflictError("this account already has a reconciliation in progress; finish or delete it first");
		const last = await lastFinished(tx, acc!.id, null);
		if (last && input.statement_date < last.statement_date) {
			v.add("statement_date", `must not be before the last reconciled statement (${last.statement_date})`);
			v.throwIfAny();
		}
		const row = await queryRow<{ id: bigint }>(
			tx,
			`INSERT INTO reconciliations (account_id, statement_date, statement_balance_cents, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
			[acc!.id, input.statement_date, input.statement_balance_cents, userId],
		);
		return getReconciliation(app, row!.id, tx);
	});
}

async function openForUpdate(tx: Queryable, id: bigint): Promise<Row> {
	const r = await loadRow(tx, id, true);
	if (r.status !== "open") throw new ConflictError("this reconciliation is finished; undo it to make changes");
	return r;
}

export async function updateReconciliation(app: App, id: bigint, input: { statement_date?: string; statement_balance_cents?: bigint }): Promise<ReconciliationDetail> {
	return withTx(app.db, {}, async (tx) => {
		const r = await openForUpdate(tx, id);
		if (input.statement_date !== undefined) {
			const last = await lastFinished(tx, r.account_id, id);
			const v = new ValidationError();
			if (last && input.statement_date < last.statement_date) v.add("statement_date", `must not be before the last reconciled statement (${last.statement_date})`);
			const later = await queryRow<{ n: bigint }>(
				tx,
				`SELECT count(*) AS n FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id
				   JOIN journal_entries je ON je.id = t.journal_entry_id
				  WHERE l.reconciliation_id = $1 AND je.entry_date > $2`,
				[id, input.statement_date],
			);
			if (later && later.n > 0n) v.add("statement_date", `${later.n} cleared line(s) are dated after it; untick them first`);
			v.throwIfAny();
		}
		await tx.query(
			`UPDATE reconciliations SET statement_date = COALESCE($2, statement_date), statement_balance_cents = COALESCE($3, statement_balance_cents) WHERE id = $1`,
			[id, input.statement_date ?? null, input.statement_balance_cents ?? null],
		);
		return getReconciliation(app, id, tx);
	});
}

/** Ticks (clear) or unticks (unclear) lines. */
export async function changeCleared(app: App, id: bigint, change: { clear: bigint[]; unclear: bigint[] }): Promise<ReconciliationDetail> {
	if (change.clear.length + change.unclear.length > 5000) {
		const v = new ValidationError();
		v.add("clear", "at most 5000 lines per request");
		v.throwIfAny();
	}
	return withTx(app.db, {}, async (tx) => {
		const r = await openForUpdate(tx, id);
		if (change.unclear.length) {
			await tx.query(`DELETE FROM reconciliation_lines WHERE reconciliation_id = $1 AND transaction_id = ANY($2::bigint[])`, [id, change.unclear]);
		}
		if (change.clear.length) {
			const ok = await queryRows<{ id: bigint }>(
				tx,
				`SELECT t.id FROM transactions t JOIN journal_entries je ON je.id = t.journal_entry_id
				  WHERE t.id = ANY($1::bigint[]) AND t.account_id = $2 AND je.entry_date <= $3`,
				[change.clear, r.account_id, r.statement_date],
			);
			const okIds = new Set(ok.map((x) => x.id));
			const bad = change.clear.filter((x) => !okIds.has(x));
			if (bad.length) {
				const v = new ValidationError();
				v.add("clear", `line(s) ${bad.slice(0, 5).join(", ")} are not in this account on or before the statement date`);
				v.throwIfAny();
			}
			await tx.query(
				`INSERT INTO reconciliation_lines (reconciliation_id, transaction_id)
				 SELECT $1, x FROM unnest($2::bigint[]) AS x
				 ON CONFLICT DO NOTHING`,
				[id, change.clear],
			);
			// Lines already cleared on another statement were skipped above.
			const mine = await queryRow<{ n: bigint }>(
				tx,
				`SELECT count(*) AS n FROM reconciliation_lines WHERE reconciliation_id = $1 AND transaction_id = ANY($2::bigint[])`,
				[id, change.clear],
			);
			if ((mine?.n ?? 0n) < BigInt(new Set(change.clear.map(String)).size)) throw new ConflictError("some lines are already cleared on another statement");
		}
		return getReconciliation(app, id, tx);
	});
}

export async function finishReconciliation(app: App, id: bigint, userId: number | null): Promise<ReconciliationDetail> {
	return withTx(app.db, {}, async (tx) => {
		await openForUpdate(tx, id);
		const d = await getReconciliation(app, id, tx);
		if (d.difference_cents !== 0n) {
			throw new ConflictError(`the cleared balance is ${d.difference_cents > 0n ? "below" : "above"} the statement balance; the difference must be 0.00 to finish`);
		}
		await tx.query(`UPDATE reconciliations SET status = 'finished', finished_at = now(), finished_by = $2 WHERE id = $1`, [id, userId]);
		return getReconciliation(app, id, tx);
	});
}

/** Reopens the account's most recent finished reconciliation for changes. */
export async function undoReconciliation(app: App, id: bigint): Promise<ReconciliationDetail> {
	return withTx(app.db, {}, async (tx) => {
		const r = await loadRow(tx, id, true);
		if (r.status !== "finished") throw new ConflictError("this reconciliation is not finished");
		await tx.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [r.account_id]);
		const last = await lastFinished(tx, r.account_id, null);
		if (!last || last.id !== r.id) throw new ConflictError("only the most recent reconciliation of an account can be undone");
		const open = await queryRow(tx, `SELECT 1 FROM reconciliations WHERE account_id = $1 AND status = 'open'`, [r.account_id]);
		if (open) throw new ConflictError("this account has a reconciliation in progress; finish or delete it first");
		await tx.query(`UPDATE reconciliations SET status = 'open', finished_at = NULL, finished_by = NULL WHERE id = $1`, [id]);
		return getReconciliation(app, id, tx);
	});
}

export async function deleteReconciliation(app: App, id: bigint): Promise<void> {
	await withTx(app.db, {}, async (tx) => {
		await openForUpdate(tx, id);
		await tx.query(`DELETE FROM reconciliations WHERE id = $1`, [id]);
	});
}
