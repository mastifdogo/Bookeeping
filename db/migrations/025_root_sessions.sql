-- Root mode, wider: delete any entry or line, change any line's account or
-- amount, and leave an entry unbalanced or with a single line while working.
-- Root mode can only be left with the books intact (every entry at least two
-- lines and balanced in each currency); otherwise everything done in that
-- root session is reversed. Each time root mode is turned on is one root
-- session; its actions carry its id.
ALTER TABLE sessions ADD COLUMN root_session TEXT;
ALTER TABLE root_actions ADD COLUMN session TEXT;
CREATE INDEX root_actions_session_idx ON root_actions (session) WHERE session IS NOT NULL;

ALTER TABLE root_actions DROP CONSTRAINT root_actions_action;
ALTER TABLE root_actions ADD CONSTRAINT root_actions_action CHECK (action IN (
    'account.update', 'account.delete', 'user.update', 'user.delete',
    'entry.delete', 'line.delete', 'line.update', 'module.delete', 'module.update'));

-- The balance checks step aside for a root action (ledger.root is set for
-- that transaction only); the app checks the books when root mode is left.
CREATE OR REPLACE FUNCTION trg_transactions_check_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM assert_journal_entry_balanced(NEW.journal_entry_id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_journal_entries_check_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM assert_journal_entry_balanced(NEW.id);
    RETURN NULL;
END;
$$;

-- A line put back by reversing a root action belongs to an entry posted
-- long ago: the "already posted" guard steps aside for root as well.
CREATE OR REPLACE FUNCTION trg_transactions_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_txid   BIGINT;
    v_active BOOLEAN;
BEGIN
    IF current_setting('ledger.root', true) = 'on' THEN
        RETURN NEW;
    END IF;
    SELECT created_txid INTO v_txid FROM journal_entries WHERE id = NEW.journal_entry_id;
    -- A missing entry is left for the foreign key to report.
    IF FOUND AND v_txid <> txid_current() THEN
        RAISE EXCEPTION 'journal entry % is already posted; lines cannot be added to it', NEW.journal_entry_id
              USING ERRCODE = 'restrict_violation',
                    CONSTRAINT = 'journal_entry_immutable';
    END IF;

    SELECT is_active INTO v_active FROM accounts WHERE id = NEW.account_id;
    IF FOUND AND NOT v_active THEN
        RAISE EXCEPTION 'account % is inactive and cannot receive postings', NEW.account_id
              USING ERRCODE = 'check_violation',
                    CONSTRAINT = 'account_active';
    END IF;

    RETURN NEW;
END;
$$;

-- An entry put back by reversing a root action keeps when it was posted.
CREATE OR REPLACE FUNCTION trg_journal_entries_stamp_txid() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_txid := txid_current();
    IF current_setting('ledger.root', true) = 'on' AND NEW.posted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    NEW.posted_at    := now();
    RETURN NEW;
END;
$$;

-- Set once the root session an action belongs to was left with the books
-- intact; a session that ended any other way (it timed out) is checked, and
-- reversed if it left the books broken.
ALTER TABLE root_actions ADD COLUMN closed BOOLEAN NOT NULL DEFAULT false;
UPDATE root_actions SET closed = true;
