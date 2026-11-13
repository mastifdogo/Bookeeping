// Entities: the people and businesses the books deal with. One list, shared
// by Ledger (the vendor on an expense, the entity on an entry) and by every
// module (ctx.entities), so the same customer or vendor isn't kept in three
// places under three spellings. Each is a customer, a vendor, or both.
// Like accounts they are never deleted, only made inactive: entries point at
// them.

import type { App } from "./app.ts";
import { isPgError, queryRow, queryRows } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { checkText, trimSpace } from "./text.ts";

export const ENTITY_ROLES = ["customer", "vendor"] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];

export interface Entity {
	id: number;
	name: string;
	is_customer: boolean;
	is_vendor: boolean;
	email: string;
	phone: string;
	address: string;
	notes: string;
	is_active: boolean;
	created_at: Date;
	updated_at: Date;
}

export interface EntityInput {
	name?: unknown;
	is_customer?: unknown;
	is_vendor?: unknown;
	email?: unknown;
	phone?: unknown;
	address?: unknown;
	notes?: unknown;
	is_active?: unknown;
}

const COLUMNS = `id, name, is_customer, is_vendor, email, phone, address, notes, is_active, created_at, updated_at`;
type Row = Omit<Entity, "id"> & { id: bigint };
const toEntity = (r: Row): Entity => ({ ...r, id: Number(r.id) });
const TEXT_FIELDS = { email: 200, phone: 100, address: 1000, notes: 2000 } as const;
const KEYS = ["name", "is_customer", "is_vendor", "is_active", ...Object.keys(TEXT_FIELDS)];

function check(v: ValidationError, input: EntityInput, creating: boolean): void {
	const o = input as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!KEYS.includes(k)) v.add(k, "unknown field");
	if (creating || o.name !== undefined) {
		if (typeof o.name !== "string") v.add("name", "is required");
		else checkText(v, "name", o.name, 1, 200);
	}
	for (const k of ["is_customer", "is_vendor", "is_active"]) if (o[k] !== undefined && typeof o[k] !== "boolean") v.add(k, "must be true or false");
	for (const [k, max] of Object.entries(TEXT_FIELDS)) {
		if (o[k] === undefined) continue;
		if (typeof o[k] !== "string") v.add(k, "must be text");
		else checkText(v, k, o[k] as string, 0, max);
	}
}

const duplicate = (name: string) => new ConflictError(`there is already a customer or vendor called ${name}; add the other role to it instead`);

export interface EntityFilter {
	/** Only customers, or only vendors (an entity that is both matches either). */
	role?: EntityRole | null;
	/** Part of the name. */
	q?: string | null;
	includeInactive?: boolean;
}

export async function listEntities(app: App, f: EntityFilter = {}): Promise<Entity[]> {
	const rows = await queryRows<Row>(
		app.db,
		`SELECT ${COLUMNS} FROM entities
		  WHERE ($1 OR is_active)
		    AND ($2::text IS NULL OR ($2 = 'customer' AND is_customer) OR ($2 = 'vendor' AND is_vendor))
		    AND ($3::text IS NULL OR position(lower($3) IN lower(name)) > 0)
		  ORDER BY lower(name)`,
		[f.includeInactive === true, f.role ?? null, f.q ? f.q.trim() || null : null],
	);
	return rows.map(toEntity);
}

export async function getEntity(app: App, id: number): Promise<Entity> {
	const r = Number.isSafeInteger(id) && id > 0 ? await queryRow<Row>(app.db, `SELECT ${COLUMNS} FROM entities WHERE id = $1`, [id]) : null;
	if (!r) throw new NotFoundError();
	return toEntity(r);
}

/** The entity with that name (any capitalisation), or null. */
export async function findEntity(app: App, name: string): Promise<Entity | null> {
	const r = await queryRow<Row>(app.db, `SELECT ${COLUMNS} FROM entities WHERE lower(name) = lower($1)`, [trimSpace(String(name))]);
	return r ? toEntity(r) : null;
}

export async function createEntity(app: App, input: EntityInput): Promise<Entity> {
	const v = new ValidationError();
	check(v, input, true);
	if (input.is_customer !== true && input.is_vendor !== true) v.add("is_customer", "choose customer, vendor or both");
	v.throwIfAny();
	const s = (k: keyof typeof TEXT_FIELDS) => trimSpace((input[k] as string | undefined) ?? "");
	try {
		const r = await queryRow<Row>(
			app.db,
			`INSERT INTO entities (name, is_customer, is_vendor, email, phone, address, notes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
			[trimSpace(input.name as string), input.is_customer === true, input.is_vendor === true, s("email"), s("phone"), s("address"), s("notes")],
		);
		return toEntity(r!);
	} catch (err) {
		if (isPgError(err) && err.constraint === "entities_name_unique") throw duplicate(trimSpace(input.name as string));
		throw err;
	}
}

export async function updateEntity(app: App, id: number, input: EntityInput): Promise<Entity> {
	const v = new ValidationError();
	check(v, input, false);
	if (Object.keys(input).length === 0) v.add("", "nothing to change");
	const cur = await getEntity(app, id);
	const next = { ...cur, ...(input as Partial<Entity>) };
	if (!next.is_customer && !next.is_vendor) v.add("is_vendor", "an entity is a customer, a vendor or both");
	v.throwIfAny();
	try {
		const r = await queryRow<Row>(
			app.db,
			`UPDATE entities SET name = $2, is_customer = $3, is_vendor = $4, email = $5, phone = $6, address = $7, notes = $8, is_active = $9, updated_at = now()
			  WHERE id = $1 RETURNING ${COLUMNS}`,
			[id, trimSpace(next.name), next.is_customer, next.is_vendor, trimSpace(next.email), trimSpace(next.phone), trimSpace(next.address), trimSpace(next.notes), next.is_active],
		);
		return toEntity(r!);
	} catch (err) {
		if (isPgError(err) && err.constraint === "entities_name_unique") throw duplicate(trimSpace(next.name));
		throw err;
	}
}

/**
 * The entity with that name in that role, created or given the role if
 * needed (for modules: "this bill is from Hydro" without checking first).
 * An inactive one is made active again.
 */
export async function ensureEntity(app: App, name: string, role: EntityRole, details: EntityInput = {}): Promise<Entity> {
	if (!ENTITY_ROLES.includes(role)) {
		const v = new ValidationError();
		v.add("role", "must be customer or vendor");
		v.throwIfAny();
	}
	const flag = role === "customer" ? "is_customer" : "is_vendor";
	const cur = await findEntity(app, name);
	if (!cur) {
		try {
			return await createEntity(app, { ...details, name, [flag]: true });
		} catch (err) {
			// Someone added it in the meantime.
			const again = err instanceof ConflictError ? await findEntity(app, name) : null;
			if (!again) throw err;
			return again[flag] && again.is_active ? again : updateEntity(app, again.id, { [flag]: true, is_active: true });
		}
	}
	return cur[flag] && cur.is_active ? cur : updateEntity(app, cur.id, { [flag]: true, is_active: true });
}
