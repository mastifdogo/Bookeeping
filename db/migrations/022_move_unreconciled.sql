-- A posted line can be moved to another account of the same currency, and
-- every move is kept. Ledger uses it when a reconciliation is finished: the
-- lines of the reconciled account left unticked move to the Unreconciled
-- clearing account, and from there a person moves each to where it belongs
-- (back to the bank once it clears, or to another account).
--
-- Like an amount change (migration 019), the database writes the log itself
-- and only inside a transaction that has said who is making the change
-- (SET LOCAL ledger.amend_by); ledger.amend_reconciliation names the
-- reconciliation that moved it, so undoing that reconciliation moves it back.
CREATE TABLE transaction_moves (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id    BIGINT      NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
    journal_entry_id  BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    old_account_id    BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    new_account_id    BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    reconciliation_id BIGINT      REFERENCES reconciliations (id) ON DELETE SET NULL,
    reason            TEXT        NOT NULL DEFAULT '',
    changed_by        BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT transaction_moves_differs CHECK (old_account_id <> new_account_id),
    CONSTRAINT transaction_moves_reason CHECK (length(reason) <= 500)
);
CREATE INDEX transaction_moves_entry_idx ON transaction_moves (journal_entry_id, id);
CREATE INDEX transaction_moves_line_idx ON transaction_moves (transaction_id, id);
CREATE INDEX transaction_moves_rec_idx ON transaction_moves (reconciliation_id) WHERE reconciliation_id IS NOT NULL;

-- Only reconciliation_id may change (set to NULL when that reconciliation is deleted).
CREATE FUNCTION trg_transaction_moves_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.id = OLD.id AND NEW.transaction_id = OLD.transaction_id
       AND NEW.journal_entry_id = OLD.journal_entry_id AND NEW.old_account_id = OLD.old_account_id
       AND NEW.new_account_id = OLD.new_account_id AND NEW.reason = OLD.reason
       AND NEW.changed_by IS NOT DISTINCT FROM OLD.changed_by AND NEW.changed_at = OLD.changed_at
       AND NEW.reconciliation_id IS NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% on % is not allowed: the log of moves is kept as written', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation', CONSTRAINT = 'transaction_moves_immutable';
END;
$$;
CREATE TRIGGER transaction_moves_no_update_delete
    BEFORE UPDATE OR DELETE ON transaction_moves
    FOR EACH ROW EXECUTE FUNCTION trg_transaction_moves_before_change();
CREATE TRIGGER transaction_moves_no_truncate
    BEFORE TRUNCATE ON transaction_moves
    FOR EACH STATEMENT EXECUTE FUNCTION trg_reject_modification();

-- A posted line: deleting it is refused, and so is every change except to
-- its amount (logged in transaction_changes) or its account (logged in
-- transaction_moves), one at a time, inside a transaction that has said who
-- is making it. A line ticked on a reconciliation keeps both.
CREATE OR REPLACE FUNCTION trg_transactions_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who    TEXT := nullif(current_setting('ledger.amend_by', true), '');
    rec    TEXT := nullif(current_setting('ledger.amend_reconciliation', true), '');
    active BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE'
       AND who IS NOT NULL
       AND NEW.id = OLD.id AND NEW.journal_entry_id = OLD.journal_entry_id
       AND NEW.currency = OLD.currency AND NEW.line_number = OLD.line_number AND NEW.memo = OLD.memo THEN
        IF NEW.amount = OLD.amount AND NEW.account_id = OLD.account_id THEN
            RETURN NEW;
        END IF;
        IF NEW.amount <> OLD.amount AND NEW.account_id <> OLD.account_id THEN
            RAISE EXCEPTION 'change a line''s amount and its account one at a time'
                  USING ERRCODE = 'restrict_violation', CONSTRAINT = 'transactions_immutable';
        END IF;
        IF EXISTS (SELECT 1 FROM reconciliation_lines WHERE transaction_id = OLD.id) THEN
            RAISE EXCEPTION 'line % is ticked on a reconciliation; its % cannot be changed', OLD.id,
                  CASE WHEN NEW.amount <> OLD.amount THEN 'amount' ELSE 'account' END
                  USING ERRCODE = 'restrict_violation', CONSTRAINT = 'transactions_reconciled';
        END IF;
        IF NEW.amount <> OLD.amount THEN
            INSERT INTO transaction_changes (transaction_id, journal_entry_id, old_amount, new_amount, reason, changed_by)
            VALUES (OLD.id, OLD.journal_entry_id, OLD.amount, NEW.amount,
                    left(coalesce(current_setting('ledger.amend_reason', true), ''), 500),
                    CASE WHEN who ~ '^[0-9]+$' THEN who::bigint END);
            RETURN NEW;
        END IF;
        SELECT is_active INTO active FROM accounts WHERE id = NEW.account_id;
        IF NOT coalesce(active, false) THEN
            RAISE EXCEPTION 'account % is inactive and cannot receive postings', NEW.account_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'account_active';
        END IF;
        INSERT INTO transaction_moves (transaction_id, journal_entry_id, old_account_id, new_account_id, reconciliation_id, reason, changed_by)
        VALUES (OLD.id, OLD.journal_entry_id, OLD.account_id, NEW.account_id,
                CASE WHEN rec ~ '^[0-9]+$' THEN rec::bigint END,
                left(coalesce(current_setting('ledger.amend_reason', true), ''), 500),
                CASE WHEN who ~ '^[0-9]+$' THEN who::bigint END);
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% on % is not allowed: posted ledger records are immutable; post a reversing entry instead',
                    TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation',
                CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;
