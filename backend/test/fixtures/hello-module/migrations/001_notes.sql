-- Runs once, as the module's own database role, in its own schema (mod_hello).
-- Ledger grants the app read/write access to what is created here.
CREATE TABLE notes (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
