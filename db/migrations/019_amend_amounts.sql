-- The amounts of a posted entry can be corrected, and every such change is
-- kept. Nothing else about a posted line can change, and lines still can't be
-- added or removed: an entry is otherwise corrected with a reversing entry.
--
-- The log is written by the database itself, in the same statement as the
-- change, so no path (Ledger, a module, SQL by hand) changes an amount
-- without leaving a row here.
CREATE TABLE transaction_changes (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id   BIGINT      NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
    journal_entry_id BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    -- Signed like transactions.amount: debits positive, credits negative.
    old_amount       BIGINT      NOT NULL,
    new_amount       BIGINT      NOT NULL,
    reason           TEXT        NOT NULL DEFAULT '',
    changed_by       BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT transaction_changes_differs CHECK (old_amount <> new_amount),
    CONSTRAINT transaction_changes_reason CHECK (length(reason) <= 500)
);
CREATE INDEX transaction_changes_entry_idx ON transaction_changes (journal_entry_id, id);
CREATE INDEX transaction_changes_line_idx ON transaction_changes (transaction_id, id);

CREATE TRIGGER transaction_changes_no_update_delete
    BEFORE UPDATE OR DELETE ON transaction_changes
    FOR EACH ROW EXECUTE FUNCTION trg_reject_modification();
CREATE TRIGGER transaction_changes_no_truncate
    BEFORE TRUNCATE ON transaction_changes
    FOR EACH STATEMENT EXECUTE FUNCTION trg_reject_modification();

-- A posted line: deleting it is refused, and so is every change except to
-- its amount, which is allowed only inside a transaction that has said who
-- is making it (SET LOCAL ledger.amend_by = '<user id>', optionally
-- ledger.amend_reason) and is logged.
CREATE FUNCTION trg_transactions_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who TEXT := nullif(current_setting('ledger.amend_by', true), '');
BEGIN
    IF TG_OP = 'UPDATE'
       AND who IS NOT NULL
       AND NEW.id = OLD.id AND NEW.journal_entry_id = OLD.journal_entry_id AND NEW.account_id = OLD.account_id
       AND NEW.currency = OLD.currency AND NEW.line_number = OLD.line_number AND NEW.memo = OLD.memo THEN
        IF NEW.amount = OLD.amount THEN
            RETURN NEW;
        END IF;
        IF EXISTS (SELECT 1 FROM reconciliation_lines WHERE transaction_id = OLD.id) THEN
            RAISE EXCEPTION 'line % is ticked on a reconciliation; its amount cannot be changed', OLD.id
                  USING ERRCODE = 'restrict_violation', CONSTRAINT = 'transactions_reconciled';
        END IF;
        INSERT INTO transaction_changes (transaction_id, journal_entry_id, old_amount, new_amount, reason, changed_by)
        VALUES (OLD.id, OLD.journal_entry_id, OLD.amount, NEW.amount,
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

DROP TRIGGER transactions_no_update_delete ON transactions;
CREATE TRIGGER transactions_no_update_delete
    BEFORE UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_transactions_before_change();

-- A changed entry must still balance (checked at COMMIT, like a new one).
CREATE CONSTRAINT TRIGGER transactions_balanced_after_change
    AFTER UPDATE ON transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_transactions_check_balance();
