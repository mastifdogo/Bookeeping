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

## Push to `main` without asking

**When work on a module is finished and its checks pass, commit and push it
to `main` of that module's own repository straight away. Do not ask "shall I
push?", do not wait for a go-ahead, do not leave it on a branch, and do not
open a pull request.** The owner of these modules has asked for this as a
standing rule: every finished change to a module goes to `main`, where the
release workflow publishes the new version. Asking first is the mistake.

- This applies to every kind of work on a module: a new feature, a fix, an
  update for a new Ledger version, a docs or settings change.
- Bump `version` in `ledger-module.json` in the same push, so it releases.
- After pushing, say what was pushed and the new version. Don't ask
  afterwards either ("want me to release it?"): it is already released.
- If your environment gives you a different work branch, push there as it
  requires and then to `main` as well.

The only reasons not to push:

- the checks fail, or you couldn't run them and the change is risky: fix it
  or say what is blocking;
- the user said, in this conversation, not to push;
- the repository isn't the module's own (never push to Ledger's repository
  while working on a module: see below);
- the module has no repository yet: creating one is the user's to do or to
  name; once it exists, push without asking.

## When the skill is invoked with no instruction

If the user just tags or runs this skill and says nothing else, the job is:
**bring this module up to date with the current Ledger and push it.**

1. Work on the module in the repository you are in (the one with
   `ledger-module.json`). If you are not in a module's repository, ask
   which module.
2. Get the current Ledger and read its module API (below), then compare the
   module against it and against the rules in this skill: newer `ctx`
   features it should use (for example the shared entity list instead of
   its own customer or vendor table, account tags, sub-accounts,
   `ctx.imports`, and the one file store `ctx.documents` for every file the
   module receives, makes or keeps, with file tags and extracted data),
   things Ledger now does differently, and anything the checker reports.
3. Make those changes, raise `"ledger"` in the manifest to the oldest
   Ledger version that has everything the module now uses, and bump the
   module's `version` (a new feature raises the middle number, a fix or
   small tweak the last).
4. Run the checks (below). Don't push anything that fails them.
5. Commit and **push to `main` of that module's repository, without
   asking first**. Its release workflow tags and publishes the new version
   by itself.
6. Say what changed, the new version, and anything you chose not to change
   and why. If nothing needed changing, say so and push nothing.

Changes that alter or move the user's data (a migration that moves
customers into the shared entity list, for example) still need the user's
approval inside the module, as always.

## 1. Learn the current API first

Read **`docs/MODULE_LLM_CONTEXT.md`** in full before writing anything. It is
the authoritative, compact reference: manifest fields, the `ctx` API and its
return shapes, `ctx.dashboard`, `ctx.settings`, `ctx.documents`, `ctx.files`, `ctx.imports`, `ctx.entities`, `ctx.orgs`,
migrations, the UI contract, security rules and the release checklist. `docs/MODULES.md` has the longer
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
  undo with `reverseJournalEntry`. Link every entry to the record it came
  from (`links: [{ ref, label, href }]` on `createJournalEntry`, or
  `ctx.ledger.linkJournalEntry`; Ledger 0.11.2) so people can jump from the
  journal to the invoice or bank line, and find a record's entries with
  `ctx.ledger.linkedEntries(ref)`. Account codes the module uses are
  **settings** (e.g. `receivable_account`, default `1200`), never hard-coded.
- **Linked entries** (Ledger 0.28.0; needs `"ledger": ">=0.28.0"`): an
  entry's page lists every entry linked to it, with date, amount and tags.
  Entries linked to the same record (the same `ref`: an invoice's entry and
  each of its payments on `invoice:31`) show with each other already, and so
  do reversals. For entries that belong together without a record in common
  (a payment and the bill another module posted, a transfer's two halves, a
  refund and its sale), link the two:
  `await ctx.ledger.relateEntries(entryId, otherId, { note }, req.user)`,
  `ctx.ledger.unrelateEntries(entryId, otherId)`,
  `ctx.ledger.relatedEntries(entryId)` → `[{ id, entry_date, description,
  totals, tags, reversed, direct, why: [{ kind: "linked" | "chain" |
  "record" | "reverses" | "reversed_by", note, module_id, label, href,
  through }] }]` (also `related` on `getJournalEntry`). A link belongs to
  the entries, so a person or another module can take it off; it says the
  entries belong together, nothing more (paid and billed stay tags).
- **Settings**: everything the user configures (API keys as `secret`
  fields, account codes, options) goes in the manifest's `settings.fields`.
  Ledger renders the form on the module's Settings tab. A module with many
  settings, or distinct groups of them, splits that page into tabs of its
  own with `settings.tabs` (Ledger 0.19.6): each field names its tab
  (`"tab": "accounts"`), and a tab can show a page from `ui/` (`"page"`)
  for what a form can't do. Don't build a tab strip of your own inside a
  settings page. Values are per
  organization (Ledger 0.11.1): read them with `ctx.settings.get()` where
  they're used, never cache one copy for the whole server.
- **Dashboard**: what deserves a notification or a to-do (`ctx.dashboard`).
- **AI, Gmail, search**: AI goes through `ctx.llm` (the admin's LLM
  connections, never the module's own key), mail through `ctx.mail` (Ledger 0.18.3: whichever mailbox the admin
  connected, Proton Mail Bridge or another IMAP/SMTP account, else Gmail;
  use `ctx.gmail` only for Gmail-only features; never
  your own OAuth/IMAP), and records worth finding through
  `ctx.search.provide`. These need Ledger 0.10.0, and the admin must allow
  the module under Settings → LLM API / Mail: say so in the README and show
  `ctx.llm.status()` / `ctx.mail.status()` in the UI when it isn't allowed
  yet. Pictures (receipts, photos) go in `images: [{ media_type, data }]`
  (Ledger 0.11.2): they reach the connection set up for images, which may be
  a different model than the one for text; check `status().images.configured`.
- **Clearing accounts** (Ledger 0.20.0): when the two sides of something
  are posted at different times or by different modules (a sale and its
  payout, wages accrued and paid, a transfer in transit), post through the
  module's own clearing account: `await ctx.ledger.clearingAccount({ key,
  name, currency })` returns it (made on first use). Call it each time and
  use the code it returns; never store the code or create the account with a
  hard-coded one. Each entry still balances, and whatever goes in must have
  something that clears it: the Accounts page shows clearing accounts that
  aren't at zero. Other modules' are in `ctx.ledger.clearingAccounts()`.
  Since Ledger 0.20.1 clearing accounts are hidden from the Accounts page
  and account dropdowns unless a person shows them (Settings → Clearing
  accounts; `hidden` on the account), so a module's own pickers should
  leave hidden accounts out too, and its settings shouldn't ask a person to
  pick its clearing account. Ledger's own Unreconciled account has
  `module_id` "ledger" (a reserved module id): never post to it.
- **A tidy settings page** (Ledger 0.19.8): every account the module asks
  for is a `"type": "account"` field (a picker; add `currency` and
  `account_types`), never a text box for a code. Group fields with
  `"type": "heading"` fields and tabs, and hide what doesn't apply with
  `show_if` (mail-server details only when "own server" is chosen, accounts
  only when posting is on). Labels are two or three words; the heading or
  tab says what they are for. No repeated help under every field.
- **Entry amounts can change** (Ledger 0.19.5): a person can correct the
  amounts of a posted entry (logged; the entry reads `amended: true`). Don't
  assume an entry the module posted still has the amounts it posted: read
  them from the entry (`ctx.ledger.linkedEntries(ref)`), and show any
  difference from the module's own record instead of overwriting either.
  Since 0.20.2 an entry's date can change too (`date_changes`), and a
  finished reconciliation moves a bank account's unticked lines to Ledger's
  Unreconciled clearing account until a person moves them on (`moves`).
- **One tag system for every module** (Ledger 0.23.0; needs
  `"ledger": ">=0.23.0"`). Whether an entry is paid, billed or overdue, and
  which customer or vendor it is with, is said with Ledger's shared tags,
  never only in the module's own tables and never with entry links:
  `ctx.tags.set(entryId, "billed")`, `ctx.tags.set(entryId, "customer",
  { entity_id })`, `ctx.tags.set(entryId, "paid")` (takes "overdue" off),
  `ctx.tags.remove`, `ctx.tags.of(entryId)`, `ctx.tags.entries({ tag,
  entity_id })`. Tag the entry when posting it (who it is with, billed) and
  keep it true (paid, overdue). A tag belongs to the entry: another module
  or a person can set or remove it, so register `ctx.tags.onChange` (skip
  changes whose `module_id` is `ctx.id`) and bring the module's own record
  in line, e.g. an invoice whose entry gets "paid" becomes paid. Other tags
  are lowercase words; choose ones another module could use. Details:
  docs/MODULES.md, "Tags".
- **Items: description, quantity and rate, shared** (Ledger 0.25.0;
  `"ledger": ">=0.25.0"`): anything counted (hours, km, litres, items) is
  tagged with the standard tag `rate`, one tag per item and as many as the
  entry needs: `ctx.tags.addRate(entryId, { description, quantity, unit,
  rate_cents })`, changed with `setRate(entryId, { id, ... })`, read back
  with `ctx.tags.rates(entryId)` → `[{ id, description, quantity, unit,
  rate_cents, amount_cents }]` (`rate(entryId)`: the first or null),
  removed with `removeRate(entryId, id)`. Forms that start from an entry
  fill their lines in from them rather than asking again (in the page:
  `data-ledger-entry` on the form, `data-ledger-fill` on fields,
  `data-ledger-item="n"` per line). Tag many
  entries at once with `ctx.tags.setMany` / `removeMany`.
- **Root mode** (Ledger 0.21.0, wider in 0.21.1): an admin in root mode
  can delete any account, entry, line or user and move a line to any
  account; entries may be unbalanced until root mode is left, and anything
  can be reversed later (same ids come back). Treat a missing account,
  entry or user as gone for now; don't fail or delete the module's own
  records because of it.
- **Root can do the same to the module's records** (Ledger 0.21.1; needs
  `"ledger": ">=0.21.1"`). When `req.user.root` is true, let the admin
  delete or change any record of the module, including ones the module
  normally protects (sent, paid, posted). Do it only through
  `ctx.root.remove(req, table, id, summary)` and
  `ctx.root.update(req, table, id, { column: value }, summary)`, never with
  the module's own DELETE or UPDATE: Ledger keeps the row, logs it under
  Settings → Root log and puts it back when the action or the whole root
  session is reversed. Remove rows that hang off a row first (cascaded rows
  are not kept). Don't post or reverse journal entries on a root delete.
  Register `ctx.root.onCheck(async () => [...])` returning plain sentences
  for records that are truly broken (root mode can't be left until it
  returns `[]`). Show root controls only when the server says the user is
  in root mode, marked "Root" in red. Details: docs/MODULES.md, "Root mode".
- **Account codes can change** (Ledger 0.19.3): people can renumber
  accounts. Ledger rewrites the old code in a module's tables and settings
  only where it can recognise one: text columns named `account_code`,
  `*_account_code` or `*_account`, and text settings whose key contains
  `account`. Name them that way; never keep a code inside JSON, joined into
  other text, or cached in memory; use
  `ctx.ledger.onAccountCodeChanged(({ old_code, new_code }) => …)` for
  anything else.
- **One file store: every file goes in Documents, `ctx.documents`. Always.**
  (Any file type since Ledger 0.27.0; needs `"ledger": ">=0.27.0"`.)
  **A module keeps no files of its own**: not in its tables (`bytea`
  columns), not in a folder of its own (`ctx.storage`), not on disk. Ledger
  refuses it: a module built for 0.27.0 with a binary column is not started,
  `ctx.storage.put` answers 410, and the checker fails on both.
  - A file the module **receives** (uploaded in its page, fetched from mail,
    downloaded from a bank or supplier; a PDF, a scan, a CSV/OFX/QFX
    statement, a saved email, a spreadsheet): `ctx.documents.add({ kind,
    filename, data, origin: "imported", ... }, req.user)`.
  - A file the module **makes** (an invoice, a statement of account, a
    report, a CSV export): `ctx.documents.add({ ..., origin: "created" },
    req.user)`.
  - A file the module **needs**: take it from the store with `list({ kind,
    unmarked: true })` and `read(id)`, then `mark(id)` when done. Link to it
    in the module's page with `ctx.documents.url(id)`.
  Keep only the document's `id` in the module's tables. If the module offers
  an upload, it files the bytes with `add` and works from the returned id
  (an upload that arrives in pieces may be assembled in a temporary file
  under `os.tmpdir()`, deleted once filed). The same bytes twice answer 409
  with `err.document_id`; `ctx.documents.ensure(...)` → `{ document, added }`
  uses the document already there. A statement carries its bank or card
  account (`account_code`): set it when the module knows it, filter by it,
  never guess it; `list({ kind: "statement", reconciled: false })` gives
  statements still to reconcile. An older module that keeps files elsewhere
  is moved over: a startup step (per organization, a few at a time, safe to
  run again) files each one with `ensure`, stores the id, removes the old
  copy; a later migration drops the old column.
- **Tags on files, shared by every module** (Ledger 0.27.0): what a file is,
  for every module to see, is said with `ctx.documents.tags`, the same shape
  as the tags on entries: `tags.set(id, "posted", { note: "entry 12" },
  req.user)`, `"paid"` (takes `"overdue"` off), `"billed"`, `tags.remove`,
  `tags.of(id)`, `tags.setMany` / `removeMany`, `list({ tag })`, and
  `tags.onChange` (skip changes whose `module_id` is `ctx.id`) to keep the
  module's own record in line. Other tags are lowercase words another module
  could use. Who a file is with is the document's `entity_id`.
- **Read a file once: the tag `extracted`** (Ledger 0.27.0). What is read
  out of a file is kept by Ledger with the document, for every module.
  Before parsing a file or sending it to the AI, check
  `ctx.documents.extracted(id)` (or `doc.extracted`, or `list({ extracted:
  false })` for files nobody has read) and use what is there. After reading,
  save it: `ctx.documents.setExtracted(id, { data, text? }, req.user)`, which
  merges `data` key by key and tags the document `extracted`. Use the shared
  keys (`type`, `vendor`, `customer`, `entity_id`, `number`, `date`,
  `due_date`, `currency`, `subtotal_cents`, `tax_cents`, `total_cents`,
  `items`, `account`, `period`, `opening_balance_cents`,
  `closing_balance_cents`, `transactions`; cents and `YYYY-MM-DD`), and put
  anything only the module understands under a key named after the module.
  A parser's result is saved at once; an AI's only after a person approved
  it. Never keep the only copy of extracted data in the module's own table.
- **No provider in particular**: the admin can put any LLM provider behind
  `ctx.llm` (Ledger 0.18.2: Anthropic, OpenAI, Gemini, OpenRouter, Mistral,
  Groq, Ollama, any OpenAI-compatible server). Never branch on
  `status().provider` or a model name, and keep provider and model names out
  of prompts, UI text and READMEs ("the AI", not a brand). Go by
  `status().configured`, `images.configured` and `readsPdf`; when `readsPdf`
  is false, PDFs in `documents` aren't sent, so put their text in the
  prompt. Validate what `json()` returns: not every server enforces the
  schema.
- **AI only proposes; a person approves**: anything an LLM decides
  (`ctx.llm` output) must be approved by a human before it takes effect:
  posting or reversing entries, sending mail, changing or deleting records,
  marking files done, calling outside services. Save the AI's result as a
  pending suggestion (in the module's own table, with what it would do and
  why), show it in the UI, and act only when a user with the right role
  approves it (a POST from the UI, attributed with `req.user`); let them edit
  or reject it. A dashboard to-do ("5 suggestions to review") is a good
  pointer. Never act on AI output from a background job or `onReceive`
  without that approval, and never offer an "auto-approve" setting.
- **Files from other modules**: statements, bills, receipts or transaction
  lists another module produces arrive through `ctx.files`, never by
  reading another module's schema. A hand-off is a document (Ledger 0.27.0):
  send `{ to, kind, document_id }` (or `data`, which Ledger files first) and
  read `summary.document_id` on the receiving side, with what was already
  extracted from it. A module that takes
  them declares `"files": {"accepts": [...]}` in its manifest and handles
  `ctx.files.onReceive` / `inbox()`, then marks each file `done` or
  `rejected` with a `result`; a module that produces them offers "send to …"
  from `ctx.files.targets(kind)`. Needs Ledger 0.11.0. A module that keeps
  customers or vendors accepts `customer` / `vendor` lists (Ledger 0.12.0):
  Ledger's migration from other software sends them there, and the module
  shows what it would add for the user to approve.
- **Customers and vendors** live in Ledger's shared entity list
  (`ctx.entities`, Ledger 0.16.0), not in a names table of the module's
  own: an entity is a customer, a vendor, or both, and every module and
  Ledger itself (the vendor on an expense) use the same one. Keep only the
  entity's `id` in the module's tables, plus what is the module's own
  (payment terms, a tax number). Use `ctx.entities.ensure(name, "vendor")`
  to find or add one, `list({ role })` for pickers, and pass `entity_id`
  when posting an entry so it shows who it is with. A module that already
  has its own customers or vendors table moves them across in a migration
  step the user approves, matching by name. Entities are made inactive,
  never deleted. Lists handed between modules use the file kind `entity`
  (a `role` column says customer, vendor or both).
- **Accounts**: `Account.kind` (Ledger 0.16.0) tags bank and card accounts
  (`chequing`, `savings`, `credit_card`): list tagged accounts first
  wherever the user picks where money came from or went. Since Ledger
  0.30.0 `kind` is also `receivable` (accounts receivable) or `payable`
  (accounts payable): a customer's invoice is posted to the receivable
  account and a vendor's bill or receipt to the payable account in its
  currency. Keep the module's account setting, but when it is empty use the
  tagged account, and work without one on an older Ledger. Since Ledger
  0.31.0 each customer has an account of their own under accounts
  receivable and each vendor one under accounts payable, per currency
  (`await ctx.entities.account(entityId, "customer" | "vendor", currency)`,
  made the first time; such an account has `entity: { id, name, role }`
  and no `kind`): post an invoice or a bill and its payment there, or post
  to the tagged account with `entity_id` and Ledger routes the line there
  (read the code back from the returned entry). What is owed is that
  account's balance (`entity.accounts[].owed_cents`). Don't tag such
  entries `customer` or `vendor`: the account says whose they are, and
  `ctx.tags.of` still returns them as tagged. Leave these accounts out of
  pickers for a sale's or a cost's account and for bank accounts. When a
  payment is matched to a bill or an invoice (Ledger ≥ 0.33.0), change
  neither entry: `await ctx.ledger.linkPayment(billEntryId, paymentEntryId,
  { amount_cents?, note? }, req.user)`. Ledger shows the payment on the
  entry's page with what is paid and what is left, and keeps one of the
  tags `unpaid`, `partially_paid` or `paid` on the entry paid; tag a new
  bill or invoice `unpaid` and leave the other two to Ledger. Accounts can be
  **sub-accounts** (Ledger 0.15.0): `parent_code` is the parent,
  `balance_cents` the account's own postings, `total_balance_cents` adds
  everything below it. Show account pickers and lists as a tree (indent
  sub-accounts under their parent) and use a parent's
  `total_balance_cents` for group totals; post to whichever account the
  user picks, parent or sub-account.
- **Organizations**: each organization's books (and the module's schema) are
  a separate database, and requests already run in the user's current one.
  Don't add organization columns. Background jobs that touch the books loop
  with `ctx.orgs.forEach` (Ledger 0.11.0); otherwise they only see the main
  books.
- **Roles**: `req.user.role` is `admin`, `bookkeeper` or `viewer` in the
  request's organization. Ledger blocks viewers from non-GET routes;
  restrict module setup to admins yourself.
- **UI**: one self-contained `ui/index.html` (plain HTML/CSS/JS, light and
  dark mode, works from ~260px wide). Every account dropdown (categorizing
  transactions, picking accounts) ends with "+ New account…", which asks
  Ledger to open its New account dialog over the page with the
  `ledger-new-account` message (Ledger 0.11.3; snippet in the context file)
  and then selects the account it created, so nothing the user filled in is
  lost. Ledger draws the window frame around the page, so no outer border
  or frame of its own. Ledger injects `/ledger-ui.js` into the page
  (0.24.0): lists as real `<table>`/`<th>` and fields as `<input>`/
  `<select>` get resizable columns and fields for free (`data-no-resize`
  opts an element out), and forms marked `data-ledger-entry` /
  `data-ledger-fill` fill themselves in from the entry's rate tag.
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
- Ledger runs in a **Debian 13** container with PostgreSQL 18 (Ledger
  0.18.0; its releases ship only a Debian 13 LXC template). Write for that
  only: Debian 12 is deprecated and Ubuntu isn't built or supported, so
  don't add workarounds for either. Don't call
  programs that aren't in it (no `spawn` of tools you'd have to
  `apt install`), and don't depend on Ubuntu-specific paths or packages.
- Backups save every table of the module's schema as a CSV in each backup's folder (next to `ledger.dump`)
  (Ledger 0.13.0): name tables and columns so a person reading the CSV
  understands them, and never keep secrets in tables (use `secret` settings).
  No files in tables either: no `bytea` columns (Ledger 0.27.0 doesn't start
  a module that has one). Every file is in Documents (`ctx.documents`, as
  above), on the share per organization and in every backup.
- **Restores** (Ledger 0.14.0): each organization backs up and restores its
  own books. A restore replaces the module's tables and the organization's
  documents with the backup's (a restore from an uploaded dump file, 0.14.2,
  replaces only the tables, so a document's file can be missing), but keeps
  the module's current settings, which
  are backed up and restored separately, and the server's users. So after a
  restore, rows may be older than the settings and than files or state
  outside the database: never assume a stored file, a setting or an
  external record (a sent email, a remote id) matches the tables; check and
  handle a missing one. Keep nothing in memory across requests that must
  match the database (Ledger restarts after a restore), and refer to users
  by `req.user` ids, which a restore never changes.
- **Import from CSV**: a module that keeps records people have elsewhere
  (customers, products, employees) declares its fields with
  `ctx.imports.provide({ label, fields, handler })` (Ledger 0.13.2). Ledger
  adds an Import card on the module's Settings page, matches the file's
  columns (by name or with the AI), converts values (money → cents, dates
  → YYYY-MM-DD) and calls `handler(rows, { dryRun: true })` for a preview;
  only after the user presses Import does it call it with `dryRun: false`.
  The dry run must change nothing; its `errors` block the import.
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
imports, migrations and the UI, the one-file-store rules (no
`ctx.storage.put`, no `bytea` column left after the migrations, a warning
for a manifest older than 0.27.0), then creates a scratch database with
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

## 6. Publish: push to `main`, without asking

Pushing is part of finishing the work (see "Push to `main` without asking"
at the top): once the checks pass, push the module to `main` of its own
repository and don't ask first. Creating a new repository is the one thing
to settle with the user: use the repository they name.

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on a module.** Push only to the module's own repository. If the
module needs a change in Ledger (a bug fix, a new `ctx` feature, a docs or
checker fix), make it locally, tell the user what it is and why, and leave
pushing it to them. Build the module so it works without that change.

Every module repository has the release workflow
**`.github/workflows/release.yml`** (in the template, so new modules get it;
copy `template/.github/workflows/release.yml` into older modules that lack
it). On every push to `main` that changes `ledger-module.json`, it reads
`version` and, if there is no GitHub Release `v<version>` yet, creates the
tag on that commit and the Release (with notes generated from the commits),
using GitHub's built-in token: no secrets to set up. It does nothing when the
version is already released, and fails on a version that isn't `x.y.z`.

1. In `<dir>`: `git init -b main`, commit (including the workflow), add the
   remote, push `main`. The first push releases the manifest's version.
2. Release: bump `version` in `ledger-module.json` (`x.y.z`, by the rule
   below), commit, push `main`. **Don't create tags or Releases by hand**;
   the workflow does it. Check the run under the repository's Actions tab
   (or `gh run list --workflow release.yml`). If it fails with "Resource not
   accessible by integration", the user must allow it once: repository
   Settings → Actions → General → Workflow permissions → "Read and write
   permissions". To re-run it without a change: Actions → Release → Run
   workflow.
3. Tell the user to install it: **Settings → Modules**, enter `owner/repo`.
   Updates install on Ledger's update schedule, with "Update modules now",
   or when the server starts if "Update when the server starts" is on
   (Settings → Updates, Ledger 0.12.1). After releasing, tell the user which
   of these will pick it up; "Update modules now" is the quickest.

Updating a published module: change code, add a new migration if the data
model changes, bump the version, run the checks, release again.

**Version numbers** (`x.y.z`, for modules and for Ledger itself):

- New features (a new page, route, setting, `ctx` capability, data the module
  keeps): raise the middle number and reset the last, e.g. `1.4.2` → `1.5.0`.
- Small tweaks and bug fixes only: raise the last number, e.g. `1.4.2` →
  `1.4.3`.
- A release that has both counts as a feature release.

## 7. When Ledger's module API changes

If you change what modules can do (`backend/src/module-host.ts`,
`backend/src/modules.ts`, `backend/src/module-settings.ts`), update in the
same change: `docs/MODULE_LLM_CONTEXT.md`, `docs/MODULES.md`, this skill
(its template and `check-module.ts` if they're affected) and the test
fixture `backend/test/fixtures/hello-module/` if the tests should cover it. Note the Ledger version that introduces the
feature (the next release after the latest tag). As in §6, don't push
these changes yourself as part of module work; hand them to the user.
