// Users, bcrypt passwords and server-side sessions.

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { App } from "./app.ts";
import { withTx, queryRow, queryRows } from "./db.ts";
import { BadCredentialsError, NotFoundError, UnauthorizedError, ValidationError } from "./errors.ts";
import { charCount, trimSpace } from "./text.ts";
import { MAIN_ROLES, type MainRole, type Role, type User } from "./types.ts";
import { MAIN_ORG, orgsForUser } from "./orgs.ts";

export const SESSION_COOKIE = "ledger_session";
export const SESSION_IDLE_TIMEOUT = "8 hours";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
const SESSION_TOUCH_EVERY_MS = 60_000;
const BCRYPT_COST = 12;
const MIN_PASSWORD_LEN = 4; // a 4-digit PIN is allowed; logins are rate-limited
const MAX_PASSWORD_BYTES = 72; // bcrypt limit

/** Must match the users_username_format CHECK constraint in db/schema.sql. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface PasswordChange {
	current_password: string;
	new_password: string;
}

export function normalizeUsername(s: string): string {
	return trimSpace(s).toLowerCase();
}

export function validatePassword(v: ValidationError, field: string, pw: string): void {
	if (charCount(pw) < MIN_PASSWORD_LEN) v.add(field, `must be at least ${MIN_PASSWORD_LEN} characters`);
	else if (Buffer.byteLength(pw) > MAX_PASSWORD_BYTES) v.add(field, `must be at most ${MAX_PASSWORD_BYTES} bytes`);
}

function hashPassword(pw: string): Promise<string> {
	return bcrypt.hash(pw, BCRYPT_COST);
}

/** Compares in constant work; passwords longer than bcrypt's limit never match. */
async function passwordMatches(hash: string, pw: string): Promise<boolean> {
	const ok = await bcrypt.compare(pw, hash).catch(() => false); // malformed hash: no match
	return ok && Buffer.byteLength(pw) <= MAX_PASSWORD_BYTES;
}

// Compared against when a username does not exist, so a failed login takes
// the same time whether or not the user exists.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
	return (dummyHash ??= hashPassword("dummy password for timing"));
}

const USER_COLUMNS = `id, username, role, is_active, created_at, last_login_at`;

interface UserRow {
	id: bigint;
	username: string;
	role: MainRole;
	is_active: boolean;
	created_at: Date;
	last_login_at: Date | null;
}

/** A user as listed on the Users page: role is their role in the main books. */
export interface UserRecord {
	id: number;
	username: string;
	role: MainRole;
	is_active: boolean;
	created_at: Date;
	last_login_at: Date | null;
}

function toRecord(r: UserRow): UserRecord {
	return { id: Number(r.id), username: r.username, role: r.role, is_active: r.is_active, created_at: r.created_at, last_login_at: r.last_login_at };
}

interface SessionRow extends UserRow {
	org_id: bigint;
	org_name: string;
	org_kind: "business" | "personal";
	org_db: string;
	org_status: string;
	org_role: Role | null;
	must_change_password: boolean;
}

function toUser(r: SessionRow): User {
	return {
		id: Number(r.id),
		username: r.username,
		role: (Number(r.org_id) === MAIN_ORG ? r.role : r.org_role) as Role,
		is_active: r.is_active,
		created_at: r.created_at,
		last_login_at: r.last_login_at,
		main_role: r.role,
		server_admin: r.role === "admin",
		must_change_password: r.must_change_password === true,
		org: { id: Number(r.org_id), name: r.org_name, kind: r.org_kind, db_name: r.org_db },
	};
}

/** The session's user with their role in the session's organization (null role: no access to it). */
const SESSION_SELECT = `
	SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.last_login_at, u.must_change_password, s.last_seen_at,
	       o.id AS org_id, o.name AS org_name, o.kind AS org_kind, o.db_name AS org_db, o.status AS org_status,
	       m.role AS org_role
	  FROM sessions s
	  JOIN users u ON u.id = s.user_id
	  JOIN organizations o ON o.id = s.org_id
	  LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = s.org_id`;

function hasAccess(r: SessionRow): boolean {
	if (r.org_status !== "ready") return false;
	return Number(r.org_id) === MAIN_ORG ? r.role !== "none" : r.org_role !== null;
}

// ---------------------------------------------------------------------------
// Users (also used by the `ledger user` CLI)
// ---------------------------------------------------------------------------

/** Creates a user. The CLI makes admins by default; the app asks for a role. */
export async function createUser(app: App, username: string, password: string, role: MainRole = "admin", opts: { mustChangePassword?: boolean } = {}): Promise<UserRecord> {
	username = normalizeUsername(username);
	const v = new ValidationError();
	if (!USERNAME_RE.test(username)) v.add("username", "must be 1-64 characters: lowercase letters, digits, '.', '_' or '-'");
	if (!MAIN_ROLES.includes(role)) v.add("role", "must be admin, bookkeeper, viewer or none");
	validatePassword(v, "password", password);
	v.throwIfAny();
	const hash = await hashPassword(password);
	const row = await queryRow<UserRow>(
		app.main,
		`INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
		[username, hash, role, opts.mustChangePassword === true],
	);
	return toRecord(row!);
}

/**
 * Changes a user's role or active state. At least one active admin must
 * remain, so nobody can lock everyone out of user management. Disabling ends
 * the user's sessions; a role change applies from their next request.
 */
export async function updateUserAccess(app: App, username: string, change: { role?: MainRole; is_active?: boolean }): Promise<UserRecord> {
	return withTx(app.main, {}, async (tx) => {
		// Serialises concurrent changes, so two admins can't demote each other at once.
		await tx.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
		const cur = await queryRow<UserRow>(tx, `SELECT ${USER_COLUMNS} FROM users WHERE username = $1 FOR UPDATE`, [normalizeUsername(username)]);
		if (!cur) throw new NotFoundError();
		const role = change.role ?? cur.role;
		const active = change.is_active ?? cur.is_active;
		if (cur.role === "admin" && cur.is_active && (role !== "admin" || !active)) {
			const others = await queryRow<{ n: bigint }>(tx, `SELECT count(*) AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1`, [cur.id]);
			if ((others?.n ?? 0n) === 0n) {
				const v = new ValidationError();
				v.add(change.role !== undefined ? "role" : "is_active", "Ledger needs at least one active admin; make someone else an admin first");
				v.throwIfAny();
			}
		}
		const row = await queryRow<UserRow>(tx, `UPDATE users SET role = $2, is_active = $3 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [cur.id, role, active]);
		if (!active) await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [cur.id]);
		return toRecord(row!);
	});
}

/** Replaces a user's password and ends all of their sessions. */
export async function setPassword(app: App, username: string, password: string, mustChange = false): Promise<void> {
	const v = new ValidationError();
	validatePassword(v, "password", password);
	v.throwIfAny();
	await updateUser(app, username, `password_hash = $2, must_change_password = ${mustChange ? "TRUE" : "FALSE"}`, await hashPassword(password));
}

/** Enables or disables a user; disabling ends their sessions. */
export async function setUserActive(app: App, username: string, active: boolean): Promise<void> {
	await updateUser(app, username, `is_active = $2`, active);
}

async function updateUser(app: App, username: string, set: string, arg: unknown): Promise<void> {
	await withTx(app.main, {}, async (tx) => {
		const row = await queryRow<{ id: bigint }>(tx, `UPDATE users SET ${set} WHERE username = $1 RETURNING id`, [normalizeUsername(username), arg]);
		if (!row) throw new NotFoundError();
		await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
	});
}

export async function listUsers(app: App): Promise<UserRecord[]> {
	return (await queryRows<UserRow>(app.main, `SELECT ${USER_COLUMNS} FROM users ORDER BY username`)).map(toRecord);
}

export async function findUser(app: App, username: string): Promise<UserRecord> {
	const r = await queryRow<UserRow>(app.main, `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [normalizeUsername(username)]);
	if (!r) throw new NotFoundError();
	return toRecord(r);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function hashToken(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

/** Checks credentials and creates a session, returning its token. */
export async function login(app: App, username: string, password: string): Promise<{ user: User; token: string }> {
	username = normalizeUsername(username);
	const row = await queryRow<UserRow & { password_hash: string }>(
		app.main,
		`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = $1`,
		[username],
	);
	if (!row) {
		await passwordMatches(await getDummyHash(), password);
		throw new BadCredentialsError();
	}
	if (!(await passwordMatches(row.password_hash, password)) || !row.is_active) throw new BadCredentialsError();

	// Start in the main books, or else the first organization the user belongs to.
	const orgs = (await orgsForUser(app, Number(row.id))).filter((o) => o.status === "ready");
	if (orgs.length === 0) throw new BadCredentialsError("this account has no books to open yet; ask an admin");
	const token = randomBytes(32).toString("base64url");
	await withTx(app.main, {}, async (tx) => {
		// Opportunistic cleanup keeps the table small without a background job.
		await tx.query(`DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - $1::interval`, [SESSION_IDLE_TIMEOUT]);
		await tx.query(`INSERT INTO sessions (token_hash, user_id, expires_at, org_id) VALUES ($1, $2, now() + $3::interval, $4)`, [
			hashToken(token),
			row.id,
			`${SESSION_MAX_AGE_SECONDS} seconds`,
			orgs[0]!.id,
		]);
		await tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
	});
	return { user: await sessionUser(app, token), token };
}

/** Resolves a session token to an active user, sliding the idle timeout forward. */
export async function sessionUser(app: App, token: string): Promise<User> {
	if (token === "" || token.length > 100) throw new UnauthorizedError();
	const find = () =>
		queryRow<SessionRow & { last_seen_at: Date }>(
			app.main,
			`${SESSION_SELECT}
			  WHERE s.token_hash = $1
			    AND s.expires_at > now()
			    AND s.last_seen_at > now() - $2::interval
			    AND u.is_active`,
			[hashToken(token), SESSION_IDLE_TIMEOUT],
		);
	let row = await find();
	if (!row) throw new UnauthorizedError();
	if (!hasAccess(row)) {
		// Access to the session's organization was taken away: move to one the user still has.
		const next = (await orgsForUser(app, Number(row.id))).find((o) => o.status === "ready");
		if (!next) throw new UnauthorizedError();
		await app.main.query(`UPDATE sessions SET org_id = $2 WHERE token_hash = $1`, [hashToken(token), next.id]);
		row = await find();
		if (!row || !hasAccess(row)) throw new UnauthorizedError();
	}
	if (Date.now() - row.last_seen_at.getTime() > SESSION_TOUCH_EVERY_MS) {
		await app.main.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [hashToken(token)]);
	}
	return toUser(row);
}

export async function logout(app: App, token: string): Promise<void> {
	await app.main.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/**
 * Lets a logged-in user change their own password. Their other sessions are
 * ended; the current one is kept.
 */
export async function changePassword(app: App, user: User, keepToken: string, input: PasswordChange): Promise<void> {
	const row = await queryRow<{ password_hash: string }>(app.main, `SELECT password_hash FROM users WHERE id = $1`, [user.id]);
	if (!row) throw new Error("change password: user not found");
	const v = new ValidationError();
	// Someone who must choose a new password has just logged in with the old one: it isn't asked again.
	if (!user.must_change_password && !(await passwordMatches(row.password_hash, input.current_password))) v.add("current_password", "is incorrect");
	validatePassword(v, "new_password", input.new_password);
	if (user.must_change_password && v.details.length === 0 && (await passwordMatches(row.password_hash, input.new_password))) v.add("new_password", "must be different from the one you logged in with");
	v.throwIfAny();
	const newHash = await hashPassword(input.new_password);
	await withTx(app.main, {}, async (tx) => {
		await tx.query(`UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1`, [user.id, newHash]);
		await tx.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [user.id, hashToken(keepToken)]);
	});
}
