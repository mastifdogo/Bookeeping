-- Clearing accounts: in-between accounts where one side of a transaction is
-- posted now and the other side later (by a module, another module or a
-- person), so the account comes back to zero. A module creates its own
-- (ctx.ledger.clearingAccount) and Ledger shows what is still sitting in them.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind CHECK (
    kind IS NULL
    OR (kind IN ('chequing', 'savings') AND type = 'asset')
    OR (kind = 'credit_card' AND type = 'liability')
    OR (kind = 'clearing' AND type IN ('asset', 'liability')));

-- The module that made the account and its own name for it. The code can be
-- changed by a person; these two find the account again whatever its code.
ALTER TABLE accounts ADD COLUMN module_id TEXT;
ALTER TABLE accounts ADD COLUMN module_key TEXT;
ALTER TABLE accounts ADD CONSTRAINT accounts_module CHECK (
    (module_id IS NULL AND module_key IS NULL)
    OR (module_id ~ '^[a-z][a-z0-9-]{1,31}$' AND module_key ~ '^[a-z][a-z0-9_-]{0,39}$'));
CREATE UNIQUE INDEX accounts_module_key ON accounts (module_id, module_key, currency) WHERE module_id IS NOT NULL;
