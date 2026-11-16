// The root console: a read-only live view of what the server does, for an
// admin in root mode to watch and debug. Each request and every SQL
// statement it runs (with its timing, row count or error) is sent to the
// consoles that are open, by default only for the session that made the
// request. Nothing is kept: with no console open, nothing is recorded.
//
// Values that could be secrets are not shown: password hashes, session
// token hashes and other binary values, and JSON with a key that looks like
// a token, password, secret or API key.

import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export interface ConsoleEvent {
	/** Milliseconds since the epoch. */
	t: number;
	kind: "request" | "response" | "sql" | "sql-error" | "info";
	/** The request it belongs to ("" for background work). */
	request: string;
	/** The database the statement ran in. */
	db?: string;
	text: string;
	params?: string[];
	ms?: number;
	rows?: number | null;
	status?: number;
}

interface Context {
	/** sha-256 of the session token, hex ("" without a session). */
	session: string;
	request: string;
}

interface Listener {
	/** Only this session's requests; null for everything on the server. */
	session: string | null;
	send: (e: ConsoleEvent) => void;
}

const context = new AsyncLocalStorage<Context>();
const listeners = new Set<Listener>();

/** Runs fn with the request's identity, so the statements it runs are tagged with it. */
export function withConsoleContext<T>(session: string, request: string, fn: () => T): T {
	return context.run({ session, request }, fn);
}

/** Is any console open (cheap check before building an event)? */
export const consoleOpen = () => listeners.size > 0;

export function emit(e: Omit<ConsoleEvent, "t" | "request"> & { request?: string }, session = context.getStore()?.session ?? ""): void {
	if (listeners.size === 0) return;
	const ev: ConsoleEvent = { t: Date.now(), request: context.getStore()?.request ?? "", ...e };
	for (const l of listeners) {
		if (l.session !== null && l.session !== session) continue;
		try {
			l.send(ev);
		} catch {
			// a closed stream: its close handler removes it
		}
	}
}

/** Adds a console; returns the function that removes it. */
export function listen(session: string | null, send: (e: ConsoleEvent) => void): () => void {
	const l: Listener = { session, send };
	listeners.add(l);
	return () => listeners.delete(l);
}

/** Closes the consoles of a session (root mode turned off, logged out). */
const closers = new Map<string, Set<() => void>>();
export function onSessionClose(session: string, close: () => void): () => void {
	const set = closers.get(session) ?? new Set();
	set.add(close);
	closers.set(session, set);
	return () => set.delete(close);
}
export function closeSession(session: string): void {
	for (const c of closers.get(session) ?? []) c();
	closers.delete(session);
}

const SECRET_JSON = /"[^"]*(?:token|secret|password|passwd|api_?key|private_?key|refresh)[^"]*"\s*:/i;

/** A parameter as the console shows it. */
export function showParam(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<${v.length} bytes>`;
	if (v instanceof Date) return v.toISOString();
	if (Array.isArray(v)) return `[${v.slice(0, 20).map(showParam).join(", ")}${v.length > 20 ? `, … ${v.length - 20} more` : ""}]`;
	const s = typeof v === "object" ? JSON.stringify(v) : String(v);
	if (/^\$2[aby]\$\d\d\$/.test(s)) return "<password hash>";
	if (SECRET_JSON.test(s)) return "<hidden: may hold a secret>";
	return s.length > 300 ? `${s.slice(0, 300)}… (${s.length} chars)` : s;
}

function sqlText(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > 4000 ? `${t.slice(0, 4000)}…` : t;
}

let patched = false;

/** Hooks pg's Client.query once, so every statement can be shown while a console is open. */
export function installConsole(): void {
	if (patched) return;
	patched = true;
	const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown; database?: string };
	const original = proto.query;
	proto.query = function (this: { database?: string }, ...args: unknown[]) {
		if (listeners.size === 0) return original.apply(this, args);
		const first = args[0] as string | { text?: string; values?: unknown[] } | undefined;
		const text = typeof first === "string" ? first : (first?.text ?? "");
		const values = (Array.isArray(args[1]) ? args[1] : typeof first === "object" ? first?.values : undefined) as unknown[] | undefined;
		const db = this.database;
		const store = context.getStore();
		const start = performance.now();
		const base = { db, text: sqlText(text), params: values?.map(showParam), request: store?.request ?? "" };
		const session = store?.session ?? "";
		const ms = () => Math.round((performance.now() - start) * 10) / 10;
		const done = (err: Error | null | undefined, r?: { rowCount?: number | null }) =>
			err ? emit({ kind: "sql-error", ...base, ms: ms(), text: `${base.text}\n  ✗ ${err.message}` }, session) : emit({ kind: "sql", ...base, ms: ms(), rows: r?.rowCount ?? null }, session);
		// pg's Pool hands the client a callback; other callers use the promise.
		const last = args.length - 1;
		if (typeof args[last] === "function") {
			const cb = args[last] as (err: Error | null, r: unknown) => void;
			args[last] = (err: Error | null, r: { rowCount?: number | null }) => {
				done(err, r);
				cb(err, r);
			};
		}
		const result = original.apply(this, args);
		if (result && typeof (result as Promise<unknown>).then === "function") {
			(result as Promise<{ rowCount?: number | null }>).then(
				(r) => done(null, r),
				(err: Error) => done(err),
			);
		}
		return result;
	};
}
