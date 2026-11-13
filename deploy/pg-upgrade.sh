#!/bin/sh
# Moves Ledger's PostgreSQL cluster to PostgreSQL 16 (from the version the
# distribution shipped, 15 on Debian 12). Run as root; started by
# `ledger update run` once after an update, or by hand:
#
#   sh /usr/local/share/ledger/pg-upgrade.sh           upgrade if needed
#   sh /usr/local/share/ledger/pg-upgrade.sh --check   exit 10 if an upgrade is needed, 0 if not
#
# What it does:
#   1. installs PostgreSQL 16 from apt.postgresql.org (pgdg.sh)
#   2. saves every database and role to /var/lib/ledger/pg-upgrade/ (pg_dumpall)
#   3. stops Ledger and runs Debian's pg_upgradecluster, which copies the
#      cluster into a new PostgreSQL 16 one on the same port and leaves the
#      old cluster in place, stopped
#   4. starts Ledger and checks it answers; if it doesn't, the old cluster is
#      put back and the new one removed
#
# The old cluster is kept (stopped) so nothing is lost if something turns up
# later. Once satisfied, free its space with:  pg_dropcluster <old version> main
#
# Environment: PG_TARGET=16, ENV_FILE=/etc/ledger/ledger.env,
# SAVE_DIR=/var/lib/ledger/pg-upgrade, LEDGER_SERVICE=ledger.service
set -eu

TARGET=${PG_TARGET:-16}
ENV_FILE=${ENV_FILE:-/etc/ledger/ledger.env}
SAVE_DIR=${SAVE_DIR:-/var/lib/ledger/pg-upgrade}
SERVICE=${LEDGER_SERVICE:-ledger.service}
here=$(cd "$(dirname "$0")" && pwd)

log() { echo "pg-upgrade: $*"; }
die() { echo "pg-upgrade: $*" >&2; exit 1; }

command -v pg_lsclusters >/dev/null 2>&1 || { log "PostgreSQL isn't managed by postgresql-common here; nothing to do"; exit 0; }

# The cluster Ledger uses: the one listening on the port in DATABASE_URL.
url=""
[ -r "$ENV_FILE" ] && url=$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -n1)
port=$(printf '%s' "$url" | sed -n 's#^[a-z]*://[^/]*:\([0-9][0-9]*\)/.*#\1#p')
port=${port:-5432}
http_port=$( { [ -r "$ENV_FILE" ] && sed -n 's/^HTTP_ADDR=.*:\([0-9][0-9]*\)$/\1/p' "$ENV_FILE" | tail -n1; } || true)
http_port=${http_port:-8080}

line=$(pg_lsclusters -h | awk -v p="$port" '$3 == p { print $1, $2; exit }')
[ -n "$line" ] || { log "no PostgreSQL cluster on port $port; nothing to do"; exit 0; }
cur=${line% *}
name=${line#* }
case "$cur" in *[!0-9]*) die "unexpected cluster version '$cur'" ;; esac
if [ "$cur" -ge "$TARGET" ]; then
	log "PostgreSQL $cur is already in use; nothing to do"
	exit 0
fi
if [ "${1:-}" = "--check" ]; then
	log "PostgreSQL $cur is in use; an upgrade to $TARGET is needed"
	exit 10
fi
[ "$(id -u)" -eq 0 ] || die "must run as root"

as_pg() { runuser -u postgres -- "$@"; }
sql() { as_pg psql -X -q -A -t -p "$port" -d postgres -c "$1"; }

# --- Room: the copy of the data, the saved dump, and some slack ---------------
data_dir=$(pg_lsclusters -h | awk -v v="$cur" -v n="$name" '$1 == v && $2 == n { print $6; exit }')
[ -d "$data_dir" ] || die "can't find the data directory of cluster $cur/$name"
used_kb=$(du -sk "$data_dir" | awk '{ print $1 }')
free_kb=$(df -Pk "$data_dir" | awk 'NR == 2 { print $4 }')
need_kb=$((used_kb * 3 + 512000))
[ "$free_kb" -ge "$need_kb" ] || die "not enough free disk space: the upgrade needs about $((need_kb / 1024)) MB free, there are $((free_kb / 1024)) MB"

dbs_before=$(sql "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate")
[ -n "$dbs_before" ] || die "can't reach PostgreSQL $cur on port $port"

# --- 1. PostgreSQL $TARGET -----------------------------------------------------
had_target=0
pg_lsclusters -h | awk -v v="$TARGET" '$1 == v { found = 1 } END { exit !found }' && had_target=1
if [ ! -x "/usr/lib/postgresql/$TARGET/bin/postgres" ]; then
	log "installing PostgreSQL $TARGET"
	export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
	sh "$here/pgdg.sh"
	apt-get update -q
	apt-get install -y -q "postgresql-$TARGET" "postgresql-client-$TARGET"
fi
[ -x "/usr/lib/postgresql/$TARGET/bin/postgres" ] || die "PostgreSQL $TARGET did not install"
# Installing the package creates an empty cluster; the upgrade makes its own.
if [ "$had_target" -eq 0 ] && pg_lsclusters -h | awk -v v="$TARGET" -v n="$name" '$1 == v && $2 == n { found = 1 } END { exit !found }'; then
	pg_dropcluster --stop "$TARGET" "$name"
fi
if pg_lsclusters -h | awk -v v="$TARGET" -v n="$name" '$1 == v && $2 == n { found = 1 } END { exit !found }'; then
	die "a PostgreSQL $TARGET cluster called $name already exists; remove it (pg_dropcluster $TARGET $name) or move Ledger to it by hand"
fi

# --- 2. A copy of everything, whatever happens next ----------------------------
install -d -m 0700 "$SAVE_DIR"
save="$SAVE_DIR/before-pg$TARGET-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
log "saving all databases to $save"
( umask 077; as_pg pg_dumpall -p "$port" | gzip >"$save.tmp" )
gzip -t "$save.tmp" && [ "$(stat -c %s "$save.tmp")" -gt 1000 ] || { rm -f "$save.tmp"; die "the safety copy could not be written"; }
mv "$save.tmp" "$save"
# Keep the two newest copies.
ls -1t "$SAVE_DIR"/before-pg*.sql.gz 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old"; done

# --- 3. The upgrade, with Ledger stopped ---------------------------------------
have_systemd=0
[ -d /run/systemd/system ] && have_systemd=1
stop_ledger() { [ "$have_systemd" -eq 1 ] && systemctl stop "$SERVICE" 2>/dev/null || true; }
start_ledger() { [ "$have_systemd" -eq 1 ] && systemctl start "$SERVICE" 2>/dev/null || true; }

put_back() {
	# The old cluster on the original port, running; the new one gone.
	log "putting PostgreSQL $cur back"
	pg_lsclusters -h | awk -v v="$TARGET" -v n="$name" '$1 == v && $2 == n { found = 1 } END { exit !found }' && pg_dropcluster --stop "$TARGET" "$name" || true
	pg_conftool "$cur" "$name" set port "$port" || true
	echo auto >"/etc/postgresql/$cur/$name/start.conf" || true
	pg_ctlcluster "$cur" "$name" restart 2>/dev/null || pg_ctlcluster "$cur" "$name" start || true
}

log "stopping Ledger"
stop_ledger
log "upgrading cluster $cur/$name to PostgreSQL $TARGET (this can take a few minutes)"
if ! pg_upgradecluster -v "$TARGET" "$cur" "$name"; then
	put_back
	start_ledger
	die "pg_upgradecluster failed; PostgreSQL $cur is running again and nothing was changed (the copy is in $save)"
fi
if [ -f "$here/postgresql-lowmem.conf" ] && [ -d "/etc/postgresql/$TARGET/$name/conf.d" ]; then
	install -m 0644 "$here/postgresql-lowmem.conf" "/etc/postgresql/$TARGET/$name/conf.d/ledger.conf"
	pg_ctlcluster "$TARGET" "$name" restart
fi

# --- 4. Checks ------------------------------------------------------------------
ok=1
for _ in $(seq 1 30); do
	pg_isready -q -p "$port" && break
	sleep 1
done
ver=$(sql "SHOW server_version_num" 2>/dev/null || echo 0)
dbs_after=$(sql "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate" 2>/dev/null || echo "")
[ "$((ver / 10000))" -eq "$TARGET" ] || { log "PostgreSQL $TARGET is not answering on port $port"; ok=0; }
[ "$dbs_after" = "$dbs_before" ] || { log "the databases differ after the upgrade (before: $dbs_before; after: $dbs_after)"; ok=0; }

if [ "$ok" -eq 1 ] && [ "$have_systemd" -eq 1 ]; then
	start_ledger
	healthy=0
	for _ in $(seq 1 30); do
		sleep 2
		if curl -fsS --max-time 3 "http://127.0.0.1:$http_port/api/v1/health" >/dev/null 2>&1; then healthy=1; break; fi
	done
	[ "$healthy" -eq 1 ] || { log "Ledger does not answer with PostgreSQL $TARGET"; ok=0; }
fi

if [ "$ok" -ne 1 ]; then
	stop_ledger
	put_back
	start_ledger
	die "the upgrade was undone; PostgreSQL $cur is running again (the copy is in $save)"
fi

log "done: Ledger now runs on PostgreSQL $TARGET. The PostgreSQL $cur cluster is kept, stopped; once satisfied, free its space with: pg_dropcluster $cur $name"
