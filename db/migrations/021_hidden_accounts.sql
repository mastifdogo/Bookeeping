-- Accounts can be hidden from the pages where accounts are listed and picked
-- (they still count in reports and balances). Clearing accounts are hidden
-- unless a person shows them (Settings → Clearing accounts).
ALTER TABLE accounts ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT false;
UPDATE accounts SET hidden = true WHERE kind = 'clearing';
