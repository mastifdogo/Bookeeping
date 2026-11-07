// Settings for services Ledger connects to on behalf of the user and of
// modules (an AI provider, Gmail). They hold API keys and OAuth tokens, so
// they live in INTEGRATIONS_DIR (default /var/lib/ledger/integrations, owned
// by the ledger user, mode 0700), outside the database and so outside the
// backups.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { ConflictError } from "./errors.ts";
import { readSmallFile, writeFileAtomic } from "./update.ts";

export function integrationsDir(): string {
	return process.env.INTEGRATIONS_DIR || "/var/lib/ledger/integrations";
}

export async function integrationsAvailable(dir: string): Promise<boolean> {
	return (await fsp.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

export async function requireIntegrations(dir: string): Promise<void> {
	if (!(await integrationsAvailable(dir))) {
		throw new ConflictError(`integrations are not set up on this server (${dir} is missing); update Ledger or run deploy/install.sh from a current release`);
	}
}

export async function readIntegration<T extends object>(dir: string, name: string, defaults: T): Promise<T> {
	const text = await readSmallFile(path.join(dir, `${name}.json`));
	if (text === null) return structuredClone(defaults);
	try {
		return { ...structuredClone(defaults), ...(JSON.parse(text) as Partial<T>) };
	} catch {
		return structuredClone(defaults);
	}
}

export async function writeIntegration(dir: string, name: string, value: object): Promise<void> {
	await writeFileAtomic(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2) + "\n", 0o600);
}

/** A list of module ids from a request: lowercase ids, no duplicates. */
export function moduleIdList(v: unknown): string[] | null {
	if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(x))) return null;
	return [...new Set(v as string[])].sort();
}
