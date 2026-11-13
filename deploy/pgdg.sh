#!/bin/sh
# Adds the PostgreSQL project's package source (apt.postgresql.org, "PGDG"),
# which carries PostgreSQL versions newer than the distribution's own. Safe to
# re-run. Run as root; needs curl and ca-certificates.
#
#   sh pgdg.sh && apt-get update && apt-get install -y postgresql-18
set -eu

KEY=/usr/share/keyrings/postgresql-pgdg.asc
LIST=/etc/apt/sources.list.d/pgdg.list
KEY_URL=${PGDG_KEY_URL:-https://www.postgresql.org/media/keys/ACCC4CF8.asc}
REPO=${PGDG_REPO:-https://apt.postgresql.org/pub/repos/apt}

codename=${PGDG_SUITE:-}
if [ -z "$codename" ] && [ -r /etc/os-release ]; then
	codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
fi
[ -n "$codename" ] || { echo "pgdg: can't tell the distribution's codename (set PGDG_SUITE)" >&2; exit 1; }

if [ ! -s "$KEY" ]; then
	tmp=$(mktemp)
	curl -fsSL --retry 3 --max-time 60 -o "$tmp" "$KEY_URL" || { rm -f "$tmp"; echo "pgdg: could not download the repository key from $KEY_URL" >&2; exit 1; }
	grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$tmp" || { rm -f "$tmp"; echo "pgdg: what $KEY_URL returned is not a key" >&2; exit 1; }
	install -D -m 0644 "$tmp" "$KEY"
	rm -f "$tmp"
fi
printf 'deb [signed-by=%s] %s %s-pgdg main\n' "$KEY" "$REPO" "$codename" >"$LIST"
echo "pgdg: $LIST -> $REPO $codename-pgdg"
