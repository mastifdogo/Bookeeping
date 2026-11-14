-- A reconciliation can carry the statement it is checked against (a document,
-- shown beside the transactions) and what the AI read from it: the statement's
-- dates, balances and lines, and which journal lines it matched them to.
ALTER TABLE reconciliations ADD COLUMN document_id BIGINT REFERENCES documents (id) ON DELETE SET NULL;
ALTER TABLE reconciliations ADD COLUMN reading JSONB;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_reading CHECK (reading IS NULL OR jsonb_typeof(reading) = 'object');
