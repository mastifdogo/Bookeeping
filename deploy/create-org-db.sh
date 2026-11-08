#!/bin/sh
# Creates the database for one organization (a separate set of books), with
# the same roles, schema, migrations and grants as the main database. Safe to
# re-run. Run as root by `ledger update run` when the app asks for a new
# organization; the roles must already exist (setup-db.sh).
#
#   DB_NAME=ledger_org2 sh create-org-db.sh
#
# Environment: DB_NAME (required), OWNER_ROLE=ledger_owner, APP_ROLE=ledger_app,
# SQL_DIR, PSQL as in setup-db.sh.
set -eu

DB_NAME="${DB_NAME:-}"
OWNER_ROLE="${OWNER_ROLE:-ledger_owner}"
APP_ROLE="${APP_ROLE:-ledger_app}"
PSQL="${PSQL:-runuser -u postgres -- psql}"

for name in "$DB_NAME" "$OWNER_ROLE" "$APP_ROLE"; do
	case "$name" in
	'' | [!a-z_]* | *[!a-z0-9_]*) echo "invalid name '$name': use lowercase letters, digits and _" >&2; exit 1 ;;
	esac
done

here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${SQL_DIR:-}" ]; then
	if [ -f /usr/local/share/ledger/schema.sql ]; then SQL_DIR=/usr/local/share/ledger; else SQL_DIR="$here/../db"; fi
fi
[ -f "$SQL_DIR/schema.sql" ] && [ -f "$SQL_DIR/grants.sql" ] || { echo "schema.sql/grants.sql not found in $SQL_DIR" >&2; exit 1; }

psql_su() { $PSQL -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "==> database $DB_NAME"
psql_su -d postgres -v db="$DB_NAME" -v owner="$OWNER_ROLE" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', :'db', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
psql_su -d "$DB_NAME" -v db="$DB_NAME" -v owner="$OWNER_ROLE" -v app="$APP_ROLE" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'app') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

has_schema=$(echo "SELECT to_regclass('public.journal_entries') IS NOT NULL" | psql_su -tA -d "$DB_NAME")
if [ "$has_schema" != "t" ]; then
	{ echo "SET ROLE $OWNER_ROLE;"; cat "$SQL_DIR/schema.sql"; } | psql_su -d "$DB_NAME"
fi

DB_NAME="$DB_NAME" OWNER_ROLE="$OWNER_ROLE" APP_ROLE="$APP_ROLE" SQL_DIR="$SQL_DIR" PSQL="$PSQL" \
	sh "$here/migrate-db.sh"
echo "done."
