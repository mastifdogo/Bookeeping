// Modules: extensions installed from GitHub repositories (invoicing, an LLM
// gateway, dashboards, ...). Shared by the app (which records which modules
// you want and runs the installed ones; module-host.ts) and the root
// installer (module-installer.ts).
//
//   /var/lib/ledger/update-config/modules.json  the modules you want (written by the app)
//   /var/lib/ledger/modules/<id>/                installed code (root-owned, read-only to the app)
//   /var/lib/ledger/update-status/modules.json  the installer's per-module results
//
// A module is a repository with a ledger-module.json manifest at its root,
// published as GitHub Releases. See docs/MODULES.md.

import { parseSettingsSpec, type SettingsSpec } from "./module-settings.ts";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ValidationError } from "./errors.ts";
import { isNewer, parseVersion, readSmallFile, writeFileAtomic, type UpdateDirs } from "./update.ts";

export const MANIFEST_FILE = "ledger-module.json";
/** Written by the installer next to the manifest: where the code came from. */
export const SOURCE_FILE = ".ledger-module-source.json";
export const DESIRED_FILE = "modules.json";
export const MODULES_RUN_NOW_FILE = "modules-run-now";
export const MODULES_STATUS_FILE = "modules.json";
export const MAX_MODULES = 50;

export function modulesDir(): string {
	return process.env.MODULES_DIR || "/var/lib/ledger/modules";
}

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface ModuleManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	/** Minimum Ledger version, ">=x.y.z" (optional). */
	ledger: string | null;
	/** ES module exporting `default async function register(ctx)` (optional). */
	server: string | null;
	/** Directory with index.html, served at /m/<id>/ (optional). */
	ui: string | null;
	/** Sidebar entry opening the UI (optional; needs ui). `icon` names one of Ledger's sidebar icons. */
	nav: { label: string; icon: string | null } | null;
	/** Directory of NNN_name.sql files, applied in the module's own schema (optional). */
	migrations: string | null;
	/** Settings shown on the module's Settings tab (optional). */
	settings: SettingsSpec | null;
}

/** A path inside the module: relative, no "..", no hidden segments. */
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.)[A-Za-z0-9_.\/-]{1,200}$/;

/** Validates a parsed ledger-module.json; throws ValidationError. */
export function validateManifest(v: unknown): ModuleManifest {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	const allowed = ["id", "name", "version", "description", "ledger", "server", "ui", "nav", "migrations", "settings"];
	for (const k of Object.keys(o)) if (!allowed.includes(k)) err.add(k, "unknown field");
	const str = (k: string, re: RegExp | null, max: number, required: boolean): string | null => {
		const x = o[k];
		if (x === undefined || x === null) {
			if (required) err.add(k, "is required");
			return null;
		}
		if (typeof x !== "string" || x.length > max || (re && !re.test(x))) {
			err.add(k, "is not valid");
			return null;
		}
		return x;
	};
	const id = str("id", MODULE_ID_RE, 32, true);
	const name = str("name", /^[^\u0000-\u001f]{1,60}$/, 60, true);
	const version = str("version", /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 40, true);
	const description = str("description", /^[^\u0000-\u0008\u000b-\u001f]{0,500}$/, 500, false) ?? "";
	const ledger = str("ledger", /^>=v?\d+\.\d+\.\d+$/, 30, false);
	const server = str("server", REL_PATH_RE, 200, false);
	const ui = str("ui", REL_PATH_RE, 200, false);
	const migrations = str("migrations", REL_PATH_RE, 200, false);
	let nav: { label: string; icon: string | null } | null = null;
	if (o.nav !== undefined && o.nav !== null) {
		const n = o.nav as Record<string, unknown>;
		// An icon name Ledger doesn't know is accepted and shown as the generic module icon,
		// so a module can name icons added in later Ledger versions.
		const icon = n.icon === undefined || n.icon === null ? null : n.icon;
		if (
			typeof n !== "object" ||
			typeof n.label !== "string" ||
			!/^[^\u0000-\u001f]{1,24}$/.test(n.label) ||
			(icon !== null && (typeof icon !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(icon))) ||
			Object.keys(n).some((k) => k !== "label" && k !== "icon")
		) {
			err.add("nav", 'must be {"label": "...", "icon": "..."} with a label of at most 24 characters and an optional icon name');
		} else if (ui === null) {
			err.add("nav", "needs ui");
		} else {
			nav = { label: n.label, icon: icon as string | null };
		}
	}
	const settings = parseSettingsSpec(o.settings, err, ui !== null);
	err.throwIfAny();
	return { id: id!, name: name!, version: version!, description, ledger, server, ui, nav, migrations, settings };
}

/** Whether this Ledger version satisfies a manifest's "ledger" requirement. Dev builds accept everything. */
export function compatible(m: ModuleManifest, ledgerVersion: string): boolean {
	if (!m.ledger || !parseVersion(ledgerVersion)) return true;
	const min = m.ledger.slice(2);
	return !isNewer(min.startsWith("v") ? min : `v${min}`, ledgerVersion.startsWith("v") ? ledgerVersion : `v${ledgerVersion}`);
}

/** Accepts "owner/name" or a github.com URL; returns "owner/name" or null. */
export function normalizeRepo(input: string): string | null {
	let s = input.trim();
	const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(s);
	if (m) s = m[1]!;
	return REPO_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// The modules you want (desired state)
// ---------------------------------------------------------------------------

export interface DesiredModule {
	repo: string;
	/** Filled in once known (from the preview), so removal can find the installed copy. */
	id: string | null;
}

export function validateDesired(v: unknown): DesiredModule[] {
	if (!Array.isArray(v) || v.length > MAX_MODULES) throw new Error("modules.json must be a list");
	return v.map((x) => {
		const o = x as Record<string, unknown>;
		const repo = typeof o?.repo === "string" ? normalizeRepo(o.repo) : null;
		const id = o?.id === null || o?.id === undefined ? null : typeof o.id === "string" && MODULE_ID_RE.test(o.id) ? o.id : undefined;
		if (!repo || id === undefined) throw new Error("modules.json has an invalid entry");
		return { repo, id };
	});
}

export async function readDesired(dirs: UpdateDirs): Promise<DesiredModule[]> {
	const text = await readSmallFile(path.join(dirs.config, DESIRED_FILE));
	if (text === null) return [];
	try {
		return validateDesired(JSON.parse(text));
	} catch {
		return [];
	}
}

export async function writeDesired(dirs: UpdateDirs, list: DesiredModule[]): Promise<void> {
	await writeFileAtomic(path.join(dirs.config, DESIRED_FILE), JSON.stringify(list, null, 2) + "\n", 0o640);
}

export async function requestModuleSync(dirs: UpdateDirs): Promise<void> {
	await writeFileAtomic(path.join(dirs.config, MODULES_RUN_NOW_FILE), new Date().toISOString() + "\n", 0o640);
}

// ---------------------------------------------------------------------------
// Installed modules and the installer's results
// ---------------------------------------------------------------------------

export interface ModuleSource {
	repo: string;
	tag: string;
	installed_at: string;
}

export interface InstalledModule {
	dir: string;
	manifest: ModuleManifest;
	source: ModuleSource | null;
}

/** Every valid installed module (invalid directories are skipped). */
export async function scanInstalled(dir: string): Promise<InstalledModule[]> {
	const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: InstalledModule[] = [];
	for (const e of entries) {
		if (!MODULE_ID_RE.test(e.name)) continue;
		const mdir = path.join(dir, e.name);
		// Follow symlinks so a module linked in for local development loads.
		if (!e.isDirectory() && !(e.isSymbolicLink() && (await fsp.stat(mdir).catch(() => null))?.isDirectory())) continue;
		const text = await readSmallFile(path.join(mdir, MANIFEST_FILE));
		if (text === null) continue;
		let manifest: ModuleManifest;
		try {
			manifest = validateManifest(JSON.parse(text));
		} catch {
			continue;
		}
		if (manifest.id !== e.name) continue;
		let source: ModuleSource | null = null;
		const s = await readSmallFile(path.join(mdir, SOURCE_FILE));
		if (s !== null) {
			try {
				source = JSON.parse(s) as ModuleSource;
			} catch {
				// ignore
			}
		}
		out.push({ dir: mdir, manifest, source });
	}
	return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export interface ModuleResult {
	repo: string;
	id: string | null;
	state: "installed" | "updated" | "unchanged" | "removed" | "error";
	version: string | null;
	message: string;
	at: string;
}

export async function readModuleResults(dirs: UpdateDirs): Promise<ModuleResult[]> {
	const text = await readSmallFile(path.join(dirs.status, MODULES_STATUS_FILE));
	if (text === null) return [];
	try {
		const v = JSON.parse(text);
		return Array.isArray(v) ? (v as ModuleResult[]) : [];
	} catch {
		return [];
	}
}
