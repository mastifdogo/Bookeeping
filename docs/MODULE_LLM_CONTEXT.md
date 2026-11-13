# Context for building a Ledger module

> **How to use:** copy this whole file into a chat with an LLM, then describe
> the module you want after it, e.g. "Build an invoicing module: customers,
> invoices with line items, mark paid posts a journal entry." Ask for every
> file in full. Keep this file in sync with docs/MODULES.md.

---

You are writing a **module** for **Ledger**, a self-hosted, double-entry
bookkeeping web app (Node.js 24 + PostgreSQL 16 backend, SvelteKit frontend).
A module is a GitHub repository that Ledger installs from its latest GitHub
Release and runs inside its own server process. Produce a complete,
working repository following every rule below. Ask nothing; choose sensible
defaults and state them.

## 1. Repository layout

```
ledger-module.json     manifest (required, at the root)
server.mjs             backend: ES module, plain JavaScript (optional)
ui/index.html          the module's page, plus any assets in ui/ (optional)
migrations/001_init.sql  database migrations, NNN_name.sql (optional)
README.md              what it does and how to use it
```

- No build step happens on install: the tagged source archive is installed
  as-is. Use plain JavaScript (no TypeScript, no bundler) or commit built
  output into `ui/`.
- **No npm dependencies** are available at runtime. Only Node.js built-ins
  (`node:crypto`, `node:fs`, global `fetch`, ...) and what `ctx` provides.
- Paths in the manifest are relative, never contain `..` or hidden
  (`.name`) parts.

## 2. ledger-module.json

```json
{
  "id": "invoicing",
  "name": "Invoicing",
  "version": "1.0.0",
  "description": "Customers and invoices; paid invoices post to the ledger.",
  "ledger": ">=0.9.1",
  "server": "server.mjs",
  "ui": "ui",
  "nav": { "label": "Invoices", "icon": { "path": "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3" } },
  "migrations": "migrations",
  "settings": {
    "fields": [
      { "key": "company_name", "label": "Company name", "type": "text", "required": true },
      { "key": "receivable_account", "label": "Receivable account code", "type": "text", "default": "1200" },
      { "key": "payment_days", "label": "Payment terms (days)", "type": "number", "min": 0, "max": 365, "default": 30 },
      { "key": "currency", "type": "select", "options": ["CAD", "USD"], "default": "CAD" },
      { "key": "smtp_password", "label": "SMTP password", "type": "secret", "help": "For emailing invoices." }
    ]
  }
}
```

- `id`: 2–32 chars, `^[a-z][a-z0-9-]{1,31}$`, permanent. DB schema is
  `mod_<id>` with `-` → `_` (e.g. `mod_invoicing`).
- `version`: `x.y.z`. `ledger`: optional `>=x.y.z`; use `>=0.9.1` (needed
  for drawn icons; `settings` needs 0.9.0, `ctx.dashboard` 0.8.0, `files`
  and `ctx.orgs` 0.11.0).
- `files`: optional (Ledger ≥ 0.11.0), `{"accepts": ["statement", "bill"]}`:
  the kinds of file other modules may hand this one through `ctx.files`
  (`transaction`, `receipt`, `statement`, `bill`; `customer` and `vendor`
  lists since 0.12.0). Needs `server`.
- `nav`: optional sidebar entry (requires `ui`); `label` ≤ 24 chars; `icon`:
  - a name: `hammer wrench invoice cart chart users mail calendar box dollar bank wallet piggy receipt tag truck home briefcase clock globe key lock star heart bell file folder cloud database link send phone printer gift bot sparkles pie target scale percent calculator`; or
  - your own drawing (Ledger ≥ 0.9.1): `{"path": "<SVG path data on a 24x24 grid>", "fill": false}`.
    It is stroked 1.8px with round caps in the sidebar colour (or filled with `"fill": true`); only
    path commands and numbers, ≤ 4000 chars, keep ~2px margin. Draw something
    that says what the module does; or
  - an SVG file in `ui/` (Ledger ≥ 0.9.1): `{"file": "icon.svg"}`, used as a mask (shape only).
- Users can hide or reorder sidebar entries under Settings → Sidebar. Every
  module also has a tab under Settings (info, its settings form, and its page
  when hidden from the sidebar).

## 3. server.mjs: `export default async function register(ctx)`

Runs once at Ledger startup; must finish within 15 s; if it throws, the
module shows "Failed to load" and the rest of Ledger keeps running. Code
changes take effect when Ledger restarts.

```js
/** @param {any} ctx */
export default async function register(ctx) {
	const t = `${ctx.schema}.invoices`; // always schema-qualify your tables
	ctx.route("GET", "/invoices", async (req) => {
		const { rows } = await ctx.db.query(`SELECT * FROM ${t} ORDER BY id DESC LIMIT 100`);
		return { data: rows };
	});
	ctx.route("POST", "/invoices", async (req) => {
		const b = req.body ?? {};
		if (typeof b.customer !== "string" || !b.customer.trim()) throw new ctx.HttpError(422, "customer is required");
		const { rows } = await ctx.db.query(`INSERT INTO ${t} (customer, created_by) VALUES ($1, $2) RETURNING *`, [b.customer.trim(), req.user.username]);
		return ctx.response(201, rows[0]);
	});
}
```

### ctx

| Member | |
|---|---|
| `id`, `name`, `version`, `dir`, `ledgerVersion` | Info. `dir` = install directory (root-owned, read-only for the app: don't write files there). |
| `schema` | e.g. `"mod_invoicing"`. |
| `route(method, path, handler)` | `GET POST PUT PATCH DELETE`; path like `/invoices/:id`; served at `/api/v1/m/<id>/invoices/:id`. Every route requires a logged-in user. |
| `db.query(sql, params?)` | → `{ rows, rowCount }`. Ledger's pooled connection (restricted role). Always use `$1, $2` placeholders. Full access to your own schema; read access to Ledger's tables (but use `ctx.ledger` instead of raw SQL for the books). No transactions spanning calls (each query may use a different pooled connection); keep multi-statement writes in one SQL statement (CTEs) when atomicity matters. |
| `ledger.*` | Ledger's own functions, below. |
| `dashboard.*` | Notifications and to-dos on Ledger's dashboard, below. |
| `settings.*` | `get()`, `set(values)`, `onChange(fn)` for the manifest's settings, below. |
| `llm.*` | The shared AI provider (Ledger ≥ 0.10.0): `status()`, `complete()`, `json()`, below. |
| `gmail.*` | The shared Gmail account (Ledger ≥ 0.10.0): `status()`, `search()`, `message()`, `attachment()`, `raw()`, `send()`, below. |
| `search.provide(fn)` | Adds results to Ledger's search bar (Ledger ≥ 0.10.0), below. |
| `files.*` | Hand files (statements, bills, receipts, transactions) to other modules and receive them (Ledger ≥ 0.11.0), below. |
| `orgs.*` | The organizations (separate books) on this server: `current()`, `list()`, `forEach(fn)` (Ledger ≥ 0.11.0), below. |
| `HttpError` | `throw new ctx.HttpError(status, message)` → that status with JSON error body. |
| `response(status, body?)` | Return it to choose the status (e.g. 201). |
| `log.info/warn/error(msg, attrs?)` | JSON log lines (journalctl -u ledger). |

**Handler** `req`: `{ method, path, params, query: URLSearchParams, body, user: { username, role, organization: { id, name, kind } } }`.
`role` is `admin`, `bookkeeper` or `viewer` (Ledger ≥ 0.10.0), the user's
role in the organization the request works in (`organization`, Ledger ≥
0.11.0; see "Organizations" below). Ledger already
answers 403 to non-GET requests from viewers; check `req.user.role === "admin"`
yourself for module-setup actions only admins should do.
`body` is parsed JSON (request must send `Content-Type: application/json`;
max 1 MiB) or `undefined`. Return value → JSON 200; `undefined` → 204;
`ctx.response(s, b)` → status `s`. Other thrown errors → 500 (Ledger's own
validation errors → 422 with details, not found → 404).

**Types**: `db.query` returns PostgreSQL `BIGINT` (ids, cents, `count(*)`)
as JavaScript **`bigint`** (don't mix with numbers: `1n + 2n`, or cast in SQL
with `::int`), `DATE` as `"YYYY-MM-DD"` strings, `TIMESTAMPTZ` as `Date`,
`NUMERIC` as strings. Ledger sends `bigint` as exact JSON numbers and `Date`
as ISO strings in responses. Parameters: pass `bigint`, numbers or strings.

### Money and the books

- All amounts are **integer cents** (`bigint` from `ctx.ledger`). Never use
  floats for money. In your own tables use `BIGINT` cents.
- Currencies: `"CAD"` and `"USD"` only. Each account has one currency. Never
  add amounts across currencies.
- Account types: `asset liability equity revenue expense`. Account codes:
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` (e.g. `1000`, `4100`).
- `Account.balance_cents` is signed debit-positive (assets/expenses normally
  positive; liabilities/equity/revenue normally negative).
- **Sub-accounts** (Ledger ≥ 0.15.0): `Account.parent_code` is the account
  it sits under (same type and currency, at most 5 levels) or `null`;
  `balance_cents` is the account's own postings and `total_balance_cents`
  adds every sub-account below it. Both a parent and its sub-accounts can be
  posted to. Show the chart as a tree (indent by depth) and, in account
  pickers, list sub-accounts under their parent; when you total a group, use
  the parent's `total_balance_cents` instead of adding accounts yourself.
- Journal entries must balance **per currency** (total debits = total
  credits in each currency), each line is either debit or credit (>0, not
  both), accounts must exist and be active. Posted entries are **immutable**:
  to undo, reverse. Modules can't edit or delete entries.

### ctx.ledger

| Function | Returns |
|---|---|
| `listAccounts({ includeInactive? })` | `Account[]` |
| `getAccount(code)` | `Account` (throws 404 if missing) |
| `createAccount({ code, name, type, currency, description?, parent_code? })` | `Account` (`parent_code`: Ledger ≥ 0.15.0) |
| `accountLedger(code, { from?, to? })` | `{ account, opening_balance_cents, closing_balance_cents, lines: [{ journal_entry_id, line_id, entry_date, description, reference, memo, debit_cents, credit_cents, running_balance_cents }] }` |
| `listJournalEntries({ from?, to?, accountCode?, limit? (1-500, default 50), offset? })` | `JournalEntry[]`, newest first |
| `getJournalEntry(id)` | `JournalEntry` |
| `createJournalEntry({ entry_date, description, reference?, lines: [{ account_code, debit_cents?, credit_cents?, memo? }], links?: [{ ref, label, href? }] }, req.user)` | `JournalEntry`. Amounts: number, bigint or digit string. Pass `req.user` to attribute it. `links` (Ledger ≥ 0.11.2) are saved in the same transaction. Invalid → throws (API answers 422). |
| `reverseJournalEntry(id, { entry_date?, description? }, req.user)` | the reversing `JournalEntry` |
| `linkJournalEntry(id, { ref, label, href? }, req.user)` | `JournalEntry` (Ledger ≥ 0.11.2). Links the entry to one of your records; the same `ref` again updates it. |
| `unlinkJournalEntry(id, ref)` | `true`, or `false` if there was no such link (only your own links) |
| `linkedEntries(ref?)` | `[{ entry_id, ref, label, href, reversed }]`: entries linked to that record (all of your links without `ref`) |
| `trialBalance({ asOf?, currency? })` | `{ as_of, rows: [{ account_code, account_name, account_type, currency, debit_cents, credit_cents }], totals: [{ currency, debit_cents, credit_cents }] }` |
| `balanceSheet({ asOf?, currency? })` | `{ as_of, currencies: [{ currency, assets, liabilities, equity: ReportLine[], net_income_cents, total_assets_cents, total_liabilities_cents, total_equity_cents, balanced }] }` |
| `incomeStatement({ from?, to?, currency? })` | `{ from, to, currencies: [{ currency, revenue, expenses: ReportLine[], total_revenue_cents, total_expenses_cents, net_income_cents }] }` |

Dates are `"YYYY-MM-DD"` strings. `ReportLine = { account_code, account_name, amount_cents }` (natural sign).

`Account = { code, name, type, currency, description, is_active, balance_cents, created_at, updated_at }`

`JournalEntry = { id, entry_date, description, reference, reverses_id, reversed_by_id, import_id, created_by, posted_at, totals: [{ currency, amount_cents }], lines: [{ id, line_number, account_code, account_name, currency, debit_cents, credit_cents, memo }], links: [{ module_id, ref, label, href, created_at }] }`

**Links** (Ledger ≥ 0.11.2): link each entry you post to the record it came
from (an invoice, a bank line, a bill): `ref` is your own key
(`"invoice:31"`, ≤ 200 chars), `label` what people see (`"Invoice 31 ·
Acme"`), `href` where it opens in Ledger (`/apps/<id>?invoice=31`, optional).
Ledger shows them on the entry and in the journal. Use `linkedEntries(ref)` to
find a record's entries (e.g. to see whether an invoice was posted or
reversed) instead of storing entry ids only in your own tables.

### Settings (manifest `settings`, Ledger ≥ 0.9.0)

Put all configuration (API keys, account codes, options) in the manifest's
`settings.fields`; Ledger renders a form on the module's own tab under
Settings, validates and stores it. Don't build your own settings screen.

- Field: `{ key, label?, type?, help?, required?, default?, options?, min?, max? }`.
  `key` `^[a-z][a-z0-9_]{0,39}$`; `type` one of `text` (≤500, one line),
  `textarea` (≤10000), `secret` (≤2000, write-only in the UI, no default),
  `number` (`min`/`max`), `boolean`, `select` (`options`: strings or
  `{ value, label }`). At most 50 fields.
- Optional `settings.page`: a file in `ui/` shown in an iframe below the
  form, only for things a form can't do.

```js
const s = await ctx.settings.get();        // { company_name: "...", payment_days: 30, smtp_password: "..." } (defaults filled in; may be null/"" if unset)
await ctx.settings.set({ payment_days: 15 }); // validated; throws on bad values
ctx.settings.onChange((values) => { /* react to the user saving */ });
```

Read settings on each request (cheap) rather than caching at startup, or use
`onChange`. Handle missing required values gracefully (return 409 with "Set
the company name under Settings → <module name>").

### ctx.dashboard (Ledger ≥ 0.8.0)

Items belong to the module; `key` (1-100 chars) is your own id; posting the
same key again updates instead of duplicating.

```js
await ctx.dashboard.notify({ key: "overdue", title: "2 invoices are overdue", body: "Acme (#28), Globex (#30)",
	level: "warning" /* info|success|warning|danger */, link: "/apps/invoicing", expiresAt: "2026-12-01T00:00:00Z" });
await ctx.dashboard.todo({ key: "inv-31", title: "Send invoice 31", body: "", due: "2026-10-31", link: "/apps/invoicing" });
await ctx.dashboard.complete("inv-31"); // → boolean
await ctx.dashboard.reopen("inv-31");
await ctx.dashboard.dismiss("overdue");
await ctx.dashboard.remove("inv-31");               // remove(key, "notification") for notifications
await ctx.dashboard.list({ kind: "todo", open: true }); // → items
```

title 1-200 chars, body ≤ 2000 (plain text), link must be a path inside
Ledger starting with `/` (your page is `/apps/<id>`; a query string such as
`/apps/<id>?invoice=31` reaches your page as `location.search`, Ledger ≥ 0.10.1). A dismissed
notification reappears only if re-posted with a different title/body.
Notification without `key` → always a new one. There is no timer API: post
items from route handlers or from `register` (startup); a `setInterval` in
`register` is allowed for periodic checks (keep it light, `unref()` it).

## 4. migrations/NNN_name.sql

- Run **once each**, in file-name order, each in a transaction, as the
  module's own DB role, with `search_path` = the module's schema. Write
  `CREATE TABLE invoices (...)` (unqualified) — it lands in `mod_<id>`.
- No `BEGIN`/`COMMIT`, no `CREATE SCHEMA`, no `GRANT`s needed (Ledger grants
  itself read/write on everything you create, including sequences).
- Don't alter Ledger's tables or add foreign keys to them (`public.*`);
  store account codes / entry ids as plain columns.
- Never edit a released migration; add `002_...sql`. Removing the module
  keeps its data.

```sql
CREATE TABLE invoices (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer    TEXT        NOT NULL CHECK (length(btrim(customer)) BETWEEN 1 AND 200),
    total_cents BIGINT      NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    currency    TEXT        NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
    entry_id    BIGINT,                      -- journal entry posted for it, if any
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 5. ui/

- Served at `/m/<id>/` and shown in an iframe inside Ledger (next to the
  sidebar, or in a side-by-side pane). Same origin, so `fetch` to
  `/api/v1/m/<id>/...` carries the user's login automatically. Ledger's own
  API (`/api/v1/accounts`, `/api/v1/journal-entries`, `/api/v1/reports/...`)
  is also callable the same way.
- POST/PUT/PATCH/DELETE must be same-origin `fetch` with
  `Content-Type: application/json` (cross-site requests are rejected).
- Errors come back as `{ "error": { "code": "...", "message": "...", "details": [{ "field", "message" }] } }`.
- A path without a file extension serves `index.html` (client-side routing
  works). Use relative or `/m/<id>/` URLs for assets.
- Plain HTML/CSS/JS in one `index.html` is preferred. No external CDNs
  needed; keep it self-contained.
- Match Ledger's look: system-ui font, 15px, 6px radius, borders
  `#dde1e6`, accent `#1f6feb`, background white; dark mode via
  `@media (prefers-color-scheme: dark)` (bg `#171b21`, text `#e3e7ec`,
  muted `#97a1ad`, border `#2c333c`, accent `#4c8dff`). Must work from
  ~260px wide (panes) up to full width.
- Show money as `(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })` plus the currency code.
- Every account dropdown (categorizing transactions, choosing accounts in
  settings-like forms) ends with **"+ New account…"** that calls
  `newAccount()` below, then adds the account to the list and selects it.
  Prefill what you know (e.g. `{ name: "Coffee shops", type: "expense",
  currency: "CAD" }`). Hide it for viewers (`req.user.role`).

```js
// "+ New account…" in your account dropdowns (Ledger ≥ 0.11.3): Ledger opens its
// New account dialog over your page (nothing typed is lost) and answers with the account.
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

```js
const api = (path, opts = {}) =>
	fetch(`/api/v1/m/invoicing${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } })
		.then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
			return r.status === 204 ? null : r.json();
		});
```

### ctx.llm (Ledger ≥ 0.10.0)

**Never call an AI API yourself and never ask for an AI API key in your
settings.** The admin sets up LLM connections (Claude, Ollama or an
OpenAI-compatible server) under Settings → LLM API and ticks which modules
may use them; keys never reach modules. Since Ledger 0.11.2 there can be
several connections: one for text and one for images and documents (e.g. a
local vision model). Requests with `images` or `documents` go to the
connection for images, others to the one for text; `connection: "<id>"`
picks one by id.

```js
const st = await ctx.llm.status();
// { configured, allowed, provider, model, readsPdf, images: { configured, provider, model }, connections: [{ id, name, uses, provider, model }] }
const { text } = await ctx.llm.complete({ system: "…", prompt: "…", maxTokens: 800 });
const { data } = await ctx.llm.json({ system: "…", prompt: "…", schema: { type: "object", properties: { … }, required: [ … ] } });
// also: messages: [{ role: "user" | "assistant", content }], documents: [{ media_type: "application/pdf", data: base64, name }]
//       images: [{ media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: base64 }] (≤ 20; Ledger ≥ 0.11.2)
//       connection: "vision" (a connection id) or "text" / "images"
// result: { text, data?, model, usage: { input_tokens, output_tokens } }
```

Errors are `HttpError`s (409 not set up, 403 module not allowed, 502 provider
failed, 422 declined) whose messages tell the user where to fix it. Let them
propagate from route handlers, or catch them and show `status()` in the UI
("Ask an admin to allow <module> under Settings → LLM API"). Batch work (e.g. 40
transactions per call) rather than one call per item. Use `json()` with a
strict schema for anything the code parses.

**Human approval.** AI output is a suggestion, never an action. Anything
`ctx.llm` decides (an entry to post or reverse, an email to send, a record
to change or delete, a file to mark done, an outside call) is stored as a
pending suggestion with what it would do and why, shown in the UI, and
carried out only when a user with the right role approves it (an explicit
POST from the UI, passing `req.user`); users can edit or reject it.
Background jobs and `onReceive` handlers may call the AI and store
suggestions, but never act on them. No "auto-approve" setting.

### ctx.gmail (Ledger ≥ 0.10.0)

**Never implement OAuth, IMAP or an Apps Script bridge for Gmail.** The admin
connects one account under Settings → Gmail and allows each module to read
and/or send.

```js
const st = await ctx.gmail.status(); // { connected, account, canRead, canSend } for this module
const { messages, nextPageToken } = await ctx.gmail.search("from:bills@ newer_than:30d has:attachment", { max: 25, pageToken });
// messages: [{ id, threadId, date (ISO), from, to, subject, snippet, labels }], newest first
const m = await ctx.gmail.message(id);   // { …, cc, text, html, attachments: [{ attachmentId, filename, mimeType, size }] }
const buf = await ctx.gmail.attachment(m.id, m.attachments[0].attachmentId); // Buffer
const raw = await ctx.gmail.raw(id);      // Buffer (RFC 822), for your own MIME parsing
await ctx.gmail.send({ to, cc?, bcc?, replyTo?, subject, text?, html?, attachments?: [{ filename, contentType?, content: Buffer }], threadId? }); // → { id, threadId }
```

Remember which message ids you've processed (in your own table) instead of
relying on read/unread state; the access is read-only. Errors as for `ctx.llm`.

### ctx.search (Ledger ≥ 0.10.0)

```js
ctx.search.provide(async (query, { limit, user }) => [{ title: "Invoice 31", subtitle: "Acme Corp · $4,200.00", href: "/apps/<id>?invoice=31" }]);
```

Return at most `limit` results; `href` must start with `/` (`/apps/<id>?…`
passes the query string to your page, Ledger ≥ 0.10.1); answer within 2 s
(parameterized `ILIKE` on indexed columns).

### ctx.files (Ledger ≥ 0.11.0)

Modules hand each other files labelled `transaction`, `receipt`,
`statement` or `bill`, without posting anything: e.g. a downloads module
passes a bank statement to a module that sorts statements into entries. The
receiver lists the kinds it takes in its manifest (`"files": {"accepts": […]}`).
Since Ledger 0.12.0 there are also `customer` and `vendor` lists (CSV). Ledger
itself sends them (sender `"ledger"`) when someone migrates from other
bookkeeping software under Settings → Import & export → Migrate: `meta` is
`{ header_row, columns: { name, email?, phone? } (the file's column names), headers, rows, source }`.
A module that keeps customers or vendors should accept them, show what it
would add for the user to approve, then mark the file `done`.

```js
ctx.files.targets("statement");            // → [{ id, name, accepts }] running modules that take statements
const f = await ctx.files.send({ to: "autosort", kind: "statement", filename: "oct.csv", data: buffer,
  contentType: "text/csv", meta: { account_code: "1000" }, note: "October" }, req.user); // → summary
await ctx.files.outbox({ status, kind, limit });  // what this module sent → [summary]

// Receiving side
ctx.files.onReceive((summary) => { /* queue work; don't block */ });
await ctx.files.inbox({ status: "new", kind, limit }); // → [summary]
const file = await ctx.files.get(id);      // → { ...summary, data: Buffer } (sender or recipient)
await ctx.files.update(id, { status: "done", result: "12 transactions imported" }); // recipient only
await ctx.files.remove(id);                // recipient any time; sender while status is "new"
```

Summary: `{ id, sender, recipient, kind, filename, content_type,
size_bytes, sha256, meta, note, status, result, sent_by, created_at,
updated_at }`; `status` is `new`, `accepted`, `done` or `rejected`. `data`
is a Buffer, Uint8Array or base64 text, at most 25 MB; `meta` ≤ 16 KB as
JSON. Sending to a module that isn't running or doesn't accept the kind
answers 409. Files belong to the organization the request works in.

### ctx.storage (Ledger ≥ 0.13.2)

A module's own files: PDFs it generates (invoices), scans, attachments it
keeps. They live on the data share next to the CSV files, per organization
and module (not in the database), and every backup folder carries them under
`files/<module>/…`. Use it instead of `bytea` columns for documents.

```js
const f = await ctx.storage.put("invoices/2026/INV-31.pdf", pdfBuffer); // Buffer, Uint8Array or base64; ≤ 100 MB; replaces
// f: { path, size, content_type, modified_at, url }
const got = await ctx.storage.get("invoices/2026/INV-31.pdf"); // → { ...f, data: Buffer } or null
await ctx.storage.stat(path);                 // → f or null
await ctx.storage.list("invoices/2026");      // → [f] under a folder ("" = all), sorted by path
await ctx.storage.remove(path);               // → boolean; empty folders go too
ctx.storage.url(path);                        // "/api/v1/modules/<id>/storage/invoices/2026/INV-31.pdf"
```

Paths are up to 8 `/`-separated parts of letters, digits, spaces and
`. _ - ( )` (no `..`, no leading dot); anything else answers 422. `url` is
what the module's page links to or shows in an `<iframe>`/`<img>`: logged-in
users of that organization can open it (PDFs, images and text inline, other
types download). Keep a row in your own table with the path and what the
file is for; store files under the organization the request works in (it
follows automatically, like `ctx.db`).

### ctx.imports (Ledger ≥ 0.13.2)

Gives the module an **Import from CSV** card on its page under Settings →
Modules. Ledger reads the file (any column names and order, a title row
above the headers, `;` or tab separators, UTF-16), matches columns to your
fields by name or with the AI (when an LLM API is set up), converts the
values, and shows the user a preview with your dry-run check before anything
is imported.

```js
ctx.imports.provide({
	label: "Customers",                         // "Import customers from CSV"
	description: "Contacts and opening balances.",
	fields: [                                   // 1–60; key: lowercase letters, digits, _
		{ key: "name", label: "Customer name", required: true },
		{ key: "email", label: "Email" },
		{ key: "balance", label: "Opening balance", type: "money" }, // text (default) | number | money | date | boolean
		{ key: "since", label: "Customer since", type: "date", help: "First invoice date" },
	],
	async handler(rows, { dryRun, user }) {
		// rows: [{ _row: 7, name: "Acme", email: null, balance: 120000, since: "2025-03-01" }]
		// money → integer cents (number), date → "YYYY-MM-DD", boolean → true/false, empty → null
		const errors = []; // [{ row: r._row, message: "Acme already exists" }]; in the dry run these block the import
		if (dryRun) return { summary: `Would add ${rows.length - errors.length} customers.`, errors }; // change nothing
		/* insert in one transaction */
		return { summary: `Added ${rows.length} customers.` };
	},
});
```

Rows whose values can't be read (or miss a required field) are left out and
listed for the user; the handler only gets good rows. The import runs only
after the user presses Import (bookkeepers and admins), and is refused if
your dry run returned errors. Throwing `ctx.HttpError(422, …)` shows your
message. Make the handler idempotent where you can (skip rows that already
exist and say so in `summary`).

### Organizations (Ledger ≥ 0.11.0)

A server can hold several organizations (a business, someone's personal
books), each with its own database: accounts, entries, files and **your
module's schema and data** are separate per organization. Each request runs
in the user's current organization, and `ctx.db`, `ctx.ledger`,
`ctx.dashboard`, `ctx.files`, `ctx.storage` and `ctx.search` follow it automatically: write
your module as if there were one set of books. `ctx.settings` is per
organization as well (Ledger ≥ 0.11.1): each organization's admins set its
values, `get()` returns the current organization's (defaults in a new one),
and `onChange` runs inside the organization that changed. `ctx.llm` and
`ctx.gmail` are server-wide.

Background work (timers, `onReceive` outside a request, startup) runs in the
main books. To do it for every organization:

```js
await ctx.orgs.forEach(async (org) => { /* ctx.db, ctx.ledger here use org's books */ }); // org: { id, name, kind }
await ctx.orgs.current();  // → { id, name, kind } of the request's organization (1 = main books)
await ctx.orgs.list();     // → [{ id, name, kind }]
```

`kind` is `business` or `personal`. Don't store organization ids in your own
tables to separate data: each organization's data is already in its own
database.

## 6. Security rules

- Parameterized SQL only (`$1`); never interpolate user input into SQL. Only
  `${ctx.schema}` may be interpolated.
- Validate every request body field (type, length, range) and answer 422
  with a clear message.
- Secrets (API keys for external services): declare a `secret` settings
  field; read it with `ctx.settings.get()`; never return it from your own
  endpoints; never log it.
- Outbound calls with global `fetch` and a timeout
  (`AbortSignal.timeout(10_000)`).
- Never write to the filesystem outside `os.tmpdir()`.

## 7. Publishing

1. Bump `version` in `ledger-module.json`.
2. `git tag v1.0.0 && git push origin v1.0.0`, then create a GitHub Release
   from the tag (not draft/pre-release).
3. In Ledger: Settings → Modules → enter `owner/repo` → Add. Updates install
   on Ledger's update schedule, with "Update modules now", or when the server
   starts if "Update when the server starts" is on (0.12.1). If Ledger fails
   to start after an install, it's rolled back automatically.

## 8. Checklist for your answer

- [ ] `ledger-module.json` valid per §2, `"ledger": ">=0.9.1"` (`">=0.10.0"` if it uses `ctx.llm`, `ctx.gmail`, `ctx.search` or `req.user.role`; `">=0.11.0"` for `files`, `ctx.files`, `ctx.orgs` or `req.user.organization`; `">=0.13.2"` for `ctx.storage` or `ctx.imports`), with a drawn `nav.icon` that fits the module
- [ ] background jobs that touch the books run through `ctx.orgs.forEach` so every organization gets them
- [ ] configuration (API keys, options) declared as manifest `settings`, read with `ctx.settings.get()`
- [ ] AI through `ctx.llm` and Gmail through `ctx.gmail` (never your own keys/OAuth); README says to allow the module under Settings → LLM API / Gmail
- [ ] account dropdowns end with "+ New account…" (the `ledger-new-account` message, Ledger ≥ 0.11.3)
- [ ] entries posted from module records carry `links` (Ledger ≥ 0.11.2)
- [ ] every action an LLM proposes waits for a person to approve it (pending suggestions in the UI; nothing posted, sent or changed on AI output alone)
- [ ] searchable records exposed with `ctx.search.provide`
- [ ] documents the module keeps (PDFs, scans) in `ctx.storage`, not `bytea` columns; records people bring from elsewhere importable with `ctx.imports.provide`
- [ ] `server.mjs` default-exports `register(ctx)`, no imports except `node:*`
- [ ] tables schema-qualified with `${ctx.schema}` in queries
- [ ] survives a restore (Ledger ≥ 0.14.0): an organization's restore replaces the module's tables and `ctx.storage` files with a backup's (an uploaded dump: tables only) but keeps its current settings and the server's users; handle a row whose stored file, setting or external record no longer matches
- [ ] tables and columns have clear names: backups also save each module table as a readable CSV (Ledger ≥ 0.13.0); no secrets in tables (use `secret` settings); binary (`bytea`) columns show only their size there (0.13.1), so keep names, sizes and dates in readable columns
- [ ] money as integer cents, per currency, entries balanced per currency
- [ ] migrations unqualified, no BEGIN/COMMIT/GRANT
- [ ] `ui/index.html` self-contained, light + dark, narrow-width friendly
- [ ] README with what it does, which accounts it expects, and how to release
