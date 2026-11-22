-- Each customer has an account of their own under accounts receivable, and
-- each vendor one under accounts payable (a sub-account, made the first
-- time something is posted for them, one per currency). What a customer
-- owes, or what a vendor is owed, is then that account's balance, and the
-- account a line sits in says whose it is: an entry's receivable or payable
-- line no longer needs a "customer" or "vendor" tag for that.
ALTER TABLE accounts ADD COLUMN entity_id BIGINT REFERENCES entities (id) ON DELETE RESTRICT;
ALTER TABLE accounts ADD COLUMN entity_role TEXT;
ALTER TABLE accounts ADD CONSTRAINT accounts_entity CHECK (
    (entity_id IS NULL AND entity_role IS NULL)
    OR (entity_id IS NOT NULL AND kind IS NULL
        AND ((entity_role = 'customer' AND type = 'asset') OR (entity_role = 'vendor' AND type = 'liability'))));
CREATE UNIQUE INDEX accounts_entity_unique ON accounts (entity_id, entity_role, currency) WHERE entity_id IS NOT NULL;

-- The entries already here: a line in accounts receivable of an entry that
-- is a customer's (tagged "customer", or posted with that customer), and a
-- line in accounts payable of a vendor's entry, move to that customer's or
-- vendor's own account. Each move is logged on the entry like any other
-- change of a line's account. Lines ticked on a reconciliation stay, and so
-- do entries tagged with several customers or several vendors: nothing says
-- whose the line is.
CREATE TEMP TABLE entity_moves ON COMMIT DROP AS
WITH control AS (
    SELECT t.id AS line_id, t.journal_entry_id AS entry_id, t.line_number, t.account_id AS control_id, a.currency,
           CASE a.kind WHEN 'receivable' THEN 'customer' ELSE 'vendor' END AS role
      FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.kind IN ('receivable', 'payable')
       AND NOT EXISTS (SELECT 1 FROM reconciliation_lines r WHERE r.transaction_id = t.id)
), own AS (
    SELECT c.*,
           (SELECT count(*) FROM journal_entry_tags jt WHERE jt.entry_id = c.entry_id AND jt.tag = c.role) AS tagged,
           (SELECT min(jt.entity_id) FROM journal_entry_tags jt WHERE jt.entry_id = c.entry_id AND jt.tag = c.role) AS tag_entity,
           (SELECT e.entity_id FROM journal_entries e JOIN entities n ON n.id = e.entity_id
             WHERE e.id = c.entry_id AND CASE c.role WHEN 'customer' THEN n.is_customer ELSE n.is_vendor END) AS entry_entity
      FROM control c
), direct AS (
    SELECT line_id, entry_id, line_number, control_id, currency, role,
           CASE WHEN tagged = 1 THEN tag_entity
                WHEN tagged = 0 THEN entry_entity
                -- Several: the one the entry was posted with, when it is one of them.
                WHEN EXISTS (SELECT 1 FROM journal_entry_tags jt WHERE jt.entry_id = own.entry_id AND jt.tag = own.role AND jt.entity_id = own.entry_entity) THEN entry_entity
           END AS entity_id
      FROM own
)
SELECT line_id, control_id, currency, role, entity_id FROM direct WHERE entity_id IS NOT NULL
UNION ALL
-- An entry and the one that reverses it mirror each other: the other one's
-- line goes along, so the customer's or vendor's account nets to zero.
SELECT c.line_id, c.control_id, c.currency, c.role, d.entity_id
  FROM control c
  JOIN journal_entries e ON e.id = c.entry_id
  JOIN journal_entries o ON o.id = e.reverses_id OR o.reverses_id = e.id
  JOIN direct d ON d.entry_id = o.id AND d.line_number = c.line_number AND d.control_id = c.control_id AND d.entity_id IS NOT NULL
 WHERE NOT EXISTS (SELECT 1 FROM direct mine WHERE mine.line_id = c.line_id AND mine.entity_id IS NOT NULL);

DO $$
DECLARE
    g     RECORD;
    v_base TEXT;
    v_code TEXT;
    n     INT;
    moved BIGINT;
BEGIN
    -- The accounts: under the receivable or payable account the lines were in, named after who it is.
    FOR g IN
        SELECT m.entity_id, m.role, m.currency, min(m.control_id) AS parent_id
          FROM entity_moves m GROUP BY m.entity_id, m.role, m.currency ORDER BY m.role, m.entity_id, m.currency
    LOOP
        SELECT p.code || '-' || g.entity_id INTO v_base FROM accounts p WHERE p.id = g.parent_id;
        IF length(v_base) > 32 THEN v_base := 'E' || g.entity_id || '-' || g.role; END IF;
        v_code := v_base;
        n := 1;
        WHILE EXISTS (SELECT 1 FROM accounts a WHERE a.code = v_code) LOOP
            n := n + 1;
            v_code := left(v_base, 32 - length('-' || n)) || '-' || n;
        END LOOP;
        INSERT INTO accounts (code, name, type, currency, description, parent_id, entity_id, entity_role)
        SELECT v_code, e.name, p.type, p.currency,
               CASE g.role WHEN 'customer' THEN 'What this customer owes: their invoices, less what they have paid.'
                           ELSE 'What this vendor is owed: their bills and receipts, less what was paid.' END,
               -- Under the account the lines were in, unless that is already as deep as the chart goes.
               CASE WHEN (WITH RECURSIVE up AS (SELECT x.id, x.parent_id, 1 AS d FROM accounts x WHERE x.id = p.id
                                                UNION ALL SELECT x.id, x.parent_id, up.d + 1 FROM accounts x JOIN up ON x.id = up.parent_id WHERE up.d < 20)
                          SELECT max(d) FROM up) < 5 THEN p.id END,
               e.id, g.role
          FROM accounts p, entities e WHERE p.id = g.parent_id AND e.id = g.entity_id;
    END LOOP;

    -- The moves, logged by the database (transaction_moves) as made by Ledger itself.
    PERFORM set_config('ledger.amend_by', 'system', true),
            set_config('ledger.amend_reason', 'Moved to the customer''s or vendor''s own account (customers and vendors are tracked by account)', true);
    UPDATE transactions t SET account_id = a.id
      FROM entity_moves m JOIN accounts a ON a.entity_id = m.entity_id AND a.entity_role = m.role AND a.currency = m.currency
     WHERE t.id = m.line_id AND t.account_id <> a.id;
    GET DIAGNOSTICS moved = ROW_COUNT;
    PERFORM set_config('ledger.amend_by', '', true), set_config('ledger.amend_reason', '', true);
    RAISE NOTICE 'customers and vendors by account: % line(s) moved', moved;
END;
$$;

-- The account now says whose the entry is: the tag that said it goes.
DELETE FROM journal_entry_tags jt
 WHERE jt.tag IN ('customer', 'vendor')
   AND EXISTS (SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
                WHERE t.journal_entry_id = jt.entry_id AND a.entity_id = jt.entity_id AND a.entity_role = jt.tag);
