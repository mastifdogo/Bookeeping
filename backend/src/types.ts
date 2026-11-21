// Models. These mirror components/schemas in api/openapi.yaml; property order
// matches the JSON the API returns. Money is bigint cents; dates are
// "YYYY-MM-DD" strings. Database ids of accounts stay internal: the API
// identifies accounts by code.

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const CURRENCIES = ["CAD", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isAccountType(s: string): s is AccountType {
	return (ACCOUNT_TYPES as readonly string[]).includes(s);
}

export function isCurrency(s: string): s is Currency {
	return (CURRENCIES as readonly string[]).includes(s);
}

/** Must match the accounts_code_format CHECK constraint in db/schema.sql. */
export const ACCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface CurrencyInfo {
	code: Currency;
	name: string;
	minor_units: number;
}

export const ACCOUNT_KINDS = ["chequing", "savings", "credit_card", "clearing", "receivable", "payable"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
/** The account type each tag belongs to. */
/** The account types each tag goes with. */
export const KIND_TYPE: Record<AccountKind, AccountType[]> = { chequing: ["asset"], savings: ["asset"], credit_card: ["liability"], clearing: ["asset", "liability"], receivable: ["asset"], payable: ["liability"] };

export interface Account {
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
	description: string;
	is_active: boolean;
	/** The account's own postings (debit-positive). */
	balance_cents: bigint;
	/** What a bank-type account is, "clearing" for an in-between account, or null. */
	kind: AccountKind | null;
	/** The module that made the account (a clearing account of its own), or null. */
	module_id: string | null;
	/** That module's own name for it. */
	module_key: string | null;
	/** Left out of account lists and pickers (still in reports); clearing accounts are hidden unless shown. */
	hidden: boolean;
	/** The account this one sits under (same type and currency), or null. */
	parent_code: string | null;
	/** balance_cents plus the balances of every sub-account below it. */
	total_balance_cents: bigint;
	created_at: Date;
	updated_at: Date;
}

export interface AccountCreate {
	code: string;
	name: string;
	type: string;
	currency: string;
	description: string;
	/** The parent account's code; null or omitted for a top-level account. */
	parent_code?: string | null;
	/** chequing or savings (asset accounts) or credit_card (liability); null or omitted for none. */
	kind?: string | null;
	/** Hide it from account lists and pickers; defaults to true for a clearing account. */
	hidden?: boolean;
}

export interface AccountUpdate {
	/** A new code for the account (renumbering). */
	code?: string;
	name?: string;
	description?: string;
	is_active?: boolean;
	/** Moves the account under another (same type and currency); null makes it top-level. */
	parent_code?: string | null;
	/** Changes the tag; null removes it. */
	kind?: string | null;
	/** Hides or shows the account in lists and pickers. */
	hidden?: boolean;
}

export interface JournalLineCreate {
	account_code: string;
	debit_cents: bigint;
	credit_cents: bigint;
	memo: string;
}

export interface JournalEntryCreate {
	/** "" when missing. */
	entry_date: string;
	description: string;
	reference: string;
	lines: JournalLineCreate[];
	/** The entity (vendor, customer) the entry is with, if any. */
	entity_id?: number | null;
}

export interface JournalLine {
	id: number;
	line_number: number;
	account_code: string;
	account_name: string;
	currency: Currency;
	debit_cents: bigint;
	credit_cents: bigint;
	memo: string;
	/** Set when the line sits in Ledger's Unreconciled clearing account (it can be moved on). */
	unreconciled?: boolean;
}

/** Total debits (= total credits) of an entry in one currency. */
export interface CurrencyTotal {
	currency: Currency;
	amount_cents: bigint;
}

export interface JournalEntry {
	id: number;
	entry_date: string;
	description: string;
	reference: string;
	reverses_id: number | null;
	reversed_by_id: number | null;
	import_id: number | null;
	created_by: string | null;
	/** The vendor or customer the entry is with. */
	entity: { id: number; name: string } | null;
	posted_at: Date;
	totals: CurrencyTotal[];
	lines: JournalLine[];
	/** Module records linked to this entry. */
	links: EntryLink[];
	/** Tags shared by Ledger and every module: paid, billed, overdue, customer, vendor, and others (tags.ts). */
	tags: import("./tags.ts").EntryTag[];
	/** Whether any of its amounts were changed after it was posted. */
	amended: boolean;
	/** Every change made to its amounts, oldest first (only when one entry is fetched). */
	changes?: EntryChange[];
	/** Every move of one of its lines to another account, oldest first (only when one entry is fetched). */
	moves?: import("./unreconciled.ts").EntryMove[];
	/** Every change to its date, oldest first (only when one entry is fetched). */
	date_changes?: EntryDateChange[];
	/** Every change to its description, reference, customer or vendor and its lines' memos, oldest first (only when one entry is fetched). */
	edits?: EntryFieldEdit[];
	/** Every entry linked to this one, oldest first (only when one entry is fetched; related.ts). */
	related?: import("./related.ts").RelatedEntry[];
}

/** One change to the date of a posted entry. */
export interface EntryDateChange {
	id: number;
	old_date: string;
	new_date: string;
	reason: string;
	changed_by: string | null;
	changed_at: Date;
}

/** One change to the amount of a posted line. */
export interface EntryChange {
	id: number;
	line_number: number;
	account_code: string;
	account_name: string;
	currency: Currency;
	old_debit_cents: bigint;
	old_credit_cents: bigint;
	new_debit_cents: bigint;
	new_credit_cents: bigint;
	reason: string;
	changed_by: string | null;
	changed_at: Date;
}

/** One change to an entry's description, reference or customer or vendor, or to a line's memo. */
export interface EntryFieldEdit {
	id: number;
	field: "description" | "reference" | "entity" | "memo";
	/** The line, for a memo. */
	line_number: number | null;
	/** For "entity" the customer's or vendor's name; "" is none. */
	old_value: string;
	new_value: string;
	reason: string;
	changed_by: string | null;
	changed_at: Date;
}

/** The entry page's "Edit": whatever is given changes, the rest stays. */
export interface EntryEdit {
	entry_date?: string;
	description?: string;
	reference?: string;
	/** null takes the customer or vendor off. */
	entity_id?: number | null;
	lines?: { line_number: number; account_code?: string; memo?: string; debit_cents?: bigint; credit_cents?: bigint }[];
	reason?: string;
}

/** New amounts for some lines of a posted entry. */
export interface EntryAmend {
	lines: { line_number: number; debit_cents: bigint; credit_cents: bigint }[];
	reason?: string;
}

export interface EntryLink {
	module_id: string;
	ref: string;
	label: string;
	href: string;
	created_at: Date;
}

export interface EntryLinkInput {
	ref: string;
	label: string;
	href?: string;
}

export interface ReverseRequest {
	entry_date?: string;
	description?: string;
}

export interface AccountLedgerLine {
	journal_entry_id: number;
	line_id: number;
	entry_date: string;
	description: string;
	reference: string;
	memo: string;
	debit_cents: bigint;
	credit_cents: bigint;
	running_balance_cents: bigint;
	/** The tags of the line's entry (paid, billed, customer…). */
	tags: import("./tags.ts").EntryTag[];
}

export interface AccountLedger {
	account: Account;
	opening_balance_cents: bigint;
	closing_balance_cents: bigint;
	lines: AccountLedgerLine[];
}

export interface TrialBalanceRow {
	account_code: string;
	account_name: string;
	account_type: AccountType;
	currency: Currency;
	debit_cents: bigint;
	credit_cents: bigint;
}

/** Column totals for one currency; debits always equal credits. */
export interface TrialBalanceTotal {
	currency: Currency;
	debit_cents: bigint;
	credit_cents: bigint;
}

export interface TrialBalance {
	as_of: string;
	rows: TrialBalanceRow[];
	totals: TrialBalanceTotal[];
}

export interface ImportResult {
	import_id: number;
	filename: string;
	sha256: string;
	entries_imported: number;
	lines_imported: number;
}

export interface CsvFile {
	filename: string;
	size_bytes: number;
	modified_at: Date;
	row_count?: number;
}

export const ROLES = ["admin", "bookkeeper", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Whether a role includes another's permissions (admin ⊃ bookkeeper ⊃ viewer). */
export function roleAtLeast(have: Role, need: Role): boolean {
	return ROLES.indexOf(have) <= ROLES.indexOf(need);
}

/** A user's role in the main books; "none" gives them no access to them. */
export const MAIN_ROLES = [...ROLES, "none"] as const;
export type MainRole = (typeof MAIN_ROLES)[number];

export interface User {
	/** Internal; never serialised. */
	id: number;
	username: string;
	/** The role in the organization this session works in. */
	role: Role;
	is_active: boolean;
	created_at: Date;
	last_login_at: Date | null;
	/** The role in the main books (users.role). */
	main_role: MainRole;
	/** Admins of the main books run the server: users, modules, updates, backups, integrations. */
	server_admin: boolean;
	/** They must choose a new password before anything else (a new server's first login). */
	must_change_password: boolean;
	/** Root mode is on for this session (an admin's; see root.ts). */
	root: boolean;
	/** The root session's id while root mode is on (see root.ts). */
	root_session: string | null;
	/** The organization this session works in. */
	org: { id: number; name: string; kind: "business" | "personal"; db_name: string };
}

/** The API shape of a user (no id). */
export function publicUser(u: User) {
	return { username: u.username, role: u.role, is_active: u.is_active, created_at: u.created_at, last_login_at: u.last_login_at, server_admin: u.server_admin, must_change_password: u.must_change_password };
}
