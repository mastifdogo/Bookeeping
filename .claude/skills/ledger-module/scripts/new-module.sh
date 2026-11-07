#!/bin/sh
# Creates a new Ledger module from the skill's template.
#   new-module.sh <target-dir> <id> "<Name>" ["<one-line description>"] ["<sidebar label>"]
# id: 2-32 chars, lowercase letters, digits, '-', starting with a letter.
set -eu
[ $# -ge 3 ] || { echo "usage: $0 <target-dir> <id> \"<Name>\" [\"<description>\"] [\"<label>\"]" >&2; exit 2; }
dir=$1 id=$2 name=$3
desc=${4:-"$name for Ledger."}
label=${5:-$name}
printf '%s' "$id" | grep -Eq '^[a-z][a-z0-9-]{1,31}$' || { echo "bad id: $id" >&2; exit 2; }
[ ! -e "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ] || { echo "$dir exists and is not empty" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$dir"
cp -R "$here/template/." "$dir/"
schema="mod_$(printf '%s' "$id" | tr '-' '_')"
# Values go through the environment so names with / & or quotes can't break sed.
ID=$id NAME=$name DESC=$desc LABEL=$label SCHEMA=$schema \
	find "$dir" -type f \( -name '*.json' -o -name '*.mjs' -o -name '*.html' -o -name '*.sql' -o -name '*.md' \) \
	-exec node -e '
		const fs = require("fs");
		const esc = (s, json) => (json ? JSON.stringify(s).slice(1, -1) : s);
		for (const f of process.argv.slice(1)) {
			const json = f.endsWith(".json");
			const html = f.endsWith(".html");
			const h = (s) => (html ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;") : s);
			let t = fs.readFileSync(f, "utf8");
			t = t.replaceAll("__ID__", process.env.ID).replaceAll("__SCHEMA__", process.env.SCHEMA)
				.replaceAll("__NAME__", h(esc(process.env.NAME, json))).replaceAll("__LABEL__", esc(process.env.LABEL.slice(0, 24), json))
				.replaceAll("__DESCRIPTION__", h(esc(process.env.DESC, json)));
			fs.writeFileSync(f, t);
		}' {} +
echo "created $dir (id $id, schema $schema)"
