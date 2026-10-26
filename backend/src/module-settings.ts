// Settings that modules declare in ledger-module.json. Ledger shows them as a
// form on the module's own Settings tab, validates and stores the values
// (module_settings), and hands them to the module as ctx.settings.

import type { Queryable } from "./db.ts";
import { queryRow } from "./db.ts";
import { ValidationError } from "./errors.ts";

export type FieldType = "text" | "textarea" | "secret" | "number" | "boolean" | "select";
const FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "secret", "number", "boolean", "select"];

export interface SettingsField {
	key: string;
	label: string;
	type: FieldType;
	help: string;
	required: boolean;
	default: string | number | boolean | null;
	/** select: the choices. */
	options: { value: string; label: string }[];
	/** number: bounds. */
	min: number | null;
	max: number | null;
}

export interface SettingsSpec {
	fields: SettingsField[];
	/** Optional extra page inside the module's ui directory, shown below the form. */
	page: string | null;
}

export type SettingValue = string | number | boolean | null;

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 50;
const PAGE_RE = /^(?!\/)(?!.*(?:^|\/)\.)[A-Za-z0-9_.\/-]{1,200}$/;
const TEXT_MAX: Record<string, number> = { text: 500, textarea: 10_000, secret: 2000 };

/** Validates the manifest's "settings" member; adds problems to err. */
export function parseSettingsSpec(v: unknown, err: ValidationError, hasUi: boolean): SettingsSpec | null {
	if (v === undefined || v === null) return null;
	const bad = (msg: string) => {
		err.add("settings", msg);
		return null;
	};
	if (typeof v !== "object" || Array.isArray(v)) return bad('must be {"fields": [...], "page": "..."}');
	const o = v as Record<string, unknown>;
	for (const k of Object.keys(o)) if (k !== "fields" && k !== "page") return bad(`unknown field ${JSON.stringify(k)}`);
	const page = o.page === undefined || o.page === null ? null : o.page;
	if (page !== null && (typeof page !== "string" || !PAGE_RE.test(page))) return bad("page must be a file inside the ui directory");
	if (page !== null && !hasUi) return bad("page needs ui");
	const list = o.fields === undefined ? [] : o.fields;
	if (!Array.isArray(list) || list.length > MAX_FIELDS) return bad(`fields must be a list of at most ${MAX_FIELDS}`);
	const fields: SettingsField[] = [];
	const seen = new Set<string>();
	for (const [i, raw] of list.entries()) {
		const p = `settings.fields[${i}]`;
		const f = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
		if (!f) return bad(`${p} must be an object`);
		const allowed = ["key", "label", "type", "help", "required", "default", "options", "min", "max"];
		const extra = Object.keys(f).find((k) => !allowed.includes(k));
		if (extra) return bad(`${p}: unknown field ${JSON.stringify(extra)}`);
		if (typeof f.key !== "string" || !KEY_RE.test(f.key)) return bad(`${p}.key must be lowercase letters, digits or _ (up to 40), starting with a letter`);
		if (seen.has(f.key)) return bad(`${p}.key ${f.key} is used twice`);
		seen.add(f.key);
		const type = (f.type ?? "text") as FieldType;
		if (!FIELD_TYPES.includes(type)) return bad(`${p}.type must be one of ${FIELD_TYPES.join(", ")}`);
		const label = f.label ?? f.key;
		if (typeof label !== "string" || !/^[^\u0000-\u001f]{1,60}$/.test(label)) return bad(`${p}.label must be 1-60 characters`);
		const help = f.help ?? "";
		if (typeof help !== "string" || help.length > 300) return bad(`${p}.help must be at most 300 characters`);
		if (f.required !== undefined && typeof f.required !== "boolean") return bad(`${p}.required must be true or false`);
		const num = (k: "min" | "max") => {
			const x = f[k];
			if (x === undefined || x === null) return null;
			if (type !== "number" || typeof x !== "number" || !Number.isFinite(x)) return undefined;
			return x;
		};
		const min = num("min");
		const max = num("max");
		if (min === undefined || max === undefined) return bad(`${p}: min and max are numbers, for number fields only`);
		let options: { value: string; label: string }[] = [];
		if (type === "select") {
			if (!Array.isArray(f.options) || f.options.length === 0 || f.options.length > 100) return bad(`${p}.options must list 1-100 choices`);
			for (const x of f.options) {
				const opt = typeof x === "string" ? { value: x, label: x } : x && typeof x === "object" ? (x as Record<string, unknown>) : null;
				if (!opt || typeof opt.value !== "string" || opt.value.length > 100 || (opt.label !== undefined && (typeof opt.label !== "string" || opt.label.length > 100))) {
					return bad(`${p}.options: each choice is a string or {"value", "label"}`);
				}
				options.push({ value: opt.value, label: (opt.label as string | undefined) ?? opt.value });
			}
		} else if (f.options !== undefined) {
			return bad(`${p}.options is for select fields only`);
		}
		const field: SettingsField = { key: f.key, label, type, help, required: f.required === true, default: null, options, min, max };
		if (f.default !== undefined && f.default !== null) {
			if (type === "secret") return bad(`${p}: secret fields can't have a default`);
			const e = new ValidationError();
			field.default = checkValue(field, f.default, e);
			if (e.details.length) return bad(`${p}.default ${e.details[0]!.message}`);
		}
		fields.push(field);
	}
	return { fields, page };
}

/** Validates one value for a field; adds a problem to err and returns null when invalid. */
function checkValue(f: SettingsField, v: unknown, err: ValidationError): SettingValue {
	const fail = (msg: string) => {
		err.add(f.key, msg);
		return null;
	};
	switch (f.type) {
		case "boolean":
			return typeof v === "boolean" ? v : fail("must be true or false");
		case "number": {
			if (typeof v !== "number" || !Number.isFinite(v)) return fail("must be a number");
			if (f.min !== null && v < f.min) return fail(`must be at least ${f.min}`);
			if (f.max !== null && v > f.max) return fail(`must be at most ${f.max}`);
			return v;
		}
		case "select":
			return typeof v === "string" && f.options.some((o) => o.value === v) ? v : fail("must be one of the choices");
		default: {
			if (typeof v !== "string") return fail("must be text");
			if (v.length > TEXT_MAX[f.type]!) return fail(`must be at most ${TEXT_MAX[f.type]} characters`);
			if (f.type !== "textarea" && /[\u0000-\u001f]/.test(v)) return fail("must be a single line");
			return v;
		}
	}
}

async function stored(db: Queryable, moduleId: string): Promise<Record<string, SettingValue>> {
	const r = await queryRow<{ values: Record<string, SettingValue> }>(db, `SELECT "values" FROM module_settings WHERE module_id = $1`, [moduleId]);
	return r?.values ?? {};
}

/** The module's values with defaults filled in (secrets included): what ctx.settings.get() returns. */
export async function moduleValues(db: Queryable, moduleId: string, spec: SettingsSpec): Promise<Record<string, SettingValue>> {
	const s = await stored(db, moduleId);
	const out: Record<string, SettingValue> = {};
	for (const f of spec.fields) out[f.key] = s[f.key] !== undefined && s[f.key] !== null ? s[f.key]! : f.default;
	return out;
}

/** For the browser: secrets are never sent back, only whether they are set. */
export async function publicSettings(db: Queryable, moduleId: string, spec: SettingsSpec) {
	const values = await moduleValues(db, moduleId, spec);
	const secrets_set: Record<string, boolean> = {};
	for (const f of spec.fields) {
		if (f.type === "secret") {
			secrets_set[f.key] = typeof values[f.key] === "string" && values[f.key] !== "";
			values[f.key] = null;
		}
	}
	return { fields: spec.fields, values, secrets_set, page: spec.page ? `/m/${moduleId}/${spec.page}` : null };
}

/**
 * Saves a change. Keys not given keep their value; null resets to the
 * default. For secrets, null (or leaving the key out) keeps the stored one and
 * "" clears it. Required fields must end up with a value.
 */
export async function saveSettings(db: Queryable, moduleId: string, spec: SettingsSpec, change: unknown, userId: number | null): Promise<void> {
	const err = new ValidationError();
	if (!change || typeof change !== "object" || Array.isArray(change)) {
		err.add("values", "must be an object");
		err.throwIfAny();
	}
	const current = await stored(db, moduleId);
	const next: Record<string, SettingValue> = {};
	for (const f of spec.fields) if (current[f.key] !== undefined) next[f.key] = current[f.key]!;
	for (const [k, v] of Object.entries(change as Record<string, unknown>)) {
		const f = spec.fields.find((x) => x.key === k);
		if (!f) {
			err.add(k, "is not a setting of this module");
			continue;
		}
		if (v === null || v === undefined) {
			if (f.type !== "secret") delete next[k];
			continue;
		}
		const val = checkValue(f, v, err);
		if (val === null) continue;
		if (f.type === "secret" && val === "") delete next[k];
		else next[k] = val;
	}
	for (const f of spec.fields) {
		const v = next[f.key] ?? f.default;
		if (f.required && (v === null || v === "")) err.add(f.key, "is required");
	}
	err.throwIfAny();
	await db.query(
		`INSERT INTO module_settings (module_id, "values", updated_by) VALUES ($1, $2::jsonb, $3)
		 ON CONFLICT (module_id) DO UPDATE SET "values" = EXCLUDED."values", updated_at = now(), updated_by = EXCLUDED.updated_by`,
		[moduleId, JSON.stringify(next), userId],
	);
}
