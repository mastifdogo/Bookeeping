Fully vibe coded local bookkeeping software

# Bookeeping

Lightweight double-entry accounting web app, sized for a low-resource Proxmox LXC container.

| Layer    | Tech                                                             |
|----------|------------------------------------------------------------------|
| Backend  | Node.js 24 (TypeScript), `node:http`, `pg`, bundled to one file  |
| Database | PostgreSQL 13+                                                   |
| Frontend | SvelteKit 3 SPA (`adapter-static`), served by the backend        |
| Files    | CSV import/export in `/app/csv_data` (TrueNAS bind mount)        |
| Contract | [`api/openapi.yaml`](api/openapi.yaml)                           |

## Installation

### On Proxmox (one command)

`deploy/proxmox-deploy.sh` runs on the **Proxmox host** as root. It creates the
LXC container and installs everything inside it.

1. Download `ledger-<version>-linux-amd64.tar.gz` from a
   [GitHub Release](https://github.com/mastifdogo/Bookeeping/releases), or build
   one on a machine with Node.js 22.18+:

   ```sh
   make release        # dist/ledger-<version>-linux-amd64.tar.gz  (ARCH=arm64 for ARM)
   ```

   The tarball includes the Node.js runtime, so nothing else needs installing.

2. Copy the tarball to the Proxmox host, unpack it and run the script, pointing
   `--csv-path` at a directory on your TrueNAS mount:

   ```sh
   scp dist/ledger-*-linux-amd64.tar.gz root@proxmox:/root/
   ssh root@proxmox
   tar xzf ledger-*-linux-amd64.tar.gz && cd ledger-*-linux-amd64
   ./deploy/proxmox-deploy.sh --csv-path /mnt/pve/truenas/ledger
   ```

3. Open the URL it prints and log in with the admin username and the generated
   password (shown once; change it under **Settings**).

The script will:

- download the latest Debian 13 template if needed
- create an unprivileged container (`nesting=1`) with the CSV directory
  bind-mounted at `/app/csv_data`, owned by the mapped service UID (100990)
- install PostgreSQL (tuned for a small container), Ledger, the systemd service
  and nightly backups to `/app/csv_data/backups` (change them under Settings → Backups)
- create the database with a restricted app role, plus the admin user
- start everything and check `/api/v1/health` and that the share is writable

Common options (`--help` lists them all):

| Option | Purpose | Default |
|--------|---------|---------|
| `--csv-path DIR` | host directory to bind-mount (required) | — |
| `--ctid ID` | container ID | next free |
| `--hostname NAME` | container hostname | `ledger` |
| `--ip CIDR --gateway IP` | static address, e.g. `192.168.1.50/24` | DHCP |
| `--vlan TAG`, `--bridge NAME`, `--nameserver IP` | network | `vmbr0` |
| `--cores N --memory MB --disk GB --storage NAME` | sizing | 1, 512, 4, `local-lvm` |
| `--port N` | web port | `8080` |
| `--admin-user NAME` | first login user | `admin` |
| `--admin-password-file FILE` | use this password instead of generating one | generated |
| `--ssh-keys FILE` | authorized_keys for root in the container | none |
| `--no-chown` | leave CSV directory ownership alone (TrueNAS NFS "Mapall") | chown |
| `--release FILE` | release tarball to install | the unpacked release |
| `--dry-run` | print every command without running it | off |
| `-y` | don't ask for confirmation | ask |

Example with a static address:

```sh
./deploy/proxmox-deploy.sh --csv-path /mnt/pve/truenas/ledger \
  --ctid 120 --ip 192.168.1.50/24 --gateway 192.168.1.1 --admin-user alice
```

**Upgrading** to a new release backs up the database first, then keeps the
configuration and port:

```sh
./deploy/proxmox-deploy.sh --upgrade --ctid 120 --release ledger-<new>-linux-amd64.tar.gz
```

### As a Proxmox LXC template

**Download a ready-made one:** every
[GitHub Release](https://github.com/mastifdogo/Bookeeping/releases) has a
Debian 13 CT template (`debian-13-ledger_<version>_amd64.tar.zst`) with Ledger
and PostgreSQL pre-installed. On the Proxmox host:

```sh
wget -P /var/lib/vz/template/cache \
  https://github.com/mastifdogo/Bookeeping/releases/download/<version>/debian-13-ledger_<version>_amd64.tar.zst
```

It then appears under **local → CT Templates**. Each release's notes include
the exact URL and its SHA-256 checksum.

**Or build it yourself** (needs root and `apt install mmdebstrap zstd`):

```sh
make lxc-template                 # dist/debian-13-ledger_<version>_amd64.tar.zst
make lxc-template SUITE=noble     # Ubuntu 24.04 (also bookworm, jammy; ARCH=arm64)
```

Upload it under **CT Templates**, create an unprivileged container with
nesting enabled, add the CSV bind mount
(`pct set <ctid> -mp0 /mnt/pve/truenas/ledger,mp=/app/csv_data`) and start it.
On first boot each container creates its own database, database password and
`admin` login. Log in with the password `1234`; Ledger then asks you to
choose your own password or 4-digit passcode. Details are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#alternative-a-ready-made-lxc-template).

### On any Debian/Ubuntu host or container

Without Proxmox, run the steps the script automates yourself, as root, from
the unpacked release:

```sh
apt install -y curl ca-certificates
sh deploy/pgdg.sh && apt update && apt install -y postgresql-18   # PostgreSQL 18 (Debian 13's own is 17)
sh deploy/install.sh                                  # user, program, systemd units, /etc/ledger/ledger.env
cp /usr/local/share/ledger/postgresql-lowmem.conf /etc/postgresql/*/main/conf.d/ledger.conf
systemctl restart postgresql
sh /usr/local/share/ledger/setup-db.sh                # roles, schema, grants; writes DATABASE_URL
ledger-user add alice                                 # prompts for a password
systemctl enable --now ledger ledger-backup.timer
```

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) explains every step, plus TrueNAS
permissions, HTTPS behind a reverse proxy, backup/restore and troubleshooting.

### Publishing a release

Push a version tag. GitHub Actions (`.github/workflows/release.yml`) runs the
unit and PostgreSQL integration tests, then builds the release tarball and the
Debian 13 LXC template (an Ubuntu one can be built by hand, see above), and
attaches them with `SHA256SUMS`
to a GitHub Release:

```sh
git tag v0.4.0 && git push origin v0.4.0
```

Or use **Actions → Release → Run workflow** and enter a tag. Tags with a
suffix (`v0.5.0-rc.1`) are published as pre-releases.

## Layout

```
api/openapi.yaml      API contract (frontend and backend both follow it)
db/schema.sql         Tables, CHECK constraints, balance/immutability triggers
db/migrations/        Later schema changes, applied in order by deploy/migrate-db.sh
backend/src/main.ts       Startup, HTTP server, `ledger user` dispatch
backend/src/types.ts      Models matching the spec
backend/src/ledger.ts     Journal entry validation, transactional posting, reversal
backend/src/accounts.ts   Chart of accounts (sub-accounts, bank and card tags), account ledger, trial balance
backend/src/entities.ts   Customers and vendors: one list shared with modules (ctx.entities)
backend/src/files.ts      General Ledger CSV export, file listing/download, uploads
backend/src/import.ts     All-or-nothing CSV import of journal entries
backend/src/auth.ts       Users, bcrypt passwords, sessions
backend/src/orgs.ts       Organizations: per-organization databases and request routing
backend/src/reports.ts    Balance sheet and income statement
backend/src/dashboard.ts  Dashboard summary, notifications and to-dos
backend/src/reconcile.ts  Reconciling accounts against statements
backend/src/statement-reading.ts  The AI reads a statement PDF; its lines are matched to the books
backend/src/backup.ts     `ledger backup run`: dumps to an SMB share and/or Google Drive
backend/src/restore.ts    Settings → Backups → Restore (per organization): the app's part and root's (`ledger update run`)
backend/src/module-settings.ts  Module settings declared in ledger-module.json
backend/src/cli.ts        `ledger user add|role|passwd|disable|enable|list`
backend/src/module-files.ts  Files modules hand each other (ctx.files)
backend/src/search.ts     The search bar (accounts, entries, module providers)
backend/src/llm.ts        Settings → LLM API and ctx.llm (a table of providers, three wire protocols)
backend/src/gmail.ts      Settings → Mail → Gmail (OAuth with PKCE) and ctx.gmail
backend/src/documents.ts  Documents: PDFs of receipts, statements and invoices on the data share, and ctx.documents
backend/src/mail.ts       Settings → Mail (IMAP/SMTP, e.g. Proton Mail Bridge) and ctx.mail
backend/src/mail-client.ts  IMAP and SMTP clients; mime.ts reads messages
backend/src/update.ts     Update schedule, status files, due-time logic (shared by app and updater)
backend/src/updater.ts    `ledger update run`: the root updater (GitHub Releases, verify, install, rollback, reboot)
backend/src/module-host.ts       Runs installed modules: routes, UI, the `ctx` API
backend/src/module-installer.ts  Root side: installs/updates/removes modules, runs their migrations
backend/src/http.ts       Routes, handlers, error mapping, request safety
backend/src/decode.ts     Strict JSON request decoding (exact integers, no unknown fields)
backend/src/csv.ts        RFC 4180 CSV reader/writer
backend/src/money.ts      Integer-cent parsing and formatting (bigint)
backend/ledger.sh         Launcher installed as /usr/local/bin/ledger
backend/test/             Unit tests and PostgreSQL integration tests (node:test)
frontend/             SvelteKit app; API types generated from api/openapi.yaml
deploy/               proxmox-deploy.sh, install.sh, setup-db.sh, systemd units, backups
deploy/lxc-template/  LXC template builder and first-boot provisioning
.github/workflows/    release.yml: tests, builds and publishes releases + templates
docs/DEPLOYMENT.md    Proxmox LXC + TrueNAS deployment guide
```

## Accounting rules and where they are enforced

| Rule | Application | PostgreSQL |
|------|-------------|------------|
| Entry has >= 2 lines | `validateJournalEntry` | deferred constraint trigger, checked at `COMMIT` |
| Debits = credits **per currency** | `checkLinesPostable` | deferred constraint trigger, checked at `COMMIT` |
| Line currency = account currency | taken from the account | composite FK `(account_id, currency)` |
| Only CAD / USD, 2 decimals | `isCurrency` | `currencies` table + `CHECK (minor_units = 2)` |
| Account code/currency fixed | not editable via API | `BEFORE UPDATE` trigger |
| No zero / both-sided lines | `validateJournalEntry` | `CHECK (amount <> 0)` |
| Integer money only | `bigint` cents; JSON floats rejected | `BIGINT` cents |
| All-or-nothing posting | one `BEGIN … COMMIT` per entry | deferred triggers abort the `COMMIT` |
| Posted rows fixed | no delete code paths; only a line's amount can change | triggers reject `DELETE`/`TRUNCATE` and every `UPDATE` but a logged amount change; lines can't be added to an entry from a later transaction |
| Amount changes logged | `PATCH /journal-entries/{id}/amounts` | the trigger that allows the change writes old and new amount, who and why to `transaction_changes`, which can't be edited; the entry must still balance at `COMMIT`; refused for lines ticked on a reconciliation |
| Corrections | `POST /journal-entries/{id}/reverse` | `UNIQUE (reverses_id)`: reversed once at most |
| Inactive accounts | pre-check with `FOR SHARE` lock | `BEFORE INSERT` trigger |
| CSV import all-or-nothing, never twice | one transaction per file | `UNIQUE (sha256)` on `csv_imports` |
| Who posted what | session user recorded | `created_by` / `imported_by`; users can't be deleted |
| App can't bypass the rules | — | app role owns nothing (see `db/grants.sql`) |

Lines are stored as one signed `amount` (debit > 0, credit < 0). The API exposes
separate `debit_cents` / `credit_cents`, and refers to accounts by `code`.

### Currencies

Each account has one currency (CAD or USD) and each journal entry must balance
within every currency, so amounts are exact and no exchange rates are stored.
Move value between currencies through an FX clearing account in each currency
(type `equity`, so the balance sheet's assets show only real balances):

| account              | debit   | credit  |
|----------------------|---------|---------|
| 1900 FX clearing CAD | 1370.00 |         |
| 1000 Bank CAD        |         | 1370.00 |
| 1010 Bank USD        | 1000.00 |         |
| 1910 FX clearing USD |         | 1000.00 |

Reports (trial balance, ledger export) total each currency separately.

### Migrating from other software

**Settings → Import & export → Migrate** takes an export from QuickBooks,
Xero, Wave, Sage, FreshBooks or a spreadsheet (CSV or tab-separated, any of
the usual encodings). The LLM set up under Settings → LLM API works out
what the file is (chart of accounts, general ledger, trial balance,
customers or vendors), which row holds the column names, how the columns map
to Ledger's, the date and number formats, and a type for every account it
sees, matching ones Ledger already has. Without an LLM, column names are
matched by rules. You see what was understood and what would be created,
can change the kind, any column and each account (create with a number,
name and type, or post to an existing one), and nothing is written until you
press Import. Imports are all or nothing; transactions that don't balance
are listed by row; the same file can't be imported twice. Customer and
vendor lists go to a module that accepts them.

### CSV import

Drop a file in `/app/csv_data` and `POST /api/v1/imports/journal-entries
{"filename": "..."}`. Rows sharing an `entry_key` form one entry:

```
entry_key,entry_date,description,account_code,debit,credit
S1,2026-10-01,Cash sale,1000,250.00,
S1,,,4000,,250.00
```

Optional columns: `reference`, `memo`, `currency`. Full rules are in
`api/openapi.yaml`.

## Running

For production, see [Installation](#installation). To run locally for
development:

Needs Node.js 22.18 or newer.

```sh
createdb ledger && psql -d ledger -v ON_ERROR_STOP=1 -f db/schema.sql
make build            # frontend (vite build) + backend bundle into out/
export DATABASE_URL=postgres://localhost/ledger
./out/bin/ledger user add alice
CSV_DIR=./csv ./out/bin/ledger      # http://localhost:8080
```

| Variable        | Default          |
|-----------------|------------------|
| `DATABASE_URL`  | required         |
| `HTTP_ADDR`     | `:8080`          |
| `CSV_DIR`       | `/app/csv_data`  |
| `DB_MAX_CONNS`  | `4`              |
| `COOKIE_SECURE` | `auto`           |
| `WEB_DIR`       | `web` next to `ledger.mjs` |
| `LEDGER_MAX_HEAP_MB` | `96` (JavaScript heap limit, set by the launcher) |

### Authentication

Users log in with a username and password (bcrypt) and get a server-side
session in an HttpOnly, SameSite=Strict cookie. Sessions end after 8 hours idle
or 7 days. Repeated failed logins are throttled. There's no sign-up page:
admins add users under **Settings → Users** (or `ledger user add <name>
--role …` on the server). Every journal entry and import records who posted
it.

### Users and roles

- **Admin**: everything in their books. Admins of the main books also run
  the server: users, organizations, modules, backups, updates, AI and Gmail.
- **Bookkeeper**: works in the books (entries, accounts, reconciliation,
  imports, modules' pages).
- **Viewer**: reads the books and reports; changes nothing.

The API enforces roles on every request (403 otherwise). Ledger always keeps
at least one active admin of the main books. Users can't be deleted, because
entries record who posted them; disable them instead.

### Organizations

One server can keep several sets of books apart: the main books plus any
number of organizations (a business, or someone's personal books). Each
organization has its own PostgreSQL database with the same schema, rules and
grants, so accounts, entries, CSV files and modules' data never mix. Users,
logins and server settings live in the main database.

When adding a user under **Settings → Users**, choose their books: the main
books, an existing organization (they get its accounts and entries), or a
new business or personal organization of their own, optionally starting
with a basic chart of accounts. A user's role applies per organization, and
anyone in more than one switches between them at the top of the sidebar.
The app asks root to create a new organization's database (the updater runs
`deploy/create-org-db.sh` through `ledger-update.path`, in seconds);
upgrades, module installs and backups cover every organization.

### Search

The search box at the top of the sidebar (or `/`, or Ctrl/Cmd+K) finds pages
and settings, accounts, journal entries by text, `#number` or amount
(`1,800` or `45.00`), and whatever modules add.

### AI and Gmail for modules

**Settings → LLM API** holds one or more LLM connections from any provider
(Anthropic, OpenAI, Google Gemini, OpenRouter, Mistral, Groq, Ollama, or any
other OpenAI-compatible server; "Find models" lists what the provider
offers), e.g. one for text and a vision model for
images and documents, **Settings → Mail** connects a mailbox over IMAP and SMTP (Proton Mail
through Proton Mail Bridge, or any other; see docs/DEPLOYMENT.md), and
**Settings → Mail → Gmail** connects one Gmail account
(Google OAuth: read, and optionally send). Modules use them through
`ctx.llm` and `ctx.gmail` without ever seeing the keys, and only if an admin
allows each module there. Usage is logged per module and connection.

### Dashboard

The dashboard shows, per currency, net worth (assets minus liabilities), and
revenue, expenses and net income for this month and the year to date, with
the largest expenses this month. Below that are **notifications** and
**to-dos** posted by modules (and by Ledger itself, e.g. when an update is
installed or fails). Dismiss a notification with ✕; tick a to-do to mark it
done. Modules post them with `ctx.dashboard` ([docs/MODULES.md](docs/MODULES.md)).

### Clearing accounts

A clearing account is an in-between account: one side of a transaction is
posted there now and the other side later, so it returns to zero (a card
sale and its payout, wages worked out and then paid, a transfer in
transit). Modules make their own when they need one, and you can tag an
asset or liability account of your own as **Clearing**. Clearing accounts
are hidden from the Accounts page and the account dropdowns (reports and
balances still count them); **Settings → Clearing accounts** lists them all,
with who made each and its balance, and a switch to show one. The Accounts
page still points out any that aren't at zero.

### Changing an entry's amounts and date

An entry's page has **Change amounts…**: type new debit and credit figures
for its lines (they must still balance) and, optionally, why. **Change
date…** moves the entry to another date. Descriptions and the number of
lines can't change; for those, reverse the entry and post a new one. Every
change is kept and shown under the entry in one **Changes** log (amounts,
the date, and lines moved out of Unreconciled): what it was, what it is
now, who changed it, when and why. The entry is marked "amounts changed"
or "date changed". Amounts can't be changed on an entry that was reversed
or is a reversal; neither amounts nor the date on an entry with a line
ticked on a reconciliation (untick it, or undo the reconciliation, first).

### Root mode

Admins have a **Root mode** switch under Settings → Account. While it is
on, the whole background is red and the guards that keep the books intact
step aside for a few actions:

- On an account's page: change its **type** even after things are posted
  to it (its currency only while nothing is), or **Delete account…**, which
  deletes the account with every journal entry that has a line in it (whole
  entries, in every account they touch, with their reversals), its
  reconciliations and the change logs that point at them. Sub-accounts move
  to the top level.
- Under Settings → Users (admins of the main books): **Rename** or
  **Delete** a user. A deleted user is removed from every set of books;
  entries and changes they made stay, with no name on them.

In root mode a **▤ Console** button opens a console beside the page (drag
the divider to resize it). It shows live, read-only, each request the page
makes and every SQL statement the server runs for it, with the values sent,
how long it took, how many rows it touched, and any database error, so it
can be used to debug. Admins of the main books can switch it to the whole
server. Password hashes, session tokens and values that look like secrets
are hidden. Nothing is recorded while no console is open.

Every root action is kept in **Settings → Root log** with a copy of what it
changed or deleted, and **Reverse** puts it back exactly (same ids, same
amounts, the change logs and reconciliations too). Reversing needs root mode
on. Root mode ends when it is turned off or the admin logs out. In the
database, the guards only step aside inside a transaction that turns root
on for itself; the app's database role can otherwise still not delete
posted entries or accounts.

### Renumbering accounts

An account's code can be changed on its page (**Edit**). Its entries,
reconciliations and documents stay with it, since they point at the account
and not at its code. Modules that keep the old code (in their settings or
their own tables) are updated in the same step, so a module set to post to
`1200` posts to the same account under its new code. Each change is
recorded. The old code is then free for another account. CSV files exported
earlier still carry the old code: change it there before importing them
again.

### Documents

**Documents** (sidebar) keeps the PDFs behind the books: receipts,
statements and invoices you import (several at once, by choosing or dropping
files), and PDFs made in Ledger, such as an invoice a module draws up. Each
has a kind, and optionally the date on it, a customer or vendor, the bank or
card account it belongs to (a statement's account, also set when you
reconcile against it) and a note.
They are filed as ordinary files on the data share, in folders by kind and
year (`receipts/2026/…`), listed with folders, a search box and an
"Imported / Made in Ledger" filter, and carried in every backup. The same
file can't be imported twice. Modules read them and add their own through
`ctx.documents`, and the page shows what each module did with a document.

### Reconciliation

**Reconcile** (sidebar) checks an account against a bank or card statement.
Enter the statement's closing date and balance, then tick each transaction
that appears on it. When the cleared balance matches (difference 0.00),
finish. The page totals the debits and credits ticked and not ticked. If
a difference is left, **Finish, difference to Unreconciled** posts it
between the account and Ledger's own **Unreconciled** clearing account and
ticks it, so the account matches the statement; when the AI's statement
lines missing from the books make up exactly the difference, each gets its
own entry with its date and description. Transactions in the books up to
the statement date that aren't ticked (a cheque not cashed yet) move out of
the account into Unreconciled when you finish: the line itself changes
account, and the move is logged on the entry. Everything in Unreconciled
gets a dashboard to-do, and a red **Danger: unreconciled transactions**
notice shows on every page until the account is back at zero. On the
entry's page, **Move…** sends a line on: back to the bank once it clears
(then tick it on the next statement), or to the account it belongs in.
Undoing a reconciliation moves back the lines it moved that are still in
Unreconciled. Lines of reversed entries and reversals stay where they are.
The next statement starts from there. Only the most recent
reconciliation of an account can be undone. Posted entries never change;
reconciliations only mark lines as cleared.

Choose the statement's PDF (one under Documents, or import it there and
then) and the page opens as a split screen: the statement on one side, the
transactions on the other, with a divider you drag to resize. **Read
statement and pre-reconcile** has the AI (the LLM connection for images and
documents, which must be a provider that reads PDFs) copy out the
statement's closing date, balances and lines; Ledger starts the
reconciliation with that date and balance and ticks the transactions that
match a statement line (same amount, close in date). Each ticked line shows
the statement line it was paired with, and statement lines missing from the
books are listed. The AI finishes nothing: you check the ticks against the
statement and press Finish, which takes you back to the Reconcile page.
The Reconcile page and its account dropdown list bank accounts and credit
cards (accounts tagged chequing, savings or credit card); **Add account…**
pulls any other account into the list. While a reconciliation is in
progress, the Reconcile tab opens on the most recently started one (**All
reconciliations** goes back to the list). A
statement that has been reconciled against is tagged "reconciled" under
Documents and is no longer offered when starting a reconciliation.

### Backups

**Settings → Backups** sends database backups to a network share (any SMB
share, or a folder mounted into the container), Google Drive, or both, on a schedule you choose, with **Back up now** and the result
of the last run. Each backup also carries CSV copies: the General Ledger and
each module's data, readable in any spreadsheet. Details:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#8-backups-and-restore).

### Sidebar, settings and panes

The sidebar's gear opens **Settings**: Account (password), Sidebar, Backups,
Import & export (CSV upload, General Ledger export and the files on the
share), Modules and Updates, plus a tab for each installed module (its
details, settings and, if hidden from the sidebar, its page) and for each
page hidden from the sidebar. Under **Sidebar** each user chooses which bookkeeping pages and
modules appear and in what order (saved per user, on the server).

On a wide screen, hover a sidebar entry and click its split icon to **open
it beside** the current page. Panes fill the window's height and sit side by
side: drag a pane's header onto another to move it, drag the edge between two
to resize, ✕ to close, or ⤢ to open it full width. Each browser remembers its
panes.

### Automatic updates

**Settings → Updates** shows the installed version and sets a
schedule: days of the week, time, time zone, and whether to reboot the
container afterwards, and whether to also check each time the server starts.
At that time a root service installs the latest GitHub
Release if it is newer: it verifies the checksum, backs up the database
first, and rolls back if the new version doesn't start. Details:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#9-upgrading).

### Modules

**Settings → Modules** installs extensions from GitHub repositories, such as
invoicing, dashboards or an LLM gateway. Enter `owner/name`; Ledger shows
what the module does, then installs its latest release. A module runs inside
Ledger and appears in the sidebar. It can read the books and post entries,
but it can't edit or delete posted ones. Writing a module:
[docs/MODULES.md](docs/MODULES.md); a small working module to start from is
in `.claude/skills/ledger-module/template/`. To have an LLM write one, paste
[docs/MODULE_LLM_CONTEXT.md](docs/MODULE_LLM_CONTEXT.md) into the chat and
describe the module. In Claude Code on this repository, the `ledger-module`
skill (`.claude/skills/ledger-module/`) scaffolds, checks and publishes
modules.

### Reports

Trial balance, balance sheet and income statement, each per currency. Net
income that hasn't been closed to equity appears on the balance sheet as
"Net income (unclosed)", so assets = liabilities + equity always holds.

### Frontend development

```sh
(cd backend && npm ci && npm start) &   # API on :8080, straight from the TypeScript sources
(cd frontend && npm run dev)            # Vite on :5173, proxies /api to :8080
make api-types                          # after editing api/openapi.yaml
```

The frontend only talks to the API through `openapi-fetch` with types
generated from `api/openapi.yaml`, so a contract change that breaks the UI
fails `npm run check`.

In production the app connects as a role that does **not** own the tables, so
it can't drop or disable the triggers (`deploy/setup-db.sh`, `db/grants.sql`).

## Tests

```sh
make test                                                       # type checks + unit tests (backend and frontend)
make test-integration TEST_DATABASE_URL=postgres://postgres:secret@localhost/postgres
```

The integration tests create a throwaway database, apply `db/schema.sql`, test
the API end to end (including direct SQL attempts to bypass the rules), and
drop the database afterwards.
