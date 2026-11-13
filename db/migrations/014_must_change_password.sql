-- A user who must choose a new password before doing anything else: set for
-- the first admin of a new server (whose password starts as 1234).
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
