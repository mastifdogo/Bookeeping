-- Documents: PDFs (and scans) of receipts, statements and invoices, imported
-- by a person or a module or created in Ledger. The files live on the data
-- share (documents.ts); this is their index, shared with modules
-- (ctx.documents).
CREATE TABLE documents (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT        NOT NULL,
    -- imported: brought in from outside; created: made in Ledger (an invoice a module drew up, a report).
    origin       TEXT        NOT NULL DEFAULT 'imported',
    -- Who added it: 'user', or a module's id.
    source       TEXT        NOT NULL DEFAULT 'user',
    title        TEXT        NOT NULL,
    filename     TEXT        NOT NULL,
    -- Where the file is, below the organization's documents folder: receipts/2026/12-hydro.pdf
    path         TEXT        NOT NULL UNIQUE,
    content_type TEXT        NOT NULL,
    size_bytes   INTEGER     NOT NULL,
    sha256       TEXT        NOT NULL,
    -- The date on the document (not when it was added).
    doc_date     DATE,
    entity_id    BIGINT      REFERENCES entities (id) ON DELETE SET NULL,
    note         TEXT        NOT NULL DEFAULT '',
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT documents_kind CHECK (kind IN ('receipt', 'statement', 'invoice', 'other')),
    CONSTRAINT documents_origin CHECK (origin IN ('imported', 'created')),
    CONSTRAINT documents_source CHECK (source = 'user' OR source ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT documents_text CHECK (length(title) BETWEEN 1 AND 200 AND length(filename) BETWEEN 1 AND 255 AND length(note) <= 2000),
    CONSTRAINT documents_size CHECK (size_bytes > 0)
);
CREATE INDEX documents_list_idx ON documents (kind, id DESC);
CREATE INDEX documents_sha_idx ON documents (sha256);

-- What each module did with a document, so it can ask for the ones it hasn't handled.
CREATE TABLE document_marks (
    document_id BIGINT      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    module      TEXT        NOT NULL,
    status      TEXT        NOT NULL,
    note        TEXT        NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, module),
    CONSTRAINT document_marks_module CHECK (module ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT document_marks_status CHECK (status IN ('done', 'skipped')),
    CONSTRAINT document_marks_note CHECK (length(note) <= 500)
);
