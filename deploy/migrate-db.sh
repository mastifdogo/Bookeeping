#!/bin/sh
# Applies database migrations (db/migrations/NNN_name.sql) that have not run
# yet, then re-applies the app role's grants. Safe to re-run. Called by
# setup-db.sh (new databases) and install.sh (upgrades).
#
# Each migration runs once, in file-name order, as the owner role, in its own
# transaction; applied files are recorded in public.schema_migrations.
#
# Environment (all optional; defaults match setup-db.sh):
#   DB_NAME=ledger  OWNER_ROLE=ledger_owner  APP_ROLE=ledger_app
#   SQL_DIR=...     directory with grants.sql and migrations/
#   PSQL="runuser -u postgres -- psql"
set -eu

DB_NAME="${DB_NAME:-ledger}"
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
	if [ -f /usr/local/share/ledger/grants.sql ]; then SQL_DIR=/usr/local/share/ledger; else SQL_DIR="$here/../db"; fi
fi
[ -f "$SQL_DIR/grants.sql" ] || { echo "grants.sql not found in $SQL_DIR" >&2; exit 1; }

psql_su() { $PSQL -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "==> migrations"
{ echo "SET client_min_messages = warning; SET ROLE $OWNER_ROLE;"; cat <<'SQL'; } | psql_su -d "$DB_NAME"
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
applied=$(echo "SELECT name FROM public.schema_migrations" | psql_su -tA -d "$DB_NAME")
count=0
for f in "$SQL_DIR"/migrations/[0-9]*.sql; do
	[ -f "$f" ] || continue
	name=$(basename "$f")
	case "$name" in *[!A-Za-z0-9_.-]*) echo "skipping oddly named $name" >&2; continue ;; esac
	if printf '%s\n' "$applied" | grep -qx "$name"; then continue; fi
	echo "    applying $name"
	{
		echo "BEGIN;"
		echo "SET LOCAL ROLE $OWNER_ROLE;"
		cat "$f"
		echo ";"
		echo "INSERT INTO public.schema_migrations (name) VALUES ('$name');"
		echo "COMMIT;"
	} | psql_su -d "$DB_NAME" -v app_role="$APP_ROLE"
	count=$((count + 1))
done
[ "$count" -gt 0 ] || echo "    up to date"

echo "==> grants for $APP_ROLE"
{ echo "SET ROLE $OWNER_ROLE;"; cat "$SQL_DIR/grants.sql"; } | psql_su -d "$DB_NAME" -v app_role="$APP_ROLE"
