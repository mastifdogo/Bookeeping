// Organizations: separate sets of books.
//
// Organization 1 is the main books, in the main database, which also holds
// the users, sessions and memberships. Every other organization has a
// database of its own (organizations.db_name) with the same schema, so its
// accounts, entries, files and module data never mix with another's. Each
// request runs in its session's organization: app.db is a router that sends
// queries to that organization's database (inOrg), and module code using
// ctx.db follows along. Users, logins and server settings use app.main.
//
// A new organization's database is created by root (the updater, which runs
// deploy/create-org-db.sh) or, in development and tests, by a provisioner
// passed to newApp.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { App } from "./app.ts";
import { createAccount } from "./accounts.ts";
import { newPool, queryRow, queryRows, withDatabase, withTx, type Pool } from "./db.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { charCount, trimSpace } from "./text.ts";
import { writeFileAtomic } from "./update.ts";
import { ROLES, type AccountType, type Currency, type Role } from "./types.ts";

export const MAIN_ORG = 1;
/** Asks root (ledger-update.path) to create pending organizations' databases. */
export const ORGS_RUN_NOW_FILE = "orgs-run-now";
export const ORG_KINDS = ["business", "personal"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export interface Organization {
	id: number;
	name: string;
	kind: OrgKind;
	db_name: string;
	status: "pending" | "ready" | "error";
	message: string;
	setup: string;
	created_at: Date;
}

/** An organization a user can open, with their role in it. */
export interface OrgAccess {
	id: number;
	name: string;
	kind: OrgKind;
	status: Organization["status"];
	role: Role;
}

/** Where a request's queries go. */
export interface OrgScope {
	id: number;
	db_name: string;
}

const scope = new AsyncLocalStorage<OrgScope>();

/** Runs fn with app.db (and modules' ctx.db) pointing at the organization's database. */
export function inOrg<T>(org: OrgScope, fn: () => T): T {
	return scope.run({ id: org.id, db_name: org.db_name }, fn);
}

/** The organization the current request works in (the main books outside a request). */
export function currentOrg(): OrgScope {
	return scope.getStore() ?? { id: MAIN_ORG, db_name: "" };
}

/** One pool per organization database, opened on first use. */
export class OrgPools {
	readonly main: Pool;
	private readonly url: string;
	private readonly pools = new Map<string, Pool>();

	constructor(main: Pool, databaseUrl: string) {
		this.main = main;
		this.url = databaseUrl;
	}

	current(): Pool {
		const s = scope.getStore();
		return !s || s.id === MAIN_ORG ? this.main : this.forDb(s.db_name);
	}

	forDb(name: string): Pool {
		let p = this.pools.get(name);
		if (!p) {
			if (!this.url) throw new Error("the database URL is not known, so other organizations can't be opened");
			p = newPool(withDatabase(this.url, name), 3);
			this.pools.set(name, p);
		}
		return p;
	}

	async end(): Promise<void> {
		const all = [...this.pools.values()];
		this.pools.clear();
		await Promise.all([this.main.end(), ...all.map((p) => p.end())]);
	}
}

/** A Pool-shaped object that forwards every call to the current organization's pool. */
export function routedPool(orgs: OrgPools): Pool {
	return new Proxy({} as Pool, {
		get(_t, prop) {
			if (prop === "end") return () => orgs.end();
			const p = orgs.current() as unknown as Record<string | symbol, unknown>;
			const v = p[prop];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(p) : v;
		},
	});
}

// ---------------------------------------------------------------------------
// Organizations and memberships (main database)
// ---------------------------------------------------------------------------

const ORG_COLUMNS = `id, name, kind, db_name, status, message, setup, created_at`;

type OrgRow = Omit<Organization, "id"> & { id: bigint };
const toOrg = (r: OrgRow): Organization => ({ ...r, id: Number(r.id) });

export async function listOrganizations(app: App): Promise<Organization[]> {
	return (await queryRows<OrgRow>(app.main, `SELECT ${ORG_COLUMNS} FROM organizations ORDER BY id`)).map(toOrg);
}

export async function getOrganization(app: App, id: number): Promise<Organization> {
	const r = await queryRow<OrgRow>(app.main, `SELECT ${ORG_COLUMNS} FROM organizations WHERE id = $1`, [id]);
	if (!r) throw new NotFoundError();
	return toOrg(r);
}

/** The organizations a user can open: the main books (unless their role there is "none") and their memberships. */
export async function orgsForUser(app: App, userId: number): Promise<OrgAccess[]> {
	const rows = await queryRows<{ id: bigint; name: string; kind: OrgKind; status: Organization["status"]; role: string }>(
		app.main,
		`SELECT o.id, o.name, o.kind, o.status, u.role
		   FROM organizations o, users u
		  WHERE o.id = 1 AND u.id = $1 AND u.role <> 'none'
		 UNION ALL
		 SELECT o.id, o.name, o.kind, o.status, m.role
		   FROM memberships m JOIN organizations o ON o.id = m.org_id
		  WHERE m.user_id = $1
		 ORDER BY 1`,
		[userId],
	);
	return rows.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, status: r.status, role: r.role as Role }));
}

/** Every user's memberships, for the Users page. */
export async function allMemberships(app: App): Promise<Map<number, OrgAccess[]>> {
	const rows = await queryRows<{ user_id: bigint; id: bigint; name: string; kind: OrgKind; status: Organization["status"]; role: Role }>(
		app.main,
		`SELECT m.user_id, o.id, o.name, o.kind, o.status, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id ORDER BY o.name, o.id`,
	);
	const out = new Map<number, OrgAccess[]>();
	for (const r of rows) {
		const list = out.get(Number(r.user_id)) ?? [];
		list.push({ id: Number(r.id), name: r.name, kind: r.kind, status: r.status, role: r.role });
		out.set(Number(r.user_id), list);
	}
	return out;
}

export interface OrgCreate {
	name: string;
	kind: OrgKind;
	/** Start with a basic chart of accounts in this currency. */
	chart: Currency | null;
}

export function validateOrgCreate(v: ValidationError, prefix: string, o: OrgCreate): void {
	const n = charCount(trimSpace(o.name));
	if (n < 1 || n > 100) v.add(prefix + "name", "must be 1-100 characters");
	if (!ORG_KINDS.includes(o.kind)) v.add(prefix + "kind", "must be business or personal");
}

/**
 * Records a new organization and has its database created: right away when
 * the app has a provisioner (development, tests), otherwise by root on the
 * next ledger-update.path run (seconds).
 */
export async function createOrganization(app: App, input: OrgCreate, tx?: Pool | import("pg").PoolClient): Promise<Organization> {
	const v = new ValidationError();
	validateOrgCreate(v, "", input);
	v.throwIfAny();
	const db = tx ?? app.main;
	const main = await queryRow<{ db: string }>(db, `SELECT current_database() AS db`);
	const row = await queryRow<OrgRow>(
		db,
		`INSERT INTO organizations (name, kind, db_name, status, setup)
		 VALUES ($1, $2, 'pending_' || md5(random()::text || clock_timestamp()::text), 'pending', $3)
		 RETURNING ${ORG_COLUMNS}`,
		[trimSpace(input.name), input.kind, input.chart ? `${input.kind}:${input.chart}` : ""],
	);
	// e.g. ledger_org2; the id keeps it unique, the prefix keeps it recognisable.
	const base = main!.db.replace(/[^a-z0-9_]/g, "_").slice(0, 40);
	const updated = await queryRow<OrgRow>(db, `UPDATE organizations SET db_name = $2 WHERE id = $1 RETURNING ${ORG_COLUMNS}`, [
		row!.id,
		`${base}_org${row!.id}`,
	]);
	return toOrg(updated!);
}

/** Starts creating a pending organization's database (after its row is committed). */
export async function provisionOrganization(app: App, org: Organization): Promise<Organization> {
	if (org.status !== "pending") return org;
	if (!app.provisionOrg) {
		await writeFileAtomic(path.join(app.update.config, ORGS_RUN_NOW_FILE), new Date().toISOString() + "\n", 0o640);
		return org;
	}
	try {
		await app.provisionOrg(org.db_name);
		await app.main.query(`UPDATE organizations SET status = 'ready', message = '' WHERE id = $1`, [org.id]);
	} catch (err) {
		log.error("create organization database", { org: org.id, err: (err as Error).message });
		await app.main.query(`UPDATE organizations SET status = 'error', message = $2 WHERE id = $1`, [org.id, (err as Error).message.slice(0, 500)]);
	}
	return finishSetup(app, await getOrganization(app, org.id));
}

/** Creates a ready organization's starter chart of accounts, once. */
export async function finishSetup(app: App, org: Organization): Promise<Organization> {
	if (org.status !== "ready" || org.setup === "") return org;
	const claimed = await app.main.query(`UPDATE organizations SET setup = '' WHERE id = $1 AND setup = $2`, [org.id, org.setup]);
	if (claimed.rowCount === 0) return { ...org, setup: "" };
	const [kind, currency] = org.setup.split(":") as [OrgKind, Currency];
	try {
		await inOrg(org, async () => {
			for (const [code, name, type] of STARTER_CHARTS[kind] ?? []) {
				await createAccount(app, { code, name, type, currency, description: "" }).catch((err) => {
					if (!(err instanceof Error && /already exists/.test(err.message))) throw err;
				});
			}
		});
	} catch (err) {
		log.error("create starter chart of accounts", { org: org.id, err: (err as Error).message });
	}
	return { ...org, setup: "" };
}

/** Finishes the setup of organizations root has created since. */
export async function refreshOrganizations(app: App): Promise<void> {
	for (const o of await listOrganizations(app)) if (o.status === "ready" && o.setup !== "") await finishSetup(app, o);
}

export async function renameOrganization(app: App, id: number, name: string): Promise<Organization> {
	const v = new ValidationError();
	validateOrgCreate(v, "", { name, kind: "business", chart: null });
	v.throwIfAny();
	const r = await queryRow<OrgRow>(app.main, `UPDATE organizations SET name = $2 WHERE id = $1 RETURNING ${ORG_COLUMNS}`, [id, trimSpace(name)]);
	if (!r) throw new NotFoundError();
	return toOrg(r);
}

/** Gives a user a role in an organization other than the main books. */
export async function setMembership(app: App, userId: number, orgId: number, role: Role): Promise<void> {
	if (!ROLES.includes(role)) {
		const v = new ValidationError();
		v.add("role", "must be admin, bookkeeper or viewer");
		v.throwIfAny();
	}
	if (orgId === MAIN_ORG) throw new ConflictError("access to the main books is the user's role; change that instead");
	await getOrganization(app, orgId);
	await app.main.query(
		`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
		[userId, orgId, role],
	);
}

export async function removeMembership(app: App, userId: number, orgId: number): Promise<void> {
	await withTx(app.main, {}, async (tx) => {
		const r = await tx.query(`DELETE FROM memberships WHERE user_id = $1 AND org_id = $2`, [userId, orgId]);
		if (r.rowCount === 0) throw new NotFoundError();
		// Sessions working in it move back to an organization the user still has.
		await tx.query(`UPDATE sessions SET org_id = 1 WHERE user_id = $1 AND org_id = $2`, [userId, orgId]);
	});
}

/** Moves a session to another organization the user may open. */
export async function switchOrganization(app: App, userId: number, tokenHash: Buffer, orgId: number): Promise<void> {
	const access = (await orgsForUser(app, userId)).find((o) => o.id === orgId);
	if (!access) throw new HttpError(403, "you don't have access to that organization", "forbidden");
	if (access.status !== "ready") throw new ConflictError(access.status === "pending" ? "that organization's books are still being created" : "that organization's books could not be created");
	await app.main.query(`UPDATE sessions SET org_id = $2 WHERE token_hash = $1`, [tokenHash, orgId]);
}

// ---------------------------------------------------------------------------
// Inside an organization's database
// ---------------------------------------------------------------------------

const mirrored = new Set<string>();

/**
 * Copies the user's id and name into the organization's own users table (no
 * password: it can't be used to log in), so entries and files it records
 * point at a real user. Once per process, organization and user.
 */
export async function mirrorUser(app: App, org: OrgScope, user: { id: number; username: string }): Promise<void> {
	if (org.id === MAIN_ORG) return;
	const key = `${org.db_name}:${user.id}:${user.username}`;
	if (mirrored.has(key)) return;
	await app.orgs.forDb(org.db_name).query(
		`INSERT INTO users (id, username, password_hash, role) OVERRIDING SYSTEM VALUE VALUES ($1, $2, '!', 'none')
		 ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username`,
		[user.id, user.username],
	);
	mirrored.add(key);
}

/** Where the current organization's CSV exports and uploads live. */
export async function filesDir(app: App): Promise<string> {
	const org = currentOrg();
	if (org.id === MAIN_ORG) return app.csvDir;
	const dir = path.join(app.csvDir, ".orgs", org.db_name);
	await mkdir(dir, { recursive: true, mode: 0o750 });
	return dir;
}

/** Runs fn once in each ready organization (for modules' background work). */
export async function forEachOrg(app: App, fn: (org: { id: number; name: string; kind: OrgKind }) => unknown): Promise<void> {
	for (const o of await listOrganizations(app)) {
		if (o.status !== "ready") continue;
		await inOrg(o, async () => fn({ id: o.id, name: o.name, kind: o.kind }));
	}
}

const STARTER_CHARTS: Record<OrgKind, [string, string, AccountType][]> = {
	personal: [
		["1000", "Chequing", "asset"],
		["1100", "Savings", "asset"],
		["2000", "Credit card", "liability"],
		["3000", "Opening balances", "equity"],
		["4000", "Salary", "revenue"],
		["4100", "Other income", "revenue"],
		["5000", "Housing", "expense"],
		["5100", "Groceries", "expense"],
		["5200", "Transportation", "expense"],
		["5300", "Utilities", "expense"],
		["5400", "Dining and entertainment", "expense"],
		["5900", "Other expenses", "expense"],
	],
	business: [
		["1000", "Bank", "asset"],
		["1200", "Accounts receivable", "asset"],
		["2000", "Accounts payable", "liability"],
		["2100", "Sales tax payable", "liability"],
		["3000", "Owner's equity", "equity"],
		["4000", "Sales", "revenue"],
		["5000", "Cost of goods sold", "expense"],
		["6000", "Rent", "expense"],
		["6100", "Office and supplies", "expense"],
		["6200", "Professional fees", "expense"],
		["6900", "Other expenses", "expense"],
	],
};
