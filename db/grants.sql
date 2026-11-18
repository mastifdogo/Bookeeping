-- Privileges for the application role. Run as the schema owner after
-- db/schema.sql, with the role name passed as a psql variable:
--
--   psql -v ON_ERROR_STOP=1 -v app_role=ledger_app -f db/grants.sql
--
-- The application role can read everything and append to the ledger, but it
-- owns nothing: it cannot alter tables, disable triggers, or UPDATE/DELETE
-- posted journal entries, lines or import records.

BEGIN;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

GRANT SELECT                          ON currencies                              TO :"app_role";
GRANT SELECT, INSERT, UPDATE          ON accounts                                TO :"app_role";
GRANT SELECT, INSERT                  ON journal_entries, transactions, csv_imports TO :"app_role";
-- Only a posted line's amount or account can change, and the database logs each change (migrations 019, 022).
GRANT UPDATE (amount, account_id)     ON transactions                            TO :"app_role";
-- And an entry's date (migration 023), logged the same way.
GRANT UPDATE (entry_date)             ON journal_entries                         TO :"app_role";
GRANT SELECT, INSERT                  ON transaction_changes                     TO :"app_role";
GRANT SELECT, INSERT, UPDATE          ON users                                   TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON sessions                                TO :"app_role";

-- Added by db/migrations (present once migrate-db.sh has run).
GRANT SELECT, INSERT, UPDATE, DELETE  ON dashboard_items                         TO :"app_role";
GRANT SELECT, INSERT, UPDATE          ON user_settings                           TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON reconciliations, reconciliation_lines   TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON module_settings                         TO :"app_role";
GRANT SELECT, INSERT, DELETE          ON llm_usage                               TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON module_files                            TO :"app_role";
GRANT SELECT, INSERT, UPDATE          ON organizations                           TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON memberships                             TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON journal_entry_links                     TO :"app_role";
GRANT SELECT, INSERT, UPDATE          ON entities                                TO :"app_role";
GRANT SELECT, INSERT                  ON account_code_changes                    TO :"app_role";
GRANT SELECT, INSERT                  ON transaction_moves                       TO :"app_role";
GRANT SELECT, INSERT                  ON journal_entry_date_changes              TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON journal_entry_tags                      TO :"app_role";
-- Root mode (migration 024): the database guards refuse these unless the
-- transaction has set ledger.root = 'on', and every root action is logged.
GRANT SELECT, INSERT, UPDATE          ON root_actions                            TO :"app_role";
GRANT DELETE                          ON journal_entries, transactions, accounts, users,
                                         transaction_changes, transaction_moves, journal_entry_date_changes,
                                         account_code_changes                    TO :"app_role";
GRANT UPDATE (created_by)             ON journal_entries                         TO :"app_role";
GRANT UPDATE (currency)               ON transactions                            TO :"app_role";
GRANT UPDATE (imported_by)            ON csv_imports                             TO :"app_role";
GRANT UPDATE (changed_by)             ON transaction_changes, transaction_moves, journal_entry_date_changes, account_code_changes TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON documents                               TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON document_marks                          TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE  ON document_tags, document_extractions     TO :"app_role";
-- Read-only, so pg_dump (run as this role for backups) can include it.
GRANT SELECT                          ON schema_migrations                       TO :"app_role";

-- Identity columns draw from sequences (SELECT lets pg_dump read them for backups).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

COMMIT;
