-- Links between journal entries: an invoice's entry and the payment that
-- settled it, a bill and its payment, a transfer's two halves, a refund and
-- the sale it undoes. A person makes them on an entry's page, a module
-- through ctx.ledger.relateEntries; opening an entry then shows every entry
-- linked to it. Entries stay as posted; links are set and taken off freely.
--
-- A link has no direction: the pair is stored once, lower id first.
CREATE TABLE journal_entry_relations (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id   BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    related_id BIGINT      NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
    -- What the link is, e.g. "payment of invoice 12" ('' for none).
    note       TEXT        NOT NULL DEFAULT '',
    -- The module that made it; NULL when a person did, on the entry's page.
    module_id  TEXT,
    created_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entry_relations_order CHECK (entry_id < related_id),
    CONSTRAINT journal_entry_relations_once UNIQUE (entry_id, related_id),
    CONSTRAINT journal_entry_relations_note CHECK (length(note) <= 200),
    CONSTRAINT journal_entry_relations_module CHECK (module_id IS NULL OR module_id ~ '^[a-z][a-z0-9-]{1,31}$')
);
CREATE INDEX journal_entry_relations_related_idx ON journal_entry_relations (related_id);
