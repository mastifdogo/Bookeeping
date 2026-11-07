-- Runs once, as the module's own database role, in its own schema (__SCHEMA__).
-- No BEGIN/COMMIT, CREATE SCHEMA or GRANT: Ledger handles those.
CREATE TABLE items (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
