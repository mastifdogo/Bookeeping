-- An account's code can be changed (renumbering the chart of accounts).
-- Journal lines point at the account, not its code, so the books don't
-- change; Ledger rewrites the code where modules keep it (accounts.ts) and
-- records each change here.
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
       AND EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id) THEN
        RAISE EXCEPTION 'account % has postings; its type cannot be changed', OLD.id
              USING ERRCODE = 'restrict_violation', CONSTRAINT = 'account_type_immutable';
    END IF;

    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TABLE account_code_changes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    old_code   TEXT        NOT NULL,
    new_code   TEXT        NOT NULL,
    changed_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_code_changes_account_idx ON account_code_changes (account_id, id DESC);
