# Writing Ledger modules

A module adds a feature to Ledger: invoicing, a budget dashboard, a gateway
to an LLM API, an integration with another service. It lives in its own
GitHub repository. You install it from **Settings → Modules** by entering
`owner/name`. Ledger installs the repository's latest release and keeps it
updated together with Ledger itself.

`examples/modules/hello/` is a complete, working module. To start a new one,
copy it into a new repository. To have an LLM write one, paste
[MODULE_LLM_CONTEXT.md](MODULE_LLM_CONTEXT.md) into the chat, followed by
what the module should do.

## What a module can do (and cannot)

A module runs **inside the Ledger server**, with the same database access as
Ledger:

- read everything in the books (accounts, entries, reports)
- post journal entries and create accounts through Ledger's own functions.
  These apply the same validation as the app: balanced per currency, active
  accounts, and so on.
- keep its own tables, in its own database schema
- add API routes, and a page that appears in Ledger's sidebar

It **cannot** edit or delete posted entries, change the ledger's tables or
switch off their checks. Ledger connects as a role that owns nothing, and the
database itself enforces those rules. A module's migrations run as the
module's own database role, which owns only its schema.

Because a module can read the books and post entries, **only install modules
from people you trust.** The install screen says so too.

## Repository layout

```
ledger-module.json     the manifest (required, at the repository root)
server.mjs             backend code (optional)
ui/index.html          the module's page (optional), plus any assets
migrations/001_*.sql   database migrations (optional)
```

### ledger-module.json

```json
{
  "id": "hello",
  "name": "Hello module",
  "version": "1.0.0",
  "description": "What it does, shown before installing.",
  "ledger": ">=0.6.0",
  "server": "server.mjs",
  "ui": "ui",
  "nav": { "label": "Hello" },
  "migrations": "migrations"
}
```

| Field | Meaning |
|---|---|
| `id` | 2–32 lowercase letters, digits or `-`, starting with a letter. Fixed for the module's lifetime; its schema is `mod_<id>` (`-` becomes `_`). |
| `name`, `version`, `description` | Shown under Settings → Modules. `version` is `x.y.z`. |
| `ledger` | Optional minimum Ledger version, as `>=x.y.z`. |
| `server` | Optional ES module exporting `default async function register(ctx)`. |
| `ui` | Optional directory containing `index.html`. It is served at `/m/<id>/`. |
| `nav` | Optional sidebar entry that opens the UI inside Ledger (users can hide or move it under Settings → Sidebar; a hidden module stays reachable from its tab under Settings): `label` (up to 24 characters) and an optional `icon`. See [Icons](#icons). Requires `ui`. |
| `migrations` | Optional directory of `NNN_name.sql` files. |
| `settings` | Optional settings form, shown on the module's own tab under Settings (Ledger 0.9.0 and later). See [Settings](#settings). |

Paths are relative to the repository root and cannot contain `..` or hidden
(`.name`) parts.

### Icons

`nav.icon` is one of:

- **A name** from Ledger's set: `hammer`, `wrench`, `invoice`, `cart`, `chart`, `users`, `mail`, `calendar`, `box`, `dollar`, `bank`, `wallet`, `piggy`, `receipt`, `tag`, `truck`, `home`, `briefcase`, `clock`, `globe`, `key`, `lock`, `star`, `heart`, `bell`, `file`, `folder`, `cloud`, `database`, `link`, `send`, `phone`, `printer`, `gift`, `bot`, `sparkles`, `pie`, `target`, `scale`, `percent`, `calculator`.
  Unknown names show the generic module icon.
- **Your own drawing** (Ledger 0.10.0 and later): `{"path": "M4 5h16v11H10l-5 4v-4H4z"}`,
  SVG path data on a 24×24 grid. It is stroked like Ledger's icons (1.8px,
  round caps); add `"fill": true` for a solid shape. Up to 4,000 characters,
  path commands and numbers only.
- **An SVG file** (Ledger 0.10.0 and later): `{"file": "icon.svg"}`, inside
  the `ui` directory. Ledger uses its shape as a mask, so it takes the
  sidebar's colour in light and dark mode; colours in the file are ignored.

Draw on a 24×24 grid with about 2px of margin. Use
`"ledger": ">=0.10.0"` for drawn or file icons: older versions refuse them.

## Publishing

Ledger installs the **latest GitHub Release**, using the tagged source
archive; no build artifacts are needed. To publish a version:

1. Bump `version` in `ledger-module.json`.
2. Tag the commit, e.g. `git tag v1.1.0 && git push origin v1.1.0`.
3. Create a release from the tag on GitHub. Pre-releases and drafts are
   ignored.

Installed modules are updated:

- on Ledger's update schedule (**Settings → Updates**)
- when you press **Check for updates now** there
- when you press **Update modules now** under Settings → Modules

If Ledger fails to start after a module is installed or updated, the change
is undone automatically and Settings → Modules shows the reason.

## The server API (`register(ctx)`)

```js
export default async function register(ctx) {
	ctx.route("GET", "/summary", async (req) => {
		const tb = await ctx.ledger.trialBalance();
		return { totals: tb.totals };
	});
}
```

`register` runs once at startup and must finish within 15 seconds. If it
throws, the module shows as *Failed to load* under Settings → Modules, and the
rest of Ledger runs normally.

| `ctx.` | |
|---|---|
| `id`, `name`, `version`, `dir`, `ledgerVersion` | About the module and Ledger. `dir` is where the module is installed. |
| `schema` | The module's database schema, e.g. `mod_hello`. Write table names as `${ctx.schema}.notes`. |
| `route(method, path, handler)` | Adds `GET`/`POST`/`PUT`/`PATCH`/`DELETE` routes under `/api/v1/m/<id>`. Paths may contain `:params`. |
| `db.query(sql, params)` | Runs SQL with Ledger's connection; returns `{ rows, rowCount }`. Use `$1` placeholders, never string concatenation of input. |
| `ledger.*` | Ledger's own functions; see below. |
| `dashboard.*` | Notifications and to-dos on Ledger's dashboard (Ledger 0.8.0 and later); see below. |
| `settings.*` | Values of the settings the manifest declares (Ledger 0.9.0 and later); see below. |
| `HttpError` | `throw new ctx.HttpError(404, "no such invoice")` answers with that status and message. |
| `response(status, body)` | Return this from a handler to choose the status, e.g. `201`. |
| `log.info/warn/error(msg, attrs)` | Writes JSON lines to the service log (`journalctl -u ledger`). |

**Handlers** receive `req` with these fields:

- `method`
- `path`: below `/api/v1/m/<id>`
- `params`: the decoded `:params`
- `query`: a `URLSearchParams`
- `body`: the parsed JSON body, if any
- `user`: `{ username }` of the logged-in user

Every module route requires a login, and Ledger's cross-site request
protection applies.

What a handler returns becomes the response:

- any other value is sent as JSON with status 200
- returning nothing sends 204
- `ctx.response(...)` sends the status and body you choose

**Money** is always integer cents. Results from `ctx.ledger` use JavaScript
`bigint`, which Ledger sends as exact JSON numbers. When you post an entry,
amounts can be numbers, bigints or digit strings.

**`ctx.ledger`** has these functions:

| Function | Notes |
|---|---|
| `listAccounts({ includeInactive })`, `getAccount(code)` | |
| `createAccount({ code, name, type, currency, description })` | |
| `accountLedger(code, { from, to })` | |
| `listJournalEntries({ from, to, accountCode, limit, offset })`, `getJournalEntry(id)` | |
| `createJournalEntry({ entry_date, description, reference, lines: [{ account_code, debit_cents, credit_cents, memo }] }, req.user)` | Pass `req.user` so the entry is recorded as posted by that user. Invalid entries throw, and the API answers 422 with the details. |
| `reverseJournalEntry(id, { entry_date, description }, req.user)` | |
| `trialBalance({ asOf, currency })`, `balanceSheet({ asOf, currency })`, `incomeStatement({ from, to, currency })` | |

**`ctx.dashboard`** puts notifications and to-dos on Ledger's dashboard,
next to the financial summary. Each item belongs to your module and has a
`key` of your choosing (1-100 characters). Posting the same key again
updates the item instead of adding another one.

```js
// A notification: shown until dismissed (or until expiresAt).
await ctx.dashboard.notify({
	key: "overdue",                       // optional; without one, every call adds a new notification
	title: "2 invoices are overdue",      // 1-200 characters
	body: "Acme Corp (#28) and Globex (#30)", // optional, up to 2000 characters, plain text
	level: "warning",                     // info (default), success, warning or danger
	link: "/apps/invoicing",              // optional; a path inside Ledger
	expiresAt: "2026-11-01T00:00:00Z",    // optional
});

// A to-do: the user ticks it off, or your module does.
await ctx.dashboard.todo({ key: "q3-gst", title: "File the Q3 GST return", due: "2026-10-31", link: "/reports" });
await ctx.dashboard.complete("q3-gst");   // done (false if there is no such to-do)
await ctx.dashboard.reopen("q3-gst");     // not done again
await ctx.dashboard.dismiss("overdue");   // hide a notification
await ctx.dashboard.remove("q3-gst");     // delete; remove(key, "notification") for notifications
await ctx.dashboard.list({ kind: "todo", open: true }); // your module's items
```

- A dismissed notification shows again only if you post it with a different
  title or body. Updating a to-do keeps whether it is done.
- Invalid items throw, and inside a route handler the API answers 422.
- Dismissed notifications and done to-dos are deleted after 30 days, and
  expired notifications a day after they expire.
- Set `"ledger": ">=0.8.0"` in `ledger-module.json` when you use it.

## Settings

Declare settings in the manifest and Ledger gives the module a tab under
**Settings**, with a form, validation and storage. The module reads the
values with `ctx.settings`.

```json
"settings": {
  "fields": [
    { "key": "api_key", "label": "API key", "type": "secret", "required": true, "help": "From your provider's dashboard." },
    { "key": "model", "label": "Model", "type": "select", "options": ["small", { "value": "large", "label": "Large (slower)" }], "default": "small" },
    { "key": "max_tokens", "label": "Max tokens", "type": "number", "min": 1, "max": 100000, "default": 1000 },
    { "key": "enabled", "label": "Turn it on", "type": "boolean", "default": true },
    { "key": "prompt", "label": "System prompt", "type": "textarea" }
  ],
  "page": "settings.html"
}
```

| Field member | |
|---|---|
| `key` | Lowercase letters, digits and `_`, up to 40, starting with a letter. |
| `type` | `text` (one line, 500 chars), `textarea` (10,000), `secret` (2,000; never shown again after saving), `number` (`min`/`max`), `boolean`, `select` (`options`: strings or `{ "value", "label" }`). Default `text`. |
| `label`, `help` | Shown in the form (60 / 300 characters). |
| `required` | The form can't be saved without a value. |
| `default` | Used until the user sets a value (not for secrets). |

`page` (optional) is a file in the module's `ui` directory, shown in a frame
below the form, for settings a simple form can't express (e.g. connecting an
account). At most 50 fields.

```js
const { api_key, model } = await ctx.settings.get(); // defaults filled in; secrets included
await ctx.settings.set({ model: "large" });         // validated like the form
ctx.settings.onChange((values) => { /* reconnect, reschedule… */ });
```

Values are stored in Ledger's database (`module_settings`), so they are in
backups, secrets included. Set `"ledger": ">=0.9.0"` when you use settings:
older Ledger versions refuse the manifest.

## The UI

`ui/` is served at `/m/<id>/`. The page is shown in a frame inside Ledger,
next to the sidebar or in a side-by-side pane (so it should work from about
260px wide). It shares Ledger's login, so calls to
`/api/v1/m/<id>/...` with `fetch` just work.

- Send JSON with `Content-Type: application/json`.
- A path without a file extension serves `index.html`, so client-side routing
  works.
- Plain HTML and JavaScript are enough; if you use a framework, commit its
  build output to `ui/`. Releases are installed as-is, with no build step.
- Supporting `prefers-color-scheme` lets the page match Ledger's dark mode.

## Migrations

Each `migrations/NNN_name.sql` file runs **once**, in file-name order, in a
transaction. It runs as the module's own role (`mod_<id>`), with
`search_path` set to the module's schema, so `CREATE TABLE notes (...)`
creates `mod_<id>.notes`. Ledger records each applied file and grants itself
read/write access to everything the module creates.

- Never edit a migration that has been released; add a new file instead.
- Migrations can't be undone automatically. A failed migration stops the
  install, and the previous version keeps running.
- Removing a module keeps its schema and data. Adding it again picks them
  back up. To delete the data, drop the schema yourself:
  `DROP SCHEMA mod_<id> CASCADE` as the `postgres` user.

## Developing locally

Run Ledger from a checkout (see the README), with `MODULES_DIR` pointing at a
directory that contains your module under its id:

```sh
mkdir -p ~/ledger-modules && ln -s ~/src/my-module ~/ledger-modules/my-module
psql -d ledger -c 'CREATE SCHEMA IF NOT EXISTS mod_my_module'
psql -d ledger -c 'SET search_path = mod_my_module' -f ~/src/my-module/migrations/001_init.sql
MODULES_DIR=~/ledger-modules DATABASE_URL=... node backend/src/main.ts
```

Restart Ledger to reload the module's code. Changes to UI files show up
without a restart.

For type checking in an editor, the context's type is exported as
`ModuleContext` from `backend/src/module-host.ts`.
