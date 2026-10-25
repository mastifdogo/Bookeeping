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
  "ledger": ">=0.7.0",
  "server": "server.mjs",
  "ui": "ui",
  "nav": { "label": "Invoices", "icon": "invoice" },
  "migrations": "migrations"
}
```

- `id`: 2–32 chars, `^[a-z][a-z0-9-]{1,31}$`, permanent. DB schema is
  `mod_<id>` with `-` → `_` (e.g. `mod_invoicing`).
- `version`: `x.y.z`. `ledger`: optional `>=x.y.z`; use `>=0.7.0` (needed
  for `ctx.dashboard`).
- `nav`: optional sidebar entry (requires `ui`); `label` ≤ 24 chars; `icon`
  one of `hammer wrench invoice cart chart users mail calendar box dollar`.
- Users can hide or reorder sidebar entries under Settings → Sidebar.

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
| `HttpError` | `throw new ctx.HttpError(status, message)` → that status with JSON error body. |
| `response(status, body?)` | Return it to choose the status (e.g. 201). |
| `log.info/warn/error(msg, attrs?)` | JSON log lines (journalctl -u ledger). |

**Handler** `req`: `{ method, path, params, query: URLSearchParams, body, user: { username } }`.
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
- Journal entries must balance **per currency** (total debits = total
  credits in each currency), each line is either debit or credit (>0, not
  both), accounts must exist and be active. Posted entries are **immutable**:
  to undo, reverse. Modules can't edit or delete entries.

### ctx.ledger

| Function | Returns |
|---|---|
| `listAccounts({ includeInactive? })` | `Account[]` |
| `getAccount(code)` | `Account` (throws 404 if missing) |
| `createAccount({ code, name, type, currency, description? })` | `Account` |
| `accountLedger(code, { from?, to? })` | `{ account, opening_balance_cents, closing_balance_cents, lines: [{ journal_entry_id, line_id, entry_date, description, reference, memo, debit_cents, credit_cents, running_balance_cents }] }` |
| `listJournalEntries({ from?, to?, accountCode?, limit? (1-500, default 50), offset? })` | `JournalEntry[]`, newest first |
| `getJournalEntry(id)` | `JournalEntry` |
| `createJournalEntry({ entry_date, description, reference?, lines: [{ account_code, debit_cents?, credit_cents?, memo? }] }, req.user)` | `JournalEntry`. Amounts: number, bigint or digit string. Pass `req.user` to attribute it. Invalid → throws (API answers 422). |
| `reverseJournalEntry(id, { entry_date?, description? }, req.user)` | the reversing `JournalEntry` |
| `trialBalance({ asOf?, currency? })` | `{ as_of, rows: [{ account_code, account_name, account_type, currency, debit_cents, credit_cents }], totals: [{ currency, debit_cents, credit_cents }] }` |
| `balanceSheet({ asOf?, currency? })` | `{ as_of, currencies: [{ currency, assets, liabilities, equity: ReportLine[], net_income_cents, total_assets_cents, total_liabilities_cents, total_equity_cents, balanced }] }` |
| `incomeStatement({ from?, to?, currency? })` | `{ from, to, currencies: [{ currency, revenue, expenses: ReportLine[], total_revenue_cents, total_expenses_cents, net_income_cents }] }` |

Dates are `"YYYY-MM-DD"` strings. `ReportLine = { account_code, account_name, amount_cents }` (natural sign).

`Account = { code, name, type, currency, description, is_active, balance_cents, created_at, updated_at }`

`JournalEntry = { id, entry_date, description, reference, reverses_id, reversed_by_id, import_id, created_by, posted_at, totals: [{ currency, amount_cents }], lines: [{ id, line_number, account_code, account_name, currency, debit_cents, credit_cents, memo }] }`

### ctx.dashboard (Ledger ≥ 0.7.0)

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
Ledger starting with `/` (your page is `/apps/<id>`). A dismissed
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

```js
const api = (path, opts = {}) =>
	fetch(`/api/v1/m/invoicing${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } })
		.then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
			return r.status === 204 ? null : r.json();
		});
```

## 6. Security rules

- Parameterized SQL only (`$1`); never interpolate user input into SQL. Only
  `${ctx.schema}` may be interpolated.
- Validate every request body field (type, length, range) and answer 422
  with a clear message.
- Secrets (API keys for external services): store in a settings table in the
  module's schema, set through the module's UI; never return them in full
  from GET endpoints; never log them.
- Outbound calls with global `fetch` and a timeout
  (`AbortSignal.timeout(10_000)`).
- Never write to the filesystem outside `os.tmpdir()`.

## 7. Publishing

1. Bump `version` in `ledger-module.json`.
2. `git tag v1.0.0 && git push origin v1.0.0`, then create a GitHub Release
   from the tag (not draft/pre-release).
3. In Ledger: Settings → Modules → enter `owner/repo` → Add. Updates install
   on Ledger's update schedule or with "Update modules now". If Ledger fails
   to start after an install, it's rolled back automatically.

## 8. Checklist for your answer

- [ ] `ledger-module.json` valid per §2, `"ledger": ">=0.7.0"`
- [ ] `server.mjs` default-exports `register(ctx)`, no imports except `node:*`
- [ ] tables schema-qualified with `${ctx.schema}` in queries
- [ ] money as integer cents, per currency, entries balanced per currency
- [ ] migrations unqualified, no BEGIN/COMMIT/GRANT
- [ ] `ui/index.html` self-contained, light + dark, narrow-width friendly
- [ ] README with what it does, which accounts it expects, and how to release
