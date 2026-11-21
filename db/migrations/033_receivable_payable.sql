-- Accounts receivable and accounts payable are tagged, like bank accounts
-- are: Ledger and every module then agree on where a customer's invoice
-- (receivable) and a vendor's bill or receipt (payable) are posted, whatever
-- the account's code or name.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind CHECK (
    kind IS NULL
    OR (kind IN ('chequing', 'savings', 'receivable') AND type = 'asset')
    OR (kind IN ('credit_card', 'payable') AND type = 'liability')
    OR (kind = 'clearing' AND type IN ('asset', 'liability')));

-- The accounts already here under those names get the tag.
UPDATE accounts SET kind = 'receivable'
 WHERE kind IS NULL AND type = 'asset'
   AND name ~* '^\s*(accounts?\s+)?receivables?(\s*\(a/r\))?\s*$';
UPDATE accounts SET kind = 'payable'
 WHERE kind IS NULL AND type = 'liability'
   AND name ~* '^\s*(accounts?\s+)?payables?(\s*\(a/p\))?\s*$';
