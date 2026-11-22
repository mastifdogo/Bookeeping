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
- each time the server starts, if **Update when the server starts** is on
  there (Ledger 0.12.1 and later)
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
| `gmail.*` | The Gmail account connected under Settings → Mail → Gmail (Ledger 0.10.0 and later); see below. |
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
| `relateEntries(id, otherId, { note }, req.user)` | Links two journal entries to each other (Ledger 0.28.0 and later); returns `relatedEntries(id)`. See [Linked entries](#linked-entries). |
| `unrelateEntries(id, otherId)` | Takes that link off; `false` if there was none. |
| `relatedEntries(id)` | Every entry linked to that one, oldest first. |
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

An admin sets up LLM connections under **Settings → LLM API** and ticks the
modules allowed to use them. Modules never see the API keys. Every call is
logged per module and connection.

Any provider can sit behind a connection (Ledger 0.18.2): Anthropic, OpenAI,
Google Gemini, OpenRouter, Mistral, Groq, Ollama, or any other
OpenAI-compatible server, hosted or local. **Write modules for no provider in
particular**: the same `complete()` and `json()` calls work with all of
them, so don't branch on `status().provider` or on model names, don't put
provider-specific wording in prompts, and decide by what `status()` says is
possible (`configured`, `images.configured`, `readsPdf`). `json()` gives
parsed JSON from every provider: where a server can't enforce a schema,
Ledger asks for a JSON object with the schema in the prompt, so still check
the values you get.

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

// A conversation, and PDFs (sent as files where status().readsPdf is true; other providers get the text only,
// so put the document's extracted text in the prompt when it is false)
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

## Clearing accounts

Ledger 0.20.0. A clearing account is an in-between account: one side of a
transaction is posted to it now and the other side later, so its balance
returns to zero. Use one when the two halves of something happen at
different times or are recorded by different parts of the system: a card
sale today and its payout on Thursday, wages calculated by one module and
paid from the bank by another, a transfer leaving one account before it
arrives in the other.

A module asks for its own with a key; Ledger makes it the first time
(an asset account unless `type: "liability"`, tagged *Clearing*, with a code
like `CLR-SALES-CARD_PAYOUTS`) and returns the same account every time after:

```js
const clearing = await ctx.ledger.clearingAccount({ key: "card_payouts", name: "Card payouts in transit", currency: "CAD" });

// The sale: the money isn't in the bank yet
await ctx.ledger.createJournalEntry({ entry_date, description: "Card sale", lines: [
	{ account_code: clearing.code, debit_cents: 12000, credit_cents: 0 },
	{ account_code: revenue, debit_cents: 0, credit_cents: 12000 } ] }, req.user);

// The payout, later (this module, another module, or a person): the other side clears it
await ctx.ledger.createJournalEntry({ entry_date, description: "Card payout", lines: [
	{ account_code: bank, debit_cents: 12000, credit_cents: 0 },
	{ account_code: clearing.code, debit_cents: 0, credit_cents: 12000 } ] }, req.user);

const all = await ctx.ledger.clearingAccounts(); // every module's, with module_id, module_key and balance_cents
```

Call `clearingAccount` each time and use the code it returns: a person can
renumber the account, and the key (with the currency) is what finds it. One
account per key and currency. Another module can post the clearing side
into yours: it finds it in `clearingAccounts()` by `module_id` and
`module_key`. Since Ledger 0.20.1 clearing accounts are hidden from the
account lists and dropdowns unless a person shows them under Settings →
Clearing accounts (`hidden` on the account); reports still count them.
Ledger's own Unreconciled account has `module_id` "ledger" (a reserved
module id). The Accounts page points out any
that aren't at zero, so don't leave amounts in one that nothing will clear.
Entries still balance as always; a clearing account is an ordinary account
with a purpose, not a way around double entry.

## Entry amounts can change

Since Ledger 0.19.5 a person can change the amounts of a posted entry on its
page; the change is logged and the entry reads `amended: true`. Since 0.20.2
a person can also change an entry's date (logged in `date_changes`), and
finishing a reconciliation moves the reconciled account's unticked lines to
Ledger's Unreconciled clearing account until a person moves each on (logged
in `moves`): an entry a module posted to the bank may, for a while, have
that line in Unreconciled instead. Since 0.29.0 the entry's page has one
**Edit** for all of it, which also changes the description, reference,
customer or vendor (`entity`), any line's account, and memos (logged in
`edits`). Modules
can't do this, but they see the result: an entry a module posted may no
longer carry the amounts it posted. Where the figure matters (an invoice's
balance, a bill marked paid), read it from the entry
(`ctx.ledger.linkedEntries(ref)`) instead of trusting the module's own copy,
and show a difference to the user rather than overwriting either side.

## Linked entries

Since Ledger 0.28.0 an entry's page lists every entry linked to it, with
its date, amount and tags, and `getJournalEntry(id)` carries the same list
as `related`. An entry shows there when:

- the two were **linked to each other**, by a person on the entry's page or
  by a module (`kind: "linked"`), or it is linked to an entry that is
  (`"chain"`, with `through`);
- both are linked to the **same record of a module**: the same `ref` from
  the same module (`"record"`). So linking an invoice's entry and each of its
  payments to `invoice:31` is enough for them to show with each other;
- one **reverses** the other (`"reverses"`, `"reversed_by"`).

Link entries that belong together and have no record in common: a payment
and the invoice or bill it settles when another module posted one of them, a
transfer's two halves, a refund and its sale.

```js
await ctx.ledger.relateEntries(paymentEntryId, invoiceEntryId, { note: "payment of invoice 12" }, req.user);
const related = await ctx.ledger.relatedEntries(invoiceEntryId);
// [{ id, entry_date, description, reference, totals, tags, reversed, direct,
//    why: [{ kind, note, module_id, set_by, label, href, through }] }]
await ctx.ledger.unrelateEntries(paymentEntryId, invoiceEntryId);   // true, or false if there was none
```

A link has no direction and is there once per pair: the same pair again,
either way round, changes the note (up to 200 characters). Like a tag, it
belongs to the entries, not to the module that made it: any module or person
can take it off (`direct: true` marks the ones that can be). It says the
entries belong together, nothing more: whether something is paid or billed
is still a tag. At most 200 entries are listed for one entry.

## Tags: one system for every module

Since Ledger 0.23.0 journal entries carry tags shared by Ledger and all
modules. Use them, and only them, to say that an entry is paid, billed or
overdue, or which customer or vendor it belongs to: don't keep that only in
the module's own tables, and don't use entry links for it.

```js
await ctx.tags.set(entryId, "billed", { note: "Invoice 12" }, req.user);    // user optional: who did it
await ctx.tags.set(entryId, "customer", { entity_id: customer.entity_id });  // "customer" and "vendor" need the entity
await ctx.tags.set(entryId, "paid");                                         // takes "overdue" off
await ctx.tags.remove(entryId, "billed");
const tags = await ctx.tags.of(entryId);       // [{ tag, entity: { id, name } | null, note, module_id, set_by, set_at }]
const due = await ctx.tags.entries({ tag: "overdue", entity_id });  // journal entries, newest first; also from, to, limit
ctx.tags.onChange(async (c) => {               // every change, by any module or a person
	// c = { entry_id, action: "set" | "removed", tag, entity_id, module_id }  (module_id null: a person)
});
ctx.tags.standard;                             // ["paid", "billed", "overdue", "customer", "vendor", "rate"]
// Ledger 0.24.0 (description and several items per entry: 0.25.0):
const item = await ctx.tags.addRate(entryId, { description: "Labour", quantity: 7.5, unit: "hours", rate_cents: 8000 }, req.user);
// → { id, description: "Labour", quantity: 7.5, unit: "hours", rate_cents: 8000, amount_cents: 60000 }
await ctx.tags.setRate(entryId, { id: item.id, description: "Labour", quantity: 8, rate_cents: 8000 }); // change that item (no id: adds one)
const items = await ctx.tags.rates(entryId);   // every item, in the order added: [{ id, description, quantity, unit, rate_cents, amount_cents }]
const r = await ctx.tags.rate(entryId);        // the first item, or null
await ctx.tags.removeRate(entryId, item.id);   // takes that item off; ctx.tags.remove(entryId, "rate") takes them all
await ctx.tags.setMany([12, 13, 14], "billed", {}, req.user); // all or none, at most 500: { entries: 3, changed: 3 }
await ctx.tags.removeMany([12, 13], "overdue");               // { entries, changed }
```

- **The standard tags mean the same everywhere.** `billed`: the entry was
  charged to a customer (an invoice exists for it). `paid`: it has been paid
  in full. `overdue`: payment is past due. `customer` / `vendor`: who it is
  with (an entity; several are allowed). Other tags are lowercase words of
  up to 40 characters; pick ones another module could use.
- **A tag belongs to the entry, not to the module that set it.** Any module
  or a person can take it off. So the module's own record follows the tag:
  listen with `onChange` (or read `ctx.tags.of`) and bring the record in
  line, e.g. an invoice whose entry is tagged "paid" by someone else becomes
  paid in the module too; if "paid" is taken off, it is open again.
- **Tag what you post, when you post it** (customer or vendor, billed), and
  keep the tags true as things change (paid, overdue). Tag the entry the
  other modules would look at: the invoice's or bill's entry, not the
  payment's.
- Don't act on your own changes twice: in `onChange`, skip changes whose
  `module_id` is your own (`ctx.id`).
- `ctx.tags.entries({ entity_id })` also finds entries posted with that
  customer or vendor (`entity_id` on the entry), so tag only where the
  entry doesn't already say who.
- **`rate`: items with description, quantity and price, shared** (Ledger
  0.24.0; description and several per entry since 0.25.0). Each `rate` tag
  is one item, shown as "Labour, 7.5 hours, 80.00 = 600.00":
  `description` (up to 100 characters, optional), `quantity` (up to 4
  decimals, e.g. 7.5), `unit` (a word of up to 20 characters: hours, km,
  litres, items) and `rate_cents` (the price of one unit, in the entry's
  currency); at least one of quantity and rate. An entry can have any
  number of items, each with its own `id` (in `ctx.tags.of` and the
  entry's `tags`). Tag what you post when it is counted (a timesheet's
  hours, a mileage claim's kilometres, an invoice's lines), and when a form
  starts from an entry, fill it in from the items instead of asking again.
  Setting `rate` without an `id` adds an item; with one, changes it. Each
  change is announced to `onChange` with `tag_id`, the item's id. Over the
  API: `POST /journal-entries/{id}/tags` with `{ tag: "rate", id?,
  description, quantity, unit, rate_cents }`, and `DELETE
  /journal-entries/{id}/tags/rate?id=<item>`. People add them on the
  entry's page too. In the page, `data-ledger-entry` fills forms in for you
  (see "The UI").
- People tag many entries at once from the Journal (tick them, then add or
  take off a tag); `POST /api/v1/journal-entries/tags` with `{ entry_ids,
  action: "set" | "remove", tag, ... }` does the same, and modules use
  `ctx.tags.setMany` / `removeMany`. Each entry changed is announced to
  `onChange` on its own.
- Check `ctx.tags` exists before using it if the module still supports an
  older Ledger (and `ctx.tags.setRate` for 0.24.0's additions).

## Root mode

Since Ledger 0.21.0 an admin can turn on root mode: they can delete an
account with every journal entry posted to it, and delete users. Since
0.21.1 they can delete any entry or line and move a line to any account, so
an entry may be unbalanced, or have one line, for a while; root mode can
only be left once the books are intact again, or everything done in that
root session is reversed. Each root action can also be reversed from the
root log, which puts back the same ids. A module may therefore find that an
account code, an entry id or a user it kept no longer exists (and later
exists again), or that an entry it posted has other lines than it posted.
Treat a missing account or entry as gone, not as an error that stops the
module, and don't delete your own records because of it.

**Modules give root the same power over their own records** (Ledger
0.21.1). `req.user.root` is true while the person asking has root mode on.
When it is, the module's page offers to delete or change any of its records,
including ones it normally protects (a sent invoice, a paid bill, a posted
pay run), and does it through `ctx.root`, never with its own DELETE or
UPDATE, so Ledger keeps the row and can put it back:

```js
ctx.route("DELETE", "/invoices/:id", async (req) => {
	if (!req.user.root) { /* the normal rules: refuse a sent invoice, ... */ }
	// Rows that hang off it first (ON DELETE CASCADE rows are not kept otherwise), then the row itself.
	for (const l of (await ctx.db.query(`SELECT id FROM ${ctx.schema}.invoice_lines WHERE invoice_id = $1`, [req.params.id])).rows) {
		await ctx.root.remove(req, "invoice_lines", l.id);
	}
	return ctx.root.remove(req, "invoices", req.params.id, `Sales: deleted invoice ${req.params.id}`);
});
ctx.route("PATCH", "/invoices/:id/root", (req) => ctx.root.update(req, "invoices", req.params.id, req.body)); // any columns but id

// What must be put right before root mode can be left: a list of sentences, [] when all is sound.
ctx.root.onCheck(async () => {
	const r = await ctx.db.query(`SELECT i.number FROM ${ctx.schema}.invoices i WHERE i.status = 'sent' AND NOT EXISTS (SELECT 1 FROM ${ctx.schema}.invoice_lines l WHERE l.invoice_id = i.id)`);
	return r.rows.map((x) => `invoice ${x.number} is sent but has no lines`);
});
```

- `ctx.root.remove(req, table, id, summary?)` and
  `ctx.root.update(req, table, id, { column: value, ... }, summary?)` work
  on one row of one of the module's own tables that has an `id` column.
  They answer 403 unless `req.user.root`, write the root log entry (shown
  under Settings → Root log with the summary) and return it.
- Reversing, one action or a whole root session, puts the row back exactly;
  the module does nothing for it. Because rows can come back, never reuse
  ids, and don't keep counters that a returning row would contradict.
- Root never posts or deletes journal entries through the module: deleting a
  module record leaves the entries it posted in the books (the admin deletes
  those on the entry's page), so don't post a reversing entry on a root
  delete.
- `ctx.root.onCheck(fn)` is asked whenever root mode is about to be left,
  once per set of books. Report only what is truly broken (a record that
  can't work), not what is merely unusual.
- Mark root-only controls plainly (red, "Root") and show them only when
  `GET` data from the server says the user is in root mode; the server
  decides, not the page.

## Account codes can change

Since Ledger 0.19.3 a person can give an account a new code. Journal lines
are unaffected, and Ledger rewrites the old code to the new one where
modules keep it, in the same transaction:

- in a module's **tables**: text columns named `account_code`, or ending in
  `_account_code` or `_account` (`receivable_account`, `bank_account_code`);
- in a module's **settings**: text values under a key that contains
  `account` (`receivable_account`, `default_expense_account`).

So name them that way, and keep account codes nowhere else (not inside JSON
columns, not concatenated into other text, not in memory across requests).
For anything the convention can't reach:

```js
ctx.ledger.onAccountCodeChanged(({ old_code, new_code }) => { /* fix up what Ledger couldn't see */ });
```

## Documents (`ctx.documents`): the one file store

Every file of an organization is in one place: receipts, statements and
invoices that people import on the **Documents** page or that a module
brings in, PDFs made in Ledger (an invoice a module draws up, a report), and
since Ledger 0.27.0 any other file a module keeps: CSV, OFX and QFX
statements, saved emails, spreadsheets, exports. (Ledger 0.19.0 to 0.26
took PDFs and PNG/JPEG scans only.) Each has a kind (`receipt`,
`statement`, `invoice`, `other`), an origin (`imported` or `created`), an
optional date, customer or vendor (`entity_id`) and note. The files are
ordinary files on the data share, filed as
`<kind>s/<year>/<id>-<name>.<ext>`, and every backup carries them.

**Modules keep no files of their own (Ledger 0.27.0).** A file a module
takes in (uploaded in its page, fetched from mail, downloaded) is filed with
`add` and `origin: "imported"`; one it makes (an invoice, a report, an
export) with `origin: "created"`; one it needs is read from here. The
module's tables keep only the document's id. Ledger enforces it for modules
built for 0.27.0 (`"ledger": ">=0.27.0"`):

- a module whose schema has a binary (`bytea`) column is not started; the
  Modules page shows which columns. (A module that still holds bytes moves
  them in a version built for an older Ledger, whose code files each one
  with `ctx.documents.ensure`; the version built for 0.27.0 drops the column
  in a migration that refuses to run while any row still has bytes.)
- `ctx.storage.put` answers 410 (see "Files the module kept" below);
- the module checker fails on either, and warns about file writes outside
  `os.tmpdir()`.

An older module keeps working as before until it is updated, and Settings →
Modules says it "keeps files of its own".

```js
// Documents this module hasn't dealt with yet, newest first
const { data, total } = await ctx.documents.list({ kind: "receipt", unmarked: true });
// other filters: origin, source, year, entity_id, account_code ("none": without one), reconciled, tag, extracted,
//                content_type ("text/csv", "image/*"), q (words), limit (≤ 500), offset
// each: { id, kind, origin, source, title, filename, path, content_type, size_bytes, sha256,
//         doc_date, entity_id, entity_name, account_code, account_name, note, added_by, created_at, updated_at, url,
//         reconciled, marks, tags: [{ tag, note, module_id, set_by, set_at }],
//         extracted: null | { module_id, extracted_at, updated_at, keys, has_text, url } }

const doc = await ctx.documents.get(id);        // details (404 if none)
const bytes = await ctx.documents.read(id);     // Buffer
await ctx.documents.mark(id, "done", "posted as entry 412");  // or "skipped"; unmark(id) takes it back

// A file this module made (origin "created" by default; pass "imported" for one it fetched, e.g. from mail)
const made = await ctx.documents.add(
	{ kind: "invoice", filename: "INV-0031.pdf", data: pdfBuffer, title: "Invoice 31", doc_date: "2026-04-02", entity_id: customer.id },
	req.user,
);
// The same bytes twice answer 409 (err.document_id names the document); ensure() uses it instead:
const { document, added } = await ctx.documents.ensure({ kind: "statement", filename: "march.csv", data: csvBuffer, origin: "imported" }, req.user);
// Moving files the module already handled into the store (from its old storage): don't announce them to other modules
await ctx.documents.ensure({ kind: "other", filename, data, origin: "imported" }, null, { announce: false });
await ctx.documents.update(made.id, { note: "sent 3 April" });  // kind, title, doc_date, entity_id, account_code, note
await ctx.documents.remove(made.id);            // only documents this module added

ctx.documents.url(id);                          // for <a href> and <iframe> in the module's page (?download=1 downloads)
ctx.documents.onAdded((doc) => { /* a person or another module added one */ });
```

What a file is comes from its bytes for PDFs and pictures (PNG, JPEG, GIF,
WebP), otherwise from its name's extension, then from `content_type` when
`add` is given one, and is otherwise `application/octet-stream`. A name that
claims to be a PDF or a picture is never believed on its own. Files are at
most 100 MB (`ctx.documents.maxBytes`). At `url`, PDFs, pictures and plain
text or CSV open in the browser, sandboxed; everything else downloads, so a
stored HTML or SVG file can never run as a page of Ledger.

A bank or card statement belongs to its account (Ledger 0.19.1): pass
`account_code` to `add` or `update` when the module knows it, and ask for one
account's statements with `list({ kind: "statement", account_code })`.
Reconciling an account against a statement sets it too, and a statement of
one account can't be used to reconcile another. Once that reconciliation is
finished the statement reads `reconciled: true` (Ledger 0.19.4);
`list({ kind: "statement", reconciled: false })` gives the ones still to do.

`mark` is per module, so several modules can each work through the same
documents. In `onAdded`, only note or queue the document: what the module
makes of it is a suggestion a person approves, like everything else. A
document's file can be missing after a restore from an uploaded dump (`read`
answers 404): handle it.

### Tags on files

Ledger 0.27.0. Files have tags the way journal entries do ("Tags: one system
for every module" above), shared by Ledger and every module. A tag belongs
to the document: any module, or a person on the Documents page, can set it
or take it off, and everyone sees the same thing.

```js
await ctx.documents.tags.set(id, "posted", { note: "entry 412" }, req.user); // → the document's tags
await ctx.documents.tags.set(id, "paid");             // takes "overdue" off
await ctx.documents.tags.remove(id, "billed");
await ctx.documents.tags.of(id);                      // [{ tag, note, module_id, set_by, set_at }]
await ctx.documents.tags.setMany([4, 5, 6], "posted"); // all or none, at most 500: { documents, changed }
await ctx.documents.tags.removeMany([4, 5], "overdue");
ctx.documents.tags.onChange((c) => { /* { document_id, action: "set" | "removed", tag, module_id } */ });
const { data } = await ctx.documents.list({ tag: "overdue" });
```

The standard tags mean the same to every module: `extracted` (its data has
been read out, below), `posted` (an entry was posted from it; name the entry
in the note), `paid`, `billed` and `overdue`. Any other lowercase word is
allowed; pick ones another module could use. Who a file is with is the
document's `entity_id`, not a tag. A module that keeps a record for a file
(a bill, say) keeps it in line with the file's tags: listen with `onChange`
and skip changes whose `module_id` is its own.

### Extracted data: read a file once

Ledger 0.27.0. What is read out of a file (its fields, its lines, its plain
text) is kept by Ledger with the document, not in the table of whichever
module read it. A document that has it carries the tag `extracted`, and
`doc.extracted` says who read it, which keys there are and where it is. So
**before a module parses a file or sends it to the AI, it looks**:

```js
const x = await ctx.documents.extracted(id);
// null, or { document_id, data, text, module_id, extracted_by, extracted_at, updated_at, keys, has_text, url }
if (x?.data.transactions) return x.data.transactions;   // somebody read it already
const transactions = parse(await ctx.documents.read(id));
await ctx.documents.setExtracted(id, { data: { type: "statement", currency: "CAD", transactions } }, req.user);

await ctx.documents.clearExtracted(id);                 // forget it, so it is read again
await ctx.documents.list({ extracted: false });         // files nobody has read yet
```

`setExtracted` merges `data` into what is there, key by key (a key given as
`null` is removed; `replace: true` starts over), so a module that reads a
statement's transactions adds them to the account and period another module
found. `text` is the file's plain text. Limits: 2 MB of JSON, 5 million
characters of text. So that modules understand each other, use these keys
(all optional; money in integer cents, dates as `YYYY-MM-DD`):

| Key | |
|---|---|
| `type` | `"receipt"`, `"bill"`, `"invoice"`, `"statement"`, `"transactions"`, … |
| `vendor`, `customer`, `entity_id` | Who it is from or for (names as printed; the entity when known). |
| `number`, `date`, `due_date`, `currency` | |
| `subtotal_cents`, `tax_cents`, `total_cents` | |
| `items` | `[{ description, quantity, unit, rate_cents, amount_cents }]`, like rate items on entries. |
| `account` | `{ name, number_last4, account_code }` for a statement. |
| `period`, `opening_balance_cents`, `closing_balance_cents` | `period` is `{ from, to }`. |
| `transactions` | `[{ date, description, amount_cents, balance_cents? }]`, money out negative. |

Anything that is only the module's own goes under a key named after the
module. What a parser read (a CSV, an OFX file, a PDF's text) is saved
straight away; what the AI read is saved only after a person has approved
it, since AI output is a suggestion until then. The tag `extracted` can't be
set by hand: it is on the document exactly while there is an extraction, and
taking it off (a person can, on the Documents page) forgets the data so the
file is read again. A module's page reads it at `doc.extracted.url`.

## Mail (`ctx.mail`)

The server's shared mailbox, whatever kind it is (Ledger 0.18.3): the
IMAP/SMTP account an admin set up under **Settings → Mail** (Proton Mail
through Proton Mail Bridge, or any other mailbox) when there is one, else the
Gmail account under **Settings → Mail → Gmail**. **New modules use `ctx.mail`**, so
they work with either; `ctx.gmail` below stays for Gmail's own search syntax,
labels and threads. An admin allows each module to read and, separately, to
send.

```js
const s = await ctx.mail.status(); // { connected, kind: "imap" | "gmail" | null, account, canRead, canSend }

// Newest first; every field is optional. No mailbox-specific search syntax.
const { messages } = await ctx.mail.search({ from: "billing@", subject: "invoice", text: "amount due", since: "2026-03-01", before: "2026-04-01", max: 25 });
// messages: [{ id, date, from, to, subject, snippet }]   (snippet is "" over IMAP)

const m = await ctx.mail.message(messages[0].id); // { …summary, cc, text, html, attachments: [{ attachmentId, filename, mimeType, size }] }
const pdf = await ctx.mail.attachment(m.id, m.attachments[0].attachmentId); // Buffer
const raw = await ctx.mail.raw(m.id);              // Buffer: RFC 822 source

await ctx.mail.send({ to: "ann@example.com", subject: "Invoice 12", text: "…", attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", content: pdfBuffer }] }); // → { id }
```

Ids are opaque and belong to the mailbox in use: store them only to avoid
reading a message twice, and expect a 404 for one that is gone (an IMAP server
can renumber a folder). Reading never marks mail as read. Errors are
`HttpError`s: 409 not set up, 403 module not allowed, 404 no such message,
422 bad input, 502 the mail server failed; the messages say where to fix it.

## Gmail (`ctx.gmail`)

An admin connects one Gmail account under **Settings → Mail → Gmail** (Google
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
the books: a module that takes files in hands a bank statement to a module
that turns statements into entries, an email module hands bills to a
payables module. The file itself is a document (Ledger 0.27.0): a hand-off
names one (`document_id`), or brings bytes that Ledger files in Documents
first, and the row only points at it, so nothing is copied and what was
already read out of the file (`ctx.documents.extracted`) comes along.
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
const targets = ctx.files.targets("statement"); // running modules that take statements: [{ id, name, version, accepts }]
const sent = await ctx.files.send(
	{ to: "autosort", kind: "statement", document_id: doc.id, meta: { account_code: "1000" }, note: "October" },
	req.user, // records who sent it
);
// or with bytes, filed in Documents first: { to, kind, filename: "oct.csv", contentType: "text/csv", data: buffer, … }
const mine = await ctx.files.outbox({ status: "done" });
```

Receiving:

```js
ctx.files.onReceive((file) => queue.push(file.id)); // right after another module sends one
const waiting = await ctx.files.inbox({ status: "new" });
const file = await ctx.files.get(id); // summary plus data (a Buffer, read from the document)
const known = await ctx.documents.extracted(file.document_id); // what was already read out of it, if anything
await ctx.files.update(id, { status: "done", result: "12 transactions imported" });
```

A file's summary is `{ id, sender, recipient, kind, filename, content_type,
size_bytes, sha256, document_id, meta, note, status, result, sent_by,
created_at, updated_at }`. `status` starts as `new`; the recipient moves it to
`accepted`, `done` or `rejected` and may leave a `result` the sender can
show. The recipient can `remove(id)` a file at any time, the sender only
while it is still `new`; removing a hand-off leaves the document where it
is. Files are at most 100 MB; `meta` at most 16 KB of JSON. If the document
is deleted afterwards, `document_id` reads null and `get` answers 404. Sending to a module that isn't running or doesn't accept that kind
fails with 409. Settings → Modules shows what each module takes.

## Customers and vendors (`ctx.entities`)

Ledger 0.16.0 and later. Ledger keeps one list of entities per organization:
the people and businesses the books deal with, each a customer, a vendor, or
both. Every module shares it (and people manage it under Entities in the
sidebar), so use it instead of your own table of names and store only the
entity's `id`:

```js
const vendor = await ctx.entities.ensure("Hydro One", "vendor", { email: "bills@hydro.example" }); // found, given the role, or created
const customers = await ctx.entities.list({ role: "customer" });
await ctx.ledger.createJournalEntry({ entry_date, description, entity_id: vendor.id, lines }, req.user);
```

`list`, `get`, `find(name)`, `create`, `update` and `ensure` are described
in `docs/MODULE_LLM_CONTEXT.md`. Entities are made inactive, never deleted.
Accounts also carry a tag (`kind`: chequing, savings or credit card) so you
can offer bank and card accounts first. Since Ledger 0.30.0 the tag also
says which accounts are accounts receivable (`receivable`) and accounts
payable (`payable`): customers' invoices are posted to the first, vendors'
bills and receipts to the second, by Ledger and by every module, so use
the tagged account in the entry's currency when your own setting is empty.

Since Ledger 0.31.0 each customer has an account of their own under
accounts receivable and each vendor one under accounts payable, per
currency: `await ctx.entities.account(entityId, "customer" | "vendor",
currency)` returns it (an `Account`), making it the first time. Post a
customer's invoice and its payment there, a vendor's bill and its payment
there: the balance is what is owed, and every entity carries it as
`accounts: [{ role, code, currency, owed_cents }]`. Such an account has
`entity: { id, name, role }` and no `kind`. Ledger also routes for you: an
entry posted with `entity_id` and a line to the tagged receivable (a
customer's entry) or payable (a vendor's) account is posted to their own
account instead, so read the account codes back from the entry returned,
never assume the code you sent. The tags `customer` and `vendor` follow
the accounts: an entry with a line in a customer's or vendor's own account
reads as tagged with them (`ctx.tags.of` and `entries`, with
`account_code` set and `id` 0) without a tag being kept; setting the tag on
an entry with a line in receivables or payables moves that line to their
account, and taking it off moves it back. Only an entry with no such line
keeps the tag itself. `ctx.entities.payment(entityId, { role, account_code,
entry_date, amount_cents, description?, reference? }, user)` posts a bill
payment (`"vendor"`) or a customer's payment (`"customer"`) between a bank
or card account and their own account.

Since Ledger 0.33.0 a link between two entries can say that one is a
payment of the other: `await ctx.ledger.linkPayment(billEntryId,
paymentEntryId, { amount_cents?, note? }, user)` (and `unlinkPayment`,
`payments`). Neither entry changes. The entry paid shows its payments on
its page with what is paid and what is left, and Ledger keeps one of the
tags `unpaid`, `partially_paid` or `paid` on it, so modules don't work
that out themselves: tag a new bill or invoice `unpaid`, link each payment
as it is matched, and listen with `ctx.tags.onChange`.

Since Ledger 0.34.0 a module can open a reconciliation on Ledger's
Reconcile page: `const r = await ctx.reconcile.start({ account_code,
document_id, lines? }, user)`, then send the user to `r.href`. Use it for a
vendor's statement of account, against the vendor's own account
(`ctx.entities.account`): Ledger shows the statement beside the vendor's
bills and payments with the matching ones ticked, and what isn't ticked
stays in the vendor's account when the reconciliation is finished.

## Files the module kept (`ctx.storage`)

From Ledger 0.13.2 to 0.26 a module could keep files that weren't PDFs in a
folder of its own. **Since 0.27.0 it can't**: every file goes in Documents
(`ctx.documents`, above), whatever its type. For a module built for 0.27.0
or newer, `ctx.storage.put` answers 410; the rest stays so the module can
move what it stored before:

```js
for (const f of await ctx.storage.list("")) {            // { path, size, content_type, modified_at, url }
	const got = await ctx.storage.get(f.path);           // plus data (a Buffer); null if missing
	const { document } = await ctx.documents.ensure({ kind: "other", filename: f.path.split("/").at(-1), data: got.data, origin: "imported" });
	// ... put document.id where the row kept the path ...
	await ctx.storage.remove(f.path);
}
```

Do it in a background step at startup, inside `ctx.orgs.forEach`, a few
files at a time and safe to run again (a file already in Documents comes
back from `ensure` with `added: false`). Drop the path column in a later
migration, once nothing reads it. A module built for an older Ledger keeps a
working `put` until it is updated.

## Import from CSV (`ctx.imports`)

Ledger 0.13.2 and later. A module that keeps records people may have
elsewhere (customers, products, employees) declares what it can import, and
gets an **Import from CSV** card on its page under Settings → Modules:

```js
ctx.imports.provide({
	label: "Customers",
	description: "Contacts and opening balances.",
	fields: [
		{ key: "name", label: "Customer name", required: true },
		{ key: "email", label: "Email" },
		{ key: "balance", label: "Opening balance", type: "money" }, // text, number, money, date or boolean
		{ key: "since", label: "Customer since", type: "date" },
	],
	async handler(rows, { dryRun, user }) {
		const errors = rows.filter((r) => exists(r.name)).map((r) => ({ row: r._row, message: `${r.name} already exists` }));
		if (dryRun) return { summary: `Would add ${rows.length - errors.length} customers.`, errors };
		await addAll(rows);
		return { summary: `Added ${rows.length} customers.` };
	},
});
```

Ledger reads the file whatever its column names and order, matches the
columns to your fields by name or with the AI (if an LLM API is set up),
and converts values: money to integer cents, dates to `YYYY-MM-DD`,
booleans to `true`/`false`, empty cells to `null`. Each row has `_row`, its
line in the file. The user checks the matching, sees a preview and your
dry-run `summary` and `errors`, and only then presses Import; errors from the
dry run block it. Rows Ledger can't read are left out and listed.

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

Listeners run inside the organization where the thing happened
(`ctx.tags.onChange`, `ctx.documents.onAdded`,
`ctx.documents.tags.onChange`, `ctx.files.onReceive`,
`ctx.settings.onChange`, `ctx.ledger.onAccountCodeChanged`): `ctx.db` and
the rest already point at that organization's books. Don't wrap a listener's
work in `ctx.orgs.forEach`: entry and document ids are per organization, so
the same id elsewhere is a different record.

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
| `type` | `text` (one line, 500 chars), `textarea` (10,000), `secret` (2,000; never shown again after saving), `number` (`min`/`max`), `boolean`, `select` (`options`: strings or `{ "value", "label" }`), `account`, `heading`. Default `text`. |
| `account` type | Ledger 0.19.8. A picker of the organization's accounts; the value is the account's code. `currency` (`"CAD"`) and `account_types` (`["asset", "liability"]`) narrow what is offered, and a newly chosen account must match them. Use it for every account a module asks for, with a key containing `account`. |
| `heading` type | Ledger 0.19.8. A title (`label`, optional `help`) between groups of fields. It holds no value. |
| `show_if` | Ledger 0.19.8. `{ "key": "<another field>", "equals": value }` or `{ "key", "in": [values] }`: the field (or heading) shows only while that field has one of the values. A hidden `required` field isn't asked for, and keeps what was saved. |
| `label`, `help` | Shown in the form (60 / 300 characters). |
| `required` | The form can't be saved without a value. |
| `default` | Used until the user sets a value (not for secrets). |

`page` (optional) is a file in the module's `ui` directory, shown in a frame
below the form, for settings a simple form can't express (e.g. connecting an
account). At most 50 fields.

**Tabs** (Ledger 0.19.6). A module with many settings splits its settings
page into tabs of its own:

```json
"settings": {
  "tabs": [
    { "id": "general", "label": "General" },
    { "id": "accounts", "label": "Accounts", "help": "Where invoices and payments are posted." },
    { "id": "templates", "label": "Templates", "page": "settings-templates.html" }
  ],
  "fields": [
    { "key": "company_name", "label": "Company name" },
    { "key": "receivable_account", "label": "Receivables account", "tab": "accounts", "default": "1200" }
  ]
}
```

| Tab member | |
|---|---|
| `id` | Lowercase letters, digits and `-`, up to 32, starting with a letter. Fields name it in `"tab"`. |
| `label`, `help` | The tab's name (40 characters) and a line shown under the tabs (300). |
| `page` | Optional file in the module's `ui` directory shown on the tab, below its fields if it has any. |

Ledger lays the fields out two or three across where there is room (long
text, tick boxes and headings take the whole width), sizes a tab's `page`
to its content, and puts a module's "Import from CSV" on a tab of its own
after the module's tabs (0.19.8). Keep labels short ("Receivables", not
"Receivable account code (CAD)") and let a heading or the tab carry the
context.

A field without `"tab"` goes on the first tab. Each tab saves its own
fields; the others keep their values. A tab must have at least one field or
a page. Up to 12 tabs; with one tab or none, no tab strip is shown. The open
tab is in the address (`?tab=accounts`), so a module's page can link
straight to it: `/settings/m/<id>?tab=accounts` (open it in the top window:
`<a target="_top">`).

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
- Ledger draws a window around the page: a rounded panel with a small gap
  around it (and between panes side by side). Fill the frame; don't draw an
  outer border or frame of your own.
- **Resizable columns and fields** (Ledger 0.24.0): Ledger adds
  `<script src="/ledger-ui.js" defer>` to every HTML page it serves from
  `ui/`. Users drag the right edge of a column heading (`th`), text field,
  number box or dropdown to resize it, and double-click it to put it back;
  sizes are remembered in the browser, per page. Lists as `<table>` with
  `<th>` and fields as `<input>`/`<select>` get this for free. Put
  `data-no-resize` on an element to leave it (and everything in it) alone.
- **Forms filled in from an entry's rate items** (same script): put
  `data-ledger-entry="<journal entry id>"` on a form and
  `data-ledger-fill="…"` on its fields: `description` (the item's, or the
  entry's when it has none), `quantity`, `unit`, `rate` (e.g. "80.00"),
  `rate_cents`, `amount` (quantity × rate, "600.00"), `amount_cents` or
  `date` (the entry's). Fields take the first item, or item n (0, 1, 2…)
  when inside an element with `data-ledger-item="n"`, e.g. one invoice
  line per item. Empty fields are filled, with `input` and `change`
  events, when the attribute is set or changes (`data-ledger-overwrite` on
  a field replaces what is there). The form also gets a `ledger-rate`
  event whose `detail` is the first item or null, and a `ledger-items`
  event with all of them; `await LedgerUI.rateOf(entryId)` returns the
  first and `await LedgerUI.itemsOf(entryId)` all of them.

```html
<form data-ledger-entry="123">  <!-- set it when the user picks the entry to invoice -->
	<input name="what" data-ledger-fill="description">
	<input name="qty" data-ledger-fill="quantity">
	<input name="unit" data-ledger-fill="unit">
	<input name="price" data-ledger-fill="rate">
	<input name="total" data-ledger-fill="amount">
</form>
```
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

Since Ledger 0.14.0 every organization backs up and restores its own books.
A restore replaces your tables and the organization's documents with the
backup's (from an uploaded dump file, 0.14.2: only the tables), while the
module's settings stay as they are (they have their own rolling backup,
`settings-…/settings.json`, restored separately) and so do the server's
users. After a restore your rows may therefore be older than your settings
and than anything outside the database, and a stored file a row points to
may be missing: check rather than assume, and keep no in-memory state that
must match the database (Ledger restarts after a restore).

Your tables are in Ledger's database dump, and since Ledger 0.13.0 each
backup also saves them as CSV files in its folder, next to the dump
(`<module>[-<table>].csv` in each backup's folder) for people to open in a
spreadsheet. Give tables and columns names a person understands, and keep
secrets out of tables: put them in `secret` settings fields. Keep files out
of tables too: since Ledger 0.27.0 a module with a binary (`bytea`) column
is not started; files go in Documents and the table holds the document's id.

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
