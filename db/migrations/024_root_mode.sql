-- Root mode: an admin can turn it on for their session (Settings → Account)
-- to delete and change bookkeeping accounts and users in ways that are
-- normally refused. A root action sets `ledger.root = 'on'` for its own
-- database transaction only (SET LOCAL); the guards below step aside for it.
-- Every root action is logged in root_actions with what it changed or
-- deleted, so it can be reversed.
ALTER TABLE sessions ADD COLUMN root BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE root_actions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action        TEXT        NOT NULL,
    target        TEXT        NOT NULL,
    summary       TEXT        NOT NULL,
    -- What the action changed or deleted, enough to put it back.
    undo          JSONB       NOT NULL,
    -- Names, not ids: the user who did it may be deleted later.
    done_by       TEXT        NOT NULL,
    done_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversed_by   TEXT,
    reversed_at   TIMESTAMPTZ,

    CONSTRAINT root_actions_action CHECK (action IN ('account.update', 'account.delete', 'user.update', 'user.delete')),
    CONSTRAINT root_actions_reversed CHECK ((reversed_at IS NULL) = (reversed_by IS NULL))
);
CREATE INDEX root_actions_done_idx ON root_actions (done_at DESC);

-- The generic immutability guard (entries' logs, imports, users) lets root
-- actions change and delete rows (never TRUNCATE).
CREATE OR REPLACE FUNCTION trg_reject_modification() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_LEVEL = 'ROW' AND current_setting('ledger.root', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% on % is not allowed: posted ledger records are immutable; post a reversing entry instead',
                    TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation',
                CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;

-- Posted lines, entry headers and the log of moves: root may change any
-- column and delete; otherwise the rules of migrations 022 and 023 hold.
-- Accounts: root may change the type of an account with postings (the
-- currency stays fixed by the lines' foreign key).
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

CREATE OR REPLACE FUNCTION trg_transaction_moves_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION trg_journal_entries_before_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    who TEXT := nullif(current_setting('ledger.amend_by', true), '');
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION trg_accounts_before_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'account id cannot be changed'
              USING ERRCODE = 'restrict_violation', CONSTRAINT = 'account_id_immutable';
    END IF;

    IF NEW.currency <> OLD.currency
       AND EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id) THEN
        RAISE EXCEPTION 'account % has postings; its currency cannot be changed', OLD.code
              USING ERRCODE = 'restrict_violation', CONSTRAINT = 'account_currency_immutable';
    END IF;

    IF NEW.type <> OLD.type
       AND current_setting('ledger.root', true) IS DISTINCT FROM 'on'
       AND EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id) THEN
        RAISE EXCEPTION 'account % has postings; its type cannot be changed', OLD.id
              USING ERRCODE = 'restrict_violation', CONSTRAINT = 'account_type_immutable';
    END IF;

    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Accounts are deleted only by a root action.
CREATE TRIGGER accounts_no_delete
    BEFORE DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION trg_reject_modification();
