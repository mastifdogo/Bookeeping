-- The bank, card or loan account a document belongs to: a statement's
-- account, so statements can be found per account and offered for the right
-- reconciliation. Set at import, or when a statement is first reconciled.
ALTER TABLE documents ADD COLUMN account_id BIGINT REFERENCES accounts (id) ON DELETE SET NULL;
CREATE INDEX documents_account_idx ON documents (account_id) WHERE account_id IS NOT NULL;
