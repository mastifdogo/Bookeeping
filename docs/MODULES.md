# Writing Ledger modules

A module adds a feature to Ledger: invoicing, a budget dashboard, a gateway
to an LLM API, an integration with another service. It lives in its own
GitHub repository. You install it from **Settings → Modules** by entering
`owner/name`. Ledger installs the repository's latest release and keeps it
updated together with Ledger itself.

To start a new one, run
`sh .claude/skills/ledger-module/scripts/new-module.sh <dir> <id> "<Name>"`,
which copies a small working module (`.claude/skills/ledger-module/template/`)
into a new directory for its own repository. To have an LLM write one, paste
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
| `files` | Optional `{"accepts": ["statement", "bill"]}`: the kinds of file other modules may hand this one (Ledger 0.11.0 and later). See [Files between modules](#files-between-modules-ctxfiles). Requires `server`. |

Paths are relative to the repository root and cannot contain `..` or hidden
(`.name`) parts.

### Icons

`nav.icon` is one of:

- **A name** from Ledger's set: `hammer`, `wrench`, `invoice`, `cart`, `chart`, `users`, `mail`, `calendar`, `box`, `dollar`, `bank`, `wallet`, `piggy`, `receipt`, `tag`, `truck`, `home`, `briefcase`, `clock`, `globe`, `key`, `lock`, `star`, `heart`, `bell`, `file`, `folder`, `cloud`, `database`, `link`, `send`, `phone`, `printer`, `gift`, `bot`, `sparkles`, `pie`, `target`, `scale`, `percent`, `calculator`.
  Unknown names show the generic module icon.
- **Your own drawing** (Ledger 0.9.1 and later): `{"path": "M4 5h16v11H10l-5 4v-4H4z"}`,
  SVG path data on a 24×24 grid. It is stroked like Ledger's icons (1.8px,
  round caps); add `"fill": true` for a solid shape. Up to 4,000 characters,
  path commands and numbers only.
- **An SVG file** (Ledger 0.9.1 and later): `{"file": "icon.svg"}`, inside
  the `ui` directory. Ledger uses its shape as a mask, so it takes the
  sidebar's colour in light and dark mode; colours in the file are ignored.

Draw on a 24×24 grid with about 2px of margin. Use
`"ledger": ">=0.9.1"` for drawn or file icons: older versions refuse them.

## Publishing

Ledger installs the **latest GitHub Release**, using the tagged source
archive; no build artifacts are needed. To publish a version:

1. Bump `version` in `ledger-module.json`.
2. Tag the commit, e.g. `git tag v1.1.0 && git push origin v1.1.0`.
3. Create a release from the tag on GitHub. Pre-releases and drafts are
   ignored.

Renamed the module's repository on GitHub? Under Settings → Modules, press
**Change** next to its repository and enter the new name. Ledger checks that
the repository holds the same module (same `id`), keeps the installed copy
and its data, and installs from the new name from then on. (GitHub also
redirects the old name, so nothing breaks in the meantime.)

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
| `llm.*` | The LLM connections set up under Settings → LLM API (Ledger 0.10.0 and later); see below. |
| `gmail.*` | The Gmail account connected under Settings → Gmail (Ledger 0.10.0 and later); see below. |
| `search.provide(fn)` | Adds your results to Ledger's search bar (Ledger 0.10.0 and later); see below. |
| `HttpError` | `throw new ctx.HttpError(404, "no such invoice")` answers with that status and message. |
| `response(status, body)` | Return this from a handler to choose the status, e.g. `201`. |
| `log.info/warn/error(msg, attrs)` | Writes JSON lines to the service log (`journalctl -u ledger`). |

**Handlers** receive `req` with these fields:

- `method`
- `path`: below `/api/v1/m/<id>`
- `params`: the decoded `:params`
- `query`: a `URLSearchParams`
- `body`: the parsed JSON body, if any
- `user`: `{ username, role }` of the logged-in user. `role` is `admin`,
  `bookkeeper` or `viewer` (Ledger 0.10.0 and later). Ledger already refuses
  non-GET requests from viewers; check the role yourself for anything
  stricter (e.g. only admins may change the module's setup).

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
| `linkJournalEntry(id, { ref, label, href }, req.user)` | Links an entry to one of the module's records (Ledger 0.11.2 and later). `createJournalEntry` also takes `links: [{ ref, label, href }]`. |
| `unlinkJournalEntry(id, ref)` | Removes one of the module's links. |
| `linkedEntries(ref?)` | `[{ entry_id, ref, label, href, reversed }]` for one record, or all of the module's links. |
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

## AI (`ctx.llm`)

An admin sets up LLM connections under **Settings → LLM API**: Claude
(Anthropic API), Ollama, or any OpenAI-compatible server, and ticks the
modules allowed to use them. Modules never see the API keys. Every call is
logged per module and connection.

Since Ledger 0.11.2 there can be several connections, each used for text,
for images and documents, or both: for example Claude for text and a local
vision model for receipts. A request with `images` or `documents` goes to
the first connection for images, anything else to the first one for text.
Pass `connection: "<id>"` to use a particular one.

What the AI decides is only ever a suggestion: a module stores it as pending,
shows it, and acts (posts an entry, sends mail, changes or deletes a record)
only after a person with the right role approves it in the module's page.
Nothing happens on AI output alone, including in background jobs.

```js
const s = await ctx.llm.status(); // { configured, allowed, provider, model, readsPdf, images: { configured, provider, model }, connections }

// Plain text
const { text } = await ctx.llm.complete({ system: "You are a bookkeeper.", prompt: "Summarise: …", maxTokens: 500 });

// JSON that matches a schema
const { data } = await ctx.llm.json({
	system: "Pick the best account for each transaction.",
	prompt: JSON.stringify({ accounts, transactions }),
	schema: { type: "object", properties: { picks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, account_code: { type: "string" } }, required: ["id", "account_code"] } } }, required: ["picks"] },
});

// A conversation, and PDFs (read by Claude; others get the text only)
await ctx.llm.complete({ messages: [{ role: "user", content: "…" }, { role: "assistant", content: "…" }, { role: "user", content: "…" }] });
await ctx.llm.json({ prompt: "Read this bill", schema, documents: [{ media_type: "application/pdf", data: base64, name: "bill.pdf" }] });

// Pictures (PNG, JPEG, GIF, WebP; at most 20), sent to the connection for images
await ctx.llm.json({ prompt: "Read this receipt", schema, images: [{ media_type: "image/jpeg", data: base64 }] });
```

Results: `{ text, data?, model, usage: { input_tokens, output_tokens } }`.
Errors throw an `HttpError`, which a route handler can let through: 409 when
no connection for that kind of request is set up, 403 when the module isn't allowed, 502 when the
provider fails, 422 when the model declines. The messages say where to fix
it. `maxTokens` is capped by the admin's limit.

## Gmail (`ctx.gmail`)

An admin connects one Gmail account under **Settings → Gmail** (Google
OAuth, read and optionally send) and allows modules separately to **read**
and to **send**.

```js
const s = await ctx.gmail.status(); // { connected, account, canRead, canSend } for this module

const { messages, nextPageToken } = await ctx.gmail.search("from:billing@ newer_than:30d has:attachment", { max: 25 });
// messages: [{ id, threadId, date, from, to, subject, snippet, labels }], newest first

const m = await ctx.gmail.message(messages[0].id);   // { …summary, cc, text, html, attachments: [{ attachmentId, filename, mimeType, size }] }
const pdf = await ctx.gmail.attachment(m.id, m.attachments[0].attachmentId); // Buffer
const raw = await ctx.gmail.raw(m.id);                // Buffer: RFC 822 source

await ctx.gmail.send({
	to: "client@example.com", subject: "Invoice 31", text: "Attached.", html: "<p>Attached.</p>",
	attachments: [{ filename: "invoice-31.pdf", contentType: "application/pdf", content: pdfBuffer }],
}); // → { id, threadId }
```

Search uses Gmail's own query syntax. Errors are `HttpError`s like `ctx.llm`'s
(409 not connected, 403 not allowed, 422 bad input, 502 Gmail failed).

## Search (`ctx.search`)

```js
ctx.search.provide(async (query, { limit, user }) => {
	const { rows } = await ctx.db.query(`SELECT id, number, customer FROM ${ctx.schema}.invoices WHERE number ILIKE $1 OR customer ILIKE $1 LIMIT $2`, [`%${query}%`, limit]);
	return rows.map((r) => ({ title: `Invoice ${r.number}`, subtitle: r.customer, href: `/apps/${ctx.id}?invoice=${r.id}` }));
});
```

The query string of `/apps/<id>?…` is passed on to the module's page
(`/m/<id>/?…`, read it from `location.search`), so a link can open one
record. Ledger 0.10.1 and later; before that the page always opened at
its start.


Your results appear under your module's name in Ledger's search bar. `href`
must be a path inside Ledger. Answer within 2 seconds; slow or failing
providers are skipped.

## Files between modules (`ctx.files`)

Ledger 0.11.0 and later. Modules can pass each other files labelled
`transaction`, `receipt`, `statement` or `bill`, without posting anything to
the books: a downloads module hands a bank statement to a module that turns
statements into entries, an email module hands bills to a payables module.
Since Ledger 0.12.0 there are also `customer` and `vendor` lists (CSV). Ledger
itself sends them (sender `"ledger"`) when someone migrates from other
bookkeeping software under Settings → Import & export → Migrate: `meta` is
`{ header_row, columns: { name, email?, phone? } (the file's column names), headers, rows, source }`.
A module that keeps customers or vendors should accept them, show what it
would add for the user to approve, then mark the file `done`.

The receiver declares what it takes in its manifest:

```json
"files": { "accepts": ["statement", "bill"] }
```

Sending:

```js
const targets = ctx.files.targets("statement"); // running modules that take statements: [{ id, name, accepts }]
const sent = await ctx.files.send(
	{ to: "autosort", kind: "statement", filename: "oct.csv", contentType: "text/csv", data: buffer, meta: { account_code: "1000" }, note: "October" },
	req.user, // records who sent it
);
const mine = await ctx.files.outbox({ status: "done" });
```

Receiving:

```js
ctx.files.onReceive((file) => queue.push(file.id)); // right after another module sends one
const waiting = await ctx.files.inbox({ status: "new" });
const file = await ctx.files.get(id); // summary plus data (a Buffer)
await ctx.files.update(id, { status: "done", result: "12 transactions imported" });
```

A file's summary is `{ id, sender, recipient, kind, filename, content_type,
size_bytes, sha256, meta, note, status, result, sent_by, created_at,
updated_at }`. `status` starts as `new`; the recipient moves it to
`accepted`, `done` or `rejected` and may leave a `result` the sender can
show. The recipient can `remove(id)` a file at any time, the sender only
while it is still `new`. Files are at most 25 MB; `meta` at most 16 KB of
JSON. Sending to a module that isn't running or doesn't accept that kind
fails with 409. Settings → Modules shows what each module takes.

## Organizations (`ctx.orgs`)

Ledger 0.11.0 and later. One server can hold several organizations, each
with books of its own in a separate database: accounts, entries, CSV files,
files between modules, and each module's schema. Users switch between the
organizations they belong to in the sidebar.

Requests run in the user's current organization, and `ctx.db`,
`ctx.ledger`, `ctx.dashboard`, `ctx.files` and `ctx.search` follow it, so a
module is written as if there were one set of books. `req.user.role` is the
user's role in that organization and `req.user.organization` is
`{ id, name, kind }` (`kind`: `business` or `personal`; id 1 is the main
books). Settings are per organization too (Ledger 0.11.1 and later): each
organization's admins fill in the module's form for their books, and
`ctx.settings.get()` returns the values of the organization the code runs in
(`onChange` is called inside that organization). New organizations start
from the defaults. `ctx.llm` and `ctx.gmail` are shared by the whole server.

Work outside a request (timers, startup) runs in the main books. Repeat it
for every organization with `forEach`:

```js
setInterval(() => ctx.orgs.forEach(async (org) => {
	const due = await ctx.db.query(`SELECT count(*)::int AS n FROM ${ctx.schema}.invoices WHERE due < now()`);
	if (due.rows[0].n) await ctx.dashboard.notify({ key: "overdue", title: `${due.rows[0].n} invoices overdue` });
}), 3600_000);
```

`ctx.orgs.current()` and `ctx.orgs.list()` return `{ id, name, kind }` and
the list of organizations.

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
- Account dropdowns should end with **"+ New account…"** (Ledger 0.11.3 and
  later): post a message to the parent window and Ledger opens its own New
  account dialog over the module's page, so whatever the user was filling in
  stays put, then sends the created account back:

```js
function newAccount(defaults = {}) {
	const id = crypto.randomUUID();
	return new Promise((resolve) => {
		addEventListener("message", function on(e) {
			if (e.origin !== location.origin || e.data?.type !== "ledger-new-account-result" || e.data.id !== id) return;
			removeEventListener("message", on);
			resolve(e.data.account); // { code, name, type, currency, ... } or null (cancelled / viewer)
		});
		parent.postMessage({ type: "ledger-new-account", id, defaults }, location.origin); // defaults: { name, type, currency, code, description }
	});
}
```

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

**Checking a module.** `node .claude/skills/ledger-module/scripts/check-module.ts <dir>`
validates the manifest the way Ledger does and checks files, imports and
migrations. With `TEST_DATABASE_URL` set to a PostgreSQL superuser URL, it
also loads the module into a real Ledger in a scratch database and calls its
routes; add `--serve 8098` to keep it running so you can open its UI. Claude
Code uses this through the `ledger-module` skill in `.claude/skills/`, so
"build a Ledger module that…" in a Claude Code session on this repository
follows the whole workflow: scaffold, implement, check, publish.

**Running it in Ledger.**

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
