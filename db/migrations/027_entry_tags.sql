-- Tags on journal entries, shared by Ledger and every module: one place to
-- say an entry is paid, billed or overdue, or which customer or vendor it
-- belongs to, so a tag one module sets is seen by all the others. Entries
-- stay as posted; tags are set and taken off freely.
--
-- A plain tag (paid, billed, overdue, or any word a module agrees on) is on
-- an entry once. The tags "customer" and "vendor" carry who (entity_id); an
-- entry can have several of each.
CREATE TABLE journal_entry_tags (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id   BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    tag        TEXT        NOT NULL,
    entity_id  BIGINT      REFERENCES entities (id) ON DELETE RESTRICT,
    note       TEXT        NOT NULL DEFAULT '',
    -- The module that set it; NULL when a person did, on the entry's page.
    module_id  TEXT,
    created_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_tags_tag CHECK (tag ~ '^[a-z][a-z0-9_-]{0,39}$'),
    CONSTRAINT journal_entry_tags_note CHECK (length(note) <= 200),
    CONSTRAINT journal_entry_tags_entity CHECK ((tag IN ('customer', 'vendor')) = (entity_id IS NOT NULL)),
    CONSTRAINT journal_entry_tags_module CHECK (module_id IS NULL OR module_id ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT journal_entry_tags_once UNIQUE NULLS NOT DISTINCT (entry_id, tag, entity_id)
);
CREATE INDEX journal_entry_tags_tag_idx ON journal_entry_tags (tag, entry_id);
CREATE INDEX journal_entry_tags_entity_idx ON journal_entry_tags (entity_id) WHERE entity_id IS NOT NULL;
