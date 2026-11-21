-- An entry's page has one "Edit": besides its date (migration 023), its
-- lines' amounts (019) and accounts (022), a person can now change an entry's
-- description, reference and customer or vendor, and a line's memo. Every
-- such change is kept here as text, what it was and what it is now, and is
-- shown with the other changes under the entry.
CREATE TABLE journal_entry_edits (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    journal_entry_id BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    -- The line, for a memo; NULL for the entry's own fields.
    transaction_id   BIGINT      REFERENCES transactions (id) ON DELETE RESTRICT,
    field            TEXT        NOT NULL,
    -- For "entity" the customer's or vendor's name; '' is none.
    old_value        TEXT        NOT NULL,
    new_value        TEXT        NOT NULL,
    reason           TEXT        NOT NULL DEFAULT '',
    changed_by       BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_edits_field CHECK (field IN ('description', 'reference', 'entity', 'memo')),
    CONSTRAINT journal_entry_edits_line CHECK ((field = 'memo') = (transaction_id IS NOT NULL)),
    CONSTRAINT journal_entry_edits_reason CHECK (length(reason) <= 500)
);
CREATE INDEX journal_entry_edits_entry_idx ON journal_entry_edits (journal_entry_id, id);
CREATE INDEX journal_entry_edits_line_idx ON journal_entry_edits (transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TRIGGER journal_entry_edits_no_update_delete
    BEFORE UPDATE OR DELETE ON journal_entry_edits
    FOR EACH ROW EXECUTE FUNCTION trg_reject_modification();
CREATE TRIGGER journal_entry_edits_no_truncate
    BEFORE TRUNCATE ON journal_entry_edits
    FOR EACH STATEMENT EXECUTE FUNCTION trg_reject_modification();

-- A posted entry's header: its date, description, reference and customer or
-- vendor can change, inside a transaction that has said who is making the
-- change (SET LOCAL ledger.amend_by); each is logged. Nothing else can, and
-- the entry can't be deleted (outside root mode, migration 024).
CREATE OR REPLACE FUNCTION trg_journal_entries_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who    TEXT := nullif(current_setting('ledger.amend_by', true), '');
    reason TEXT := left(coalesce(current_setting('ledger.amend_reason', true), ''), 500);
    by_id  BIGINT;
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND who IS NOT NULL
       AND (to_jsonb(NEW) - '{entry_date,description,reference,entity_id}'::text[])
         = (to_jsonb(OLD) - '{entry_date,description,reference,entity_id}'::text[]) THEN
        by_id := CASE WHEN who ~ '^[0-9]+$' THEN who::bigint END;
        IF NEW.entry_date <> OLD.entry_date THEN
            IF EXISTS (SELECT 1 FROM reconciliation_lines l JOIN transactions t ON t.id = l.transaction_id WHERE t.journal_entry_id = OLD.id) THEN
                RAISE EXCEPTION 'entry % has a line ticked on a reconciliation; its date cannot be changed', OLD.id
                      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'journal_entries_reconciled';
            END IF;
            INSERT INTO journal_entry_date_changes (journal_entry_id, old_date, new_date, reason, changed_by)
            VALUES (OLD.id, OLD.entry_date, NEW.entry_date, reason, by_id);
        END IF;
        IF NEW.description <> OLD.description THEN
            INSERT INTO journal_entry_edits (journal_entry_id, field, old_value, new_value, reason, changed_by)
            VALUES (OLD.id, 'description', OLD.description, NEW.description, reason, by_id);
        END IF;
        IF NEW.reference <> OLD.reference THEN
            INSERT INTO journal_entry_edits (journal_entry_id, field, old_value, new_value, reason, changed_by)
            VALUES (OLD.id, 'reference', OLD.reference, NEW.reference, reason, by_id);
        END IF;
        IF NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
            INSERT INTO journal_entry_edits (journal_entry_id, field, old_value, new_value, reason, changed_by)
            VALUES (OLD.id, 'entity',
                    coalesce((SELECT name FROM entities WHERE id = OLD.entity_id), ''),
                    coalesce((SELECT name FROM entities WHERE id = NEW.entity_id), ''),
                    reason, by_id);
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% on % is not allowed: posted ledger records are immutable; post a reversing entry instead',
                    TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation',
                CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;

-- A posted line: its memo can change too (logged above), with or without
-- its amount or account. Those two keep the rules of migrations 019 and 022.
CREATE OR REPLACE FUNCTION trg_transactions_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who    TEXT := nullif(current_setting('ledger.amend_by', true), '');
    rec    TEXT := nullif(current_setting('ledger.amend_reconciliation', true), '');
    active BOOLEAN;
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND who IS NOT NULL
       AND NEW.id = OLD.id AND NEW.journal_entry_id = OLD.journal_entry_id
       AND NEW.currency = OLD.currency AND NEW.line_number = OLD.line_number THEN
        IF NEW.amount <> OLD.amount AND NEW.account_id <> OLD.account_id THEN
            RAISE EXCEPTION 'change a line''s amount and its account one at a time'
                  USING ERRCODE = 'restrict_violation', CONSTRAINT = 'transactions_immutable';
        END IF;
        IF NEW.memo <> OLD.memo THEN
            INSERT INTO journal_entry_edits (journal_entry_id, transaction_id, field, old_value, new_value, reason, changed_by)
            VALUES (OLD.journal_entry_id, OLD.id, 'memo', OLD.memo, NEW.memo,
                    left(coalesce(current_setting('ledger.amend_reason', true), ''), 500),
                    CASE WHEN who ~ '^[0-9]+$' THEN who::bigint END);
        END IF;
        IF NEW.amount = OLD.amount AND NEW.account_id = OLD.account_id THEN
            RETURN NEW;
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
