-- The tag "rate" becomes an item: description, quantity and rate (e.g.
-- "Labour, 7.5 hours, 80.00"), and an entry can carry several of them, one
-- per line of work or goods. Other tags stay once per entry (and per
-- customer or vendor); rate items are told apart by their id.
ALTER TABLE journal_entry_tags ADD COLUMN description TEXT;
ALTER TABLE journal_entry_tags
    ADD CONSTRAINT journal_entry_tags_description CHECK (
        description IS NULL OR (tag = 'rate' AND length(description) BETWEEN 1 AND 100)
    );
ALTER TABLE journal_entry_tags DROP CONSTRAINT journal_entry_tags_once;
CREATE UNIQUE INDEX journal_entry_tags_once ON journal_entry_tags (entry_id, tag, entity_id) NULLS NOT DISTINCT WHERE tag <> 'rate';
