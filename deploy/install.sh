#!/bin/sh
# Installs (or upgrades) Ledger from an unpacked release directory:
#   sudo sh deploy/install.sh
# Creates the `ledger` system user, installs the program (launcher in
# /usr/local/bin/ledger; server, web UI and Node.js runtime in
# /usr/local/lib/ledger), SQL files, helper scripts and systemd units, and
# creates /etc/ledger/ledger.env on first install. Existing configuration is
# never overwritten.
#
# Environment: LEDGER_UID (default 990) — fixed so the TrueNAS bind mount
# ownership can be mapped predictably (host uid = 100000 + LEDGER_UID for an
# unprivileged Proxmox container). CSV_DIR (default /app/csv_data).
set -eu

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
src=$(cd "$(dirname "$0")/.." && pwd)
LEDGER_UID="${LEDGER_UID:-990}"
CSV_DIR="${CSV_DIR:-/app/csv_data}"

[ -x "$src/bin/ledger" ] && [ -f "$src/lib/ledger/ledger.mjs" ] ||
	{ echo "$src/bin/ledger or $src/lib/ledger/ledger.mjs not found; run 'make build' or unpack a release" >&2; exit 1; }
if [ ! -x "$src/lib/ledger/node" ]; then
	# A `make build` tree has no bundled runtime: the system's node must do.
	major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
	if [ "$major" -lt 22 ]; then
		echo "no Node.js runtime in $src/lib/ledger and no system node >= 22; use a release tarball (make release)" >&2
		exit 1
	fi
fi

echo "==> user"
if ! id ledger >/dev/null 2>&1; then
	groupadd --system --gid "$LEDGER_UID" ledger
	useradd --system --uid "$LEDGER_UID" --gid ledger --home-dir /nonexistent --no-create-home \
		--shell /usr/sbin/nologin --comment "Ledger service" ledger
fi
echo "    ledger uid=$(id -u ledger) gid=$(id -g ledger)"

# Database migrations run first, from this release, while the old version
# keeps running: if one fails nothing below is changed. (Skipped when the
# database isn't set up yet; setup-db.sh applies them on first install.)
db_url=$(sed -n 's/^DATABASE_URL=//p' /etc/ledger/ledger.env 2>/dev/null | tail -n1)
if [ -n "$db_url" ] && command -v psql >/dev/null 2>&1; then
	db_name=$(printf '%s' "$db_url" | sed -n 's#^[a-z]*://[^/]*/\([a-z0-9_]*\).*#\1#p')
	app_role=$(printf '%s' "$db_url" | sed -n 's#^[a-z]*://\([a-z0-9_]*\)[:@].*#\1#p')
	if [ -n "$db_name" ] && [ -n "$app_role" ] &&
		runuser -u postgres -- psql -X -tA -d "$db_name" -c "SELECT to_regclass('public.journal_entries') IS NOT NULL" 2>/dev/null | grep -qx t; then
		echo "==> database $db_name"
		DB_NAME="$db_name" APP_ROLE="$app_role" SQL_DIR="$src/db" sh "$src/deploy/migrate-db.sh"
	fi
fi

echo "==> files"
# Replace the program directory as a whole, so files from an older release
# never linger. The running service keeps its open files until restarted.
rm -rf /usr/local/lib/ledger.new /usr/local/lib/ledger.old
cp -R "$src/lib/ledger" /usr/local/lib/ledger.new
chown -R root:root /usr/local/lib/ledger.new
chmod -R u=rwX,go=rX /usr/local/lib/ledger.new
[ ! -e /usr/local/lib/ledger ] || mv /usr/local/lib/ledger /usr/local/lib/ledger.old
mv /usr/local/lib/ledger.new /usr/local/lib/ledger
rm -rf /usr/local/lib/ledger.old
install -m 0755 "$src/bin/ledger" /usr/local/bin/ledger
install -m 0755 "$src/deploy/ledger-backup.sh" /usr/local/bin/ledger-backup
install -m 0755 "$src/deploy/ledger-user.sh" /usr/local/sbin/ledger-user
install -d -m 0755 /usr/local/share/ledger
install -m 0644 "$src/db/schema.sql" "$src/db/grants.sql" /usr/local/share/ledger/
install -d -m 0755 /usr/local/share/ledger/migrations
rm -f /usr/local/share/ledger/migrations/*.sql
install -m 0644 "$src"/db/migrations/*.sql /usr/local/share/ledger/migrations/
install -m 0755 "$src/deploy/setup-db.sh" /usr/local/share/ledger/setup-db.sh
install -m 0755 "$src/deploy/migrate-db.sh" /usr/local/share/ledger/migrate-db.sh
install -m 0644 "$src/deploy/postgresql-lowmem.conf" /usr/local/share/ledger/

# Automatic updates: the app (user ledger) writes the schedule; the root
# updater writes its status where the app can read it.
install -d -m 0755 -o root -g root /var/lib/ledger
install -d -m 0750 -o ledger -g ledger /var/lib/ledger/update-config
install -d -m 0750 -o root -g ledger /var/lib/ledger/update-status
install -d -m 0700 -o root -g root /var/cache/ledger-update
# Modules: installed by the root updater, read-only to the service.
install -d -m 0755 -o root -g root /var/lib/ledger/modules

install -d -m 0750 -o root -g ledger /etc/ledger
if [ ! -f /etc/ledger/ledger.env ]; then
	install -m 0640 -o root -g ledger "$src/deploy/ledger.env.example" /etc/ledger/ledger.env
	echo "    created /etc/ledger/ledger.env"
else
	echo "    kept existing /etc/ledger/ledger.env"
fi

if command -v systemctl >/dev/null 2>&1; then
	echo "==> systemd units"
	install -m 0644 "$src/deploy/ledger.service" "$src/deploy/ledger-backup.service" \
		"$src/deploy/ledger-backup.timer" "$src/deploy/ledger-update.service" \
		"$src/deploy/ledger-update.timer" "$src/deploy/ledger-update.path" /etc/systemd/system/
	# The updater only acts when the schedule (off by default) or the app asks.
	systemctl enable ledger-update.timer ledger-update.path >/dev/null 2>&1 || true
	if systemctl daemon-reload 2>/dev/null; then
		systemctl start ledger-update.timer ledger-update.path 2>/dev/null || true
	else
		echo "    (systemd not running; run systemctl daemon-reload later)"
	fi
fi

echo "==> CSV directory $CSV_DIR"
if [ -d "$CSV_DIR" ]; then
	if runuser -u ledger -- test -w "$CSV_DIR"; then
		echo "    writable by ledger"
	else
		echo "    WARNING: $CSV_DIR is not writable by uid $(id -u ledger)."
		echo "    For an unprivileged container, on the Proxmox host run:"
		echo "      chown $((100000 + $(id -u ledger))):$((100000 + $(id -g ledger))) <host path of the bind mount>"
	fi
else
	echo "    WARNING: $CSV_DIR does not exist (bind mount not configured yet?)"
fi

cat <<NEXT

Installed. Next steps (first install):
  1. PostgreSQL:   apt install postgresql
                   cp /usr/local/share/ledger/postgresql-lowmem.conf /etc/postgresql/*/main/conf.d/ledger.conf
                   systemctl restart postgresql
  2. Database:     sh /usr/local/share/ledger/setup-db.sh
  3. First user:   ledger-user add <your-name>
  4. Start:        systemctl enable --now ledger ledger-backup.timer
  5. Browse to:    http://<container-ip>:8080/

Upgrade: run this script again from the new release, then: systemctl restart ledger
NEXT
