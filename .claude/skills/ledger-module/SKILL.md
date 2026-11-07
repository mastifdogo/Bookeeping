---
name: ledger-module
description: Build, check and publish a Ledger module (a plugin that adds a feature such as invoicing, budgets, payroll, an LLM gateway or an integration to this bookkeeping app, installed from its own GitHub repository). Use when asked to create, write, design, update, fix or release a Ledger module or plugin, or to turn a feature idea into one.
---

# Building a Ledger module

A Ledger module is a GitHub repository with a `ledger-module.json` manifest,
an optional `server.mjs` (runs inside the Ledger server), an optional `ui/`
page (shown in Ledger's sidebar and Settings) and optional SQL migrations in
its own database schema. Ledger installs the repository's latest GitHub
Release.

Paths below are relative to the Ledger repository root (this checkout).

## 1. Learn the current API first

Read **`docs/MODULE_LLM_CONTEXT.md`** in full before writing anything. It is
the authoritative, compact reference: manifest fields, the `ctx` API and its
return shapes, `ctx.dashboard`, `ctx.settings`, migrations, the UI contract,
security rules and the release checklist. `docs/MODULES.md` has the longer
explanation. Real modules to learn from: mastifdogo/invoice-costumer-module
(Sales), mastifdogo/llm-api-module and mastifdogo/tailscale-module.

If the context file and the code disagree, the code wins:
`backend/src/module-host.ts` (the `ctx` object), `backend/src/modules.ts`
(manifest validation), `backend/src/module-settings.ts` (settings fields).
Then fix the docs as part of your change.

Check the Ledger version the user runs (`git describe --tags --abbrev=0` is
the latest release) and set `"ledger": ">=x.y.z"` to the oldest version that
has every feature the module uses. The context file says which version
introduced what.

## 2. Design before coding

Decide, and state briefly to the user:

- **id** (`^[a-z][a-z0-9-]{1,31}$`, permanent: it names the database schema
  `mod_<id>` and the URLs) and **name**.
- **Data**: the tables in the module's schema. Money is always `bigint`
  cents with a `currency` column (`CAD`/`USD`); never floats, never add
  currencies together.
- **Books**: what it posts to the ledger, if anything. Post only through
  `ctx.ledger.createJournalEntry(entry, req.user)` (balanced per currency),
  undo with `reverseJournalEntry`. Account codes the module uses are
  **settings** (e.g. `receivable_account`, default `1200`), never hard-coded.
- **Settings**: everything the user configures (API keys as `secret`
  fields, account codes, options) goes in the manifest's `settings.fields`.
  Ledger renders the form on the module's Settings tab.
- **Dashboard**: what deserves a notification or a to-do (`ctx.dashboard`).
- **AI, Gmail, search**: AI goes through `ctx.llm` (the admin's provider,
  never the module's own key), mail through `ctx.gmail` (never your own
  OAuth/IMAP), and records worth finding through `ctx.search.provide`. These
  need Ledger 0.10.0, and the admin must allow the module under Settings →
  AI / Gmail: say so in the README and show `ctx.llm.status()` /
  `ctx.gmail.status()` in the UI when it isn't allowed yet.
- **Roles**: `req.user.role` is `admin`, `bookkeeper` or `viewer`. Ledger
  blocks viewers from non-GET routes; restrict module setup to admins
  yourself.
- **UI**: one self-contained `ui/index.html` (plain HTML/CSS/JS, light and
  dark mode, works from ~260px wide).
- **Icon**: draw one that says what the module does: `nav.icon` as
  `{"path": "<24x24 SVG path data>"}`, or pick a built-in name.

If the request is vague about something that changes the data model or the
books (which accounts, tax handling, multi-currency), ask the user once;
otherwise choose sensible defaults and say what you chose.

## 3. Scaffold

```sh
sh .claude/skills/ledger-module/scripts/new-module.sh <dir> <id> "<Name>" "<one-line description>" ["<sidebar label>"]
```

It copies `.claude/skills/ledger-module/template/` (a working CRUD module:
manifest with a drawn icon, `server.mjs`, `migrations/001_init.sql`,
`ui/index.html`, README) with the names filled in. Build the
real feature on top of it: rename the `items` table and routes, and so on.

Where `<dir>` goes:

- Always a new directory **outside** this repository (e.g. a sibling
  `../ledger-<id>`), which becomes its own git repository. Ledger doesn't
  ship example modules.

## 4. Implement: rules that matter

These come from how Ledger loads modules; `check-module.ts` enforces most.

- `server.mjs` default-exports `async function register(ctx)`; it must
  finish within 15 s. **No npm packages**: only `node:*` built-ins and global
  `fetch`; nothing is installed on deploy. Relative imports of the module's
  own files are fine.
- SQL: always `$1` placeholders; table names as `${ctx.schema}.table`.
  `BIGINT` columns come back as JS `bigint`: cast counts with `::int` or use
  `Number()`, never mix bigint and number.
- Validate every request field; answer `throw new ctx.HttpError(422, "...")`.
  An empty or malformed body must never cause a 500.
- Migrations: `migrations/NNN_name.sql`, unqualified `CREATE TABLE`, no
  `BEGIN`/`COMMIT`/`GRANT`/`CREATE SCHEMA`/`search_path`, never touch
  `public.*`. **Never edit a released migration**; add the next number.
- UI: call `/api/v1/m/<id>/...` with `fetch` and
  `Content-Type: application/json` (same origin, so the login cookie
  applies). Show data with `textContent`, never `innerHTML`. No CDNs.
  Use Ledger's colours (see the template) and `prefers-color-scheme: dark`.
- Settings: read with `await ctx.settings.get()` per request (or
  `ctx.settings.onChange`); handle missing required values with a clear
  409/422 telling the user which Settings tab to fill in.
- Secrets: only in `secret` settings fields; never return or log them.
- Outbound calls: `fetch(url, { signal: AbortSignal.timeout(10_000) })`.

## 5. Check it: always, before saying it works

Needs PostgreSQL and the backend dependencies:

```sh
(cd backend && npm ci)                                          # once
pg_isready || service postgresql start                          # local PostgreSQL
runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"   # once, if needed
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  node .claude/skills/ledger-module/scripts/check-module.ts <dir>
```

It validates the manifest exactly as Ledger does, checks referenced files,
imports, migrations and the UI, then creates a scratch database with
Ledger's schema, applies the module's migrations in its schema, loads it in
a real Ledger, and calls every parameter-free GET route, POSTs `{}` to
every POST route (expecting a 4xx, not a 500), the UI and the settings form.
The scratch database is dropped afterwards. Fix every `FAIL`; read every
`warn`.

The automatic check doesn't exercise the real flows. Also test them:

```sh
TEST_DATABASE_URL=... node .claude/skills/ledger-module/scripts/check-module.ts <dir> --serve 8098
```

keeps it running and prints a session cookie. Then drive the real flows
with `curl -b 'ledger_session=…'` (create, list, update, delete, anything
that posts to the books), and open `http://127.0.0.1:8098/m/<id>/` with
Playwright (`require('playwright')`, add the cookie to the context) to
screenshot the UI in light and dark mode at both ~360px and ~1200px wide.
Stop the server with Ctrl-C (SIGINT) when done.

Postings need accounts: create them first through Ledger's API
(`POST /api/v1/accounts` with `{code, name, type, currency}`) in the served
instance.

## 6. Publish (only when the user asks)

Creating repositories, pushing and releasing are outward-facing: confirm
with the user first, and use the repository they name.

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on a module.** Push only to the module's own repository. If the
module needs a change in Ledger (a bug fix, a new `ctx` feature, a docs or
checker fix), make it locally, tell the user what it is and why, and leave
pushing it to them. Build the module so it works without that change.

1. In `<dir>`: `git init -b main`, commit, add the remote, push `main`.
2. Release: bump `version` in `ledger-module.json` (`x.y.z`), tag `vx.y.z`,
   push the tag, and create a GitHub Release from it (not a draft or
   pre-release). If pushing tags or creating releases is blocked from this
   session, tell the user exactly which tag/commit to release from the
   GitHub web UI.
3. Tell the user to install it: **Settings → Modules**, enter `owner/repo`.
   Updates install on Ledger's update schedule or with "Update modules now".

Updating a published module: change code, add a new migration if the data
model changes, bump the version, run the checks, release again.

## 7. When Ledger's module API changes

If you change what modules can do (`backend/src/module-host.ts`,
`backend/src/modules.ts`, `backend/src/module-settings.ts`), update in the
same change: `docs/MODULE_LLM_CONTEXT.md`, `docs/MODULES.md`, this skill
(its template and `check-module.ts` if they're affected) and the test
fixture `backend/test/fixtures/hello-module/` if the tests should cover it. Note the Ledger version that introduces the
feature (the next release after the latest tag). As in §6, don't push
these changes yourself as part of module work; hand them to the user.
