-- The date of a posted entry can be corrected, and every such change is kept
-- (like amounts, migration 019, and accounts, migration 022). Nothing else
-- about an entry's header can change. Refused while any of its lines is
-- ticked on a reconciliation: the reconciled statement would no longer hold.
CREATE TABLE journal_entry_date_changes (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    journal_entry_id BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    old_date         DATE        NOT NULL,
    new_date         DATE        NOT NULL,
    reason           TEXT        NOT NULL DEFAULT '',
    changed_by       BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_date_changes_differs CHECK (old_date <> new_date),
    CONSTRAINT journal_entry_date_changes_reason CHECK (length(reason) <= 500)
);
CREATE INDEX journal_entry_date_changes_entry_idx ON journal_entry_date_changes (journal_entry_id, id);

CREATE TRIGGER journal_entry_date_changes_no_update_delete
    BEFORE UPDATE OR DELETE ON journal_entry_date_changes
    FOR EACH ROW EXECUTE FUNCTION trg_reject_modification();
CREATE TRIGGER journal_entry_date_changes_no_truncate
    BEFORE TRUNCATE ON journal_entry_date_changes
    FOR EACH STATEMENT EXECUTE FUNCTION trg_reject_modification();

-- A posted entry: deleting it is refused, and so is every change except to
-- its date, which is allowed only inside a transaction that has said who is
-- making it (SET LOCAL ledger.amend_by) and is logged.
CREATE FUNCTION trg_journal_entries_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who TEXT := nullif(current_setting('ledger.amend_by', true), '');
BEGIN
    IF TG_OP = 'UPDATE'
       AND who IS NOT NULL
       AND (to_jsonb(NEW) - 'entry_date') = (to_jsonb(OLD) - 'entry_date') THEN
        IF NEW.entry_date = OLD.entry_date THEN
            RETURN NEW;
        END IF;
        IF EXISTS (SELECT 1 FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id WHERE t.journal_entry_id = OLD.id) THEN
            RAISE EXCEPTION 'entry % has a line ticked on a reconciliation; its date cannot be changed', OLD.id
                  USING ERRCODE = 'restrict_violation', CONSTRAINT = 'journal_entries_reconciled';
        END IF;
        INSERT INTO journal_entry_date_changes (journal_entry_id, old_date, new_date, reason, changed_by)
        VALUES (OLD.id, OLD.entry_date, NEW.entry_date,
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

DROP TRIGGER journal_entries_no_update_delete ON journal_entries;
CREATE TRIGGER journal_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION trg_journal_entries_before_change();
