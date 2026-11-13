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

export interface Account {
	code: string;
	name: string;
	type: AccountType;
	currency: Currency;
	description: string;
	is_active: boolean;
	/** The account's own postings (debit-positive). */
	balance_cents: bigint;
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
}

export interface AccountUpdate {
	name?: string;
	description?: string;
	is_active?: boolean;
	/** Moves the account under another (same type and currency); null makes it top-level. */
	parent_code?: string | null;
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
	posted_at: Date;
	totals: CurrencyTotal[];
	lines: JournalLine[];
	/** Module records linked to this entry. */
	links: EntryLink[];
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
	/** The organization this session works in. */
	org: { id: number; name: string; kind: "business" | "personal"; db_name: string };
}

/** The API shape of a user (no id). */
export function publicUser(u: User) {
	return { username: u.username, role: u.role, is_active: u.is_active, created_at: u.created_at, last_login_at: u.last_login_at, server_admin: u.server_admin };
}
