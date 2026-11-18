-- One file store for Ledger and every module. Documents (migration 015) held
-- PDFs and scans; from here it holds any file a module or a person keeps
-- (CSV and OFX statements, saved emails, spreadsheets, exports), so modules
-- no longer keep files in tables or folders of their own.
--
-- Files get tags, shared by Ledger and every module like the tags on journal
-- entries (migration 027), and the data read out of a file is kept with it,
-- so a file is read once and every module finds what was read.

-- Tags on documents. A tag is on a document once; any module or a person can
-- set it or take it off. Standard ones: extracted, posted, paid, billed,
-- overdue; any other lowercase word is allowed.
CREATE TABLE document_tags (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id BIGINT      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    tag         TEXT        NOT NULL,
    note        TEXT        NOT NULL DEFAULT '',
    -- The module that set it; NULL when a person did, on the Documents page.
    module_id   TEXT,
    created_by  BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_tags_tag CHECK (tag ~ '^[a-z][a-z0-9_-]{0,39}$'),
    CONSTRAINT document_tags_note CHECK (length(note) <= 200),
    CONSTRAINT document_tags_module CHECK (module_id IS NULL OR module_id ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT document_tags_once UNIQUE (document_id, tag)
);
CREATE INDEX document_tags_tag_idx ON document_tags (tag, document_id);

-- What was read out of a document: its fields (vendor, date, total, lines,
-- transactions, ...) as JSON and, optionally, its plain text. One per
-- document, whichever module read it; a document that has one carries the tag
-- "extracted". Modules look here before reading a file again.
CREATE TABLE document_extractions (
    document_id BIGINT      PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    text        TEXT,
    -- The module that read it last; NULL when Ledger itself did.
    module_id   TEXT,
    created_by  BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_extractions_data CHECK (jsonb_typeof(data) = 'object'),
    CONSTRAINT document_extractions_module CHECK (module_id IS NULL OR module_id ~ '^[a-z][a-z0-9-]{1,31}$')
);

-- Files modules hand each other (migration 007) are documents too: the row
-- points at the document instead of carrying the bytes. Rows from before
-- keep their bytes until Ledger files them (at the next start).
ALTER TABLE module_files ADD COLUMN document_id BIGINT REFERENCES documents (id) ON DELETE SET NULL;
ALTER TABLE module_files ALTER COLUMN data DROP NOT NULL;
ALTER TABLE module_files DROP CONSTRAINT module_files_size;
ALTER TABLE module_files ADD CONSTRAINT module_files_size CHECK (data IS NULL OR size_bytes = octet_length(data));
CREATE INDEX module_files_document_idx ON module_files (document_id) WHERE document_id IS NOT NULL;
