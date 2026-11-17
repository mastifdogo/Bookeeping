-- The tag "rate": how many of what, at what price, so a module's form (an
-- invoice line, a bill line, a timesheet) fills itself in from the entry.
-- quantity and unit say how many of what (7.5 hours, 40 litres); rate_cents
-- is the price of one unit in the entry's currency. Only "rate" carries them.
ALTER TABLE journal_entry_tags
    ADD COLUMN quantity   NUMERIC(18, 4),
    ADD COLUMN unit       TEXT,
    ADD COLUMN rate_cents BIGINT;
ALTER TABLE journal_entry_tags
    ADD CONSTRAINT journal_entry_tags_rate CHECK (
        (tag = 'rate') = (quantity IS NOT NULL OR rate_cents IS NOT NULL)
        AND (unit IS NULL OR (tag = 'rate' AND length(unit) BETWEEN 1 AND 20))
        AND (rate_cents IS NULL OR rate_cents >= 0)
    );

-- Where each tile of the dashboard goes and how big it is, per user
-- (Settings → UI). NULL: the standard layout.
ALTER TABLE user_settings ADD COLUMN dashboard JSONB;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_dashboard_object
    CHECK (dashboard IS NULL OR jsonb_typeof(dashboard) = 'object');
