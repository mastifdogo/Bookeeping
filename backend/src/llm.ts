// The AI provider set under Settings → LLM API, shared by Ledger and modules
// (ctx.llm). One place for the API key, model and limits, and a usage log per
// module. Providers are called over HTTP with fetch (no SDKs):
//
//   anthropic  Claude through the Messages API (structured outputs for JSON)
//   ollama     a local model through Ollama's /api/chat
//   openai     any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...)

import type { App } from "./app.ts";
import { HttpError, ValidationError } from "./errors.ts";
import { log } from "./log.ts";
import { moduleIdList, readIntegration } from "./integrations.ts";

export const PROVIDERS = ["anthropic", "ollama", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const EFFORTS = ["low", "medium", "high"] as const;

export const DEFAULTS: Record<Provider, { model: string; base_url: string }> = {
	anthropic: { model: "claude-sonnet-5-5", base_url: "https://api.anthropic.com" },
	ollama: { model: "qwen3:14b", base_url: "http://127.0.0.1:11434" },
	openai: { model: "", base_url: "http://127.0.0.1:1234/v1" },
};

/** Models that accept server-side refusal fallbacks. */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const TIMEOUT_MS = 180_000;
const MAX_TOKENS_LIMIT = 64_000;

/** What a connection is used for: text (chat, JSON) and/or images (pictures, PDFs). */
export const USES = ["text", "images"] as const;
export type Use = (typeof USES)[number];
const MAX_CONNECTIONS = 10;

/** One provider, model and key. */
export interface LlmConnection {
	/** Short permanent id, e.g. "main" or "vision"; modules may ask for one by id. */
	id: string;
	name: string;
	provider: Provider;
	model: string;
	base_url: string;
	api_key: string;
	effort: (typeof EFFORTS)[number];
	/** Upper bound on max_tokens for any one call. */
	max_tokens: number;
	/** Requests it serves by default: the first connection listing a use gets it. */
	uses: Use[];
}

export interface LlmConfig {
	connections: LlmConnection[];
	/** Modules allowed to use them (ctx.llm). Ledger itself always may. */
	allow_modules: string[];
}

export const LLM_DEFAULTS: LlmConfig = { connections: [], allow_modules: [] };

/** Reads Settings → LLM API; the single-provider file of Ledger ≤ 0.11.1 becomes one connection used for everything. */
export async function readLlmConfig(dir: string): Promise<LlmConfig> {
	const raw = (await readIntegration(dir, "llm", LLM_DEFAULTS)) as LlmConfig & Partial<Omit<LlmConnection, "id" | "name" | "uses">> & { provider?: string };
	if (Array.isArray(raw.connections) && raw.connections.length > 0) return { connections: raw.connections, allow_modules: raw.allow_modules ?? [] };
	const connections: LlmConnection[] = [];
	if (raw.provider && PROVIDERS.includes(raw.provider as Provider)) {
		connections.push({
			id: "main",
			name: "Main",
			provider: raw.provider as Provider,
			model: raw.model ?? "",
			base_url: raw.base_url ?? "",
			api_key: raw.api_key ?? "",
			effort: raw.effort ?? "low",
			max_tokens: raw.max_tokens ?? 16_000,
			uses: ["text", "images"],
		});
	}
	return { connections, allow_modules: raw.allow_modules ?? [] };
}

export function connectionReady(c: LlmConnection): boolean {
	if (c.provider === "anthropic") return c.api_key !== "";
	return c.model !== "";
}

/** The connection a request goes to: by id, or the first ready one for the use. */
export function pickConnection(c: LlmConfig, want: string): LlmConnection | null {
	const byId = c.connections.find((x) => x.id === want);
	if (byId) return connectionReady(byId) ? byId : null;
	return c.connections.find((x) => x.uses.includes(want as Use) && connectionReady(x)) ?? null;
}

/** Whether anything can answer text requests (or the given use). */
export function llmReady(c: LlmConfig, use: Use = "text"): boolean {
	return pickConnection(c, use) !== null;
}

/** Settings without the keys, for the browser. */
export function publicLlmConfig(c: LlmConfig) {
	return {
		connections: c.connections.map(({ api_key, ...rest }) => ({ ...rest, has_api_key: api_key !== "", configured: connectionReady({ api_key, ...rest }) })),
		allow_modules: c.allow_modules,
		configured: llmReady(c, "text"),
		images_configured: llmReady(c, "images"),
		providers: PROVIDERS,
		uses: USES,
		defaults: DEFAULTS,
	};
}

/**
 * Applies a change from Settings → LLM API: { connections?, allow_modules? }.
 * connections replaces the list; a connection's api_key omitted or null keeps
 * the saved key of the connection with that id, "" clears it.
 */
export function applyLlmChange(c: LlmConfig, v: unknown): LlmConfig {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	for (const k of Object.keys(o)) if (k !== "connections" && k !== "allow_modules") err.add(k, "unknown field");
	const next = structuredClone(c);
	if (o.connections !== undefined) {
		if (!Array.isArray(o.connections) || o.connections.length > MAX_CONNECTIONS) {
			err.add("connections", `must be a list of at most ${MAX_CONNECTIONS} connections`);
		} else {
			const seen = new Set<string>();
			next.connections = o.connections.map((x, i) => {
				const f = (field: string) => `connections[${i}].${field}`;
				const k = (x && typeof x === "object" && !Array.isArray(x) ? x : {}) as Record<string, unknown>;
				for (const key of Object.keys(k)) {
					if (!["id", "name", "provider", "model", "base_url", "api_key", "effort", "max_tokens", "uses"].includes(key)) err.add(f(key), "unknown field");
				}
				const id = typeof k.id === "string" ? k.id.trim() : "";
				if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) err.add(f("id"), "must be 1-32 lowercase letters, digits or -, starting with a letter");
				else if (seen.has(id)) err.add(f("id"), "is used twice");
				else if ((USES as readonly string[]).includes(id)) err.add(f("id"), `can't be "${id}" (that names a use)`);
				seen.add(id);
				const name = typeof k.name === "string" ? k.name.trim() : "";
				if (name.length < 1 || name.length > 60) err.add(f("name"), "must be 1-60 characters");
				if (!PROVIDERS.includes(k.provider as Provider)) err.add(f("provider"), `must be one of ${PROVIDERS.join(", ")}`);
				const model = k.model === undefined ? "" : k.model;
				if (typeof model !== "string" || model.length > 200 || /\s/.test(model.trim())) err.add(f("model"), "must be a model name");
				const base = k.base_url === undefined ? "" : typeof k.base_url === "string" ? k.base_url.trim() : null;
				if (base === null || (base !== "" && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(base))) err.add(f("base_url"), "must be an http(s) URL");
				let key = c.connections.find((old) => old.id === id)?.api_key ?? "";
				if (k.api_key !== undefined && k.api_key !== null) {
					if (typeof k.api_key !== "string" || k.api_key.length > 500 || /\s/.test(k.api_key)) err.add(f("api_key"), "is not valid");
					else key = k.api_key;
				}
				const effort = k.effort === undefined ? "low" : k.effort;
				if (!EFFORTS.includes(effort as never)) err.add(f("effort"), "must be low, medium or high");
				const max = k.max_tokens === undefined ? 16_000 : k.max_tokens;
				if (!Number.isInteger(max) || (max as number) < 256 || (max as number) > MAX_TOKENS_LIMIT) err.add(f("max_tokens"), `must be 256 to ${MAX_TOKENS_LIMIT}`);
				const uses = k.uses === undefined ? [] : k.uses;
				if (!Array.isArray(uses) || uses.some((u) => !USES.includes(u as Use))) err.add(f("uses"), `must be a list of ${USES.join(", ")}`);
				return {
					id,
					name,
					provider: k.provider as Provider,
					model: typeof model === "string" ? model.trim() : "",
					base_url: (base ?? "").replace(/\/+$/, ""),
					api_key: key,
					effort: effort as LlmConnection["effort"],
					max_tokens: max as number,
					uses: Array.isArray(uses) ? USES.filter((u) => uses.includes(u)) : [],
				};
			});
		}
	}
	if (o.allow_modules !== undefined) {
		const list = moduleIdList(o.allow_modules);
		if (!list) err.add("allow_modules", "must be a list of module ids");
		else next.allow_modules = list;
	}
	err.throwIfAny();
	return next;
}

// ---------------------------------------------------------------------------
// Calling the provider
// ---------------------------------------------------------------------------

/** A failed call: shown to the user as it is, with HTTP status 502. */
export class LlmError extends HttpError {
	constructor(message: string, status = 502) {
		super(status, `AI: ${message}`, "llm_error");
	}
}

export interface LlmMessage {
	role: "user" | "assistant";
	content: string;
}

export interface LlmRequest {
	system?: string;
	/** A single user message... */
	prompt?: string;
	/** ...or a conversation (ending with a user message). */
	messages?: LlmMessage[];
	/** With a JSON schema the answer is parsed JSON (LlmResult.data). */
	schema?: object;
	maxTokens?: number;
	/** PDFs (base64), read by Claude; other providers get the text only. */
	documents?: { media_type: string; data: string; name?: string }[];
	/** Pictures (base64 PNG, JPEG, GIF or WebP) for the model to look at. */
	images?: { media_type: string; data: string }[];
	/**
	 * Which connection answers: a connection id, or a use ("text", "images").
	 * Default: "images" when the request has images or documents, else "text".
	 */
	connection?: string;
}

export interface LlmResult {
	text: string;
	data?: unknown;
	model: string;
	usage: { input_tokens: number | null; output_tokens: number | null };
}

function checkRequest(r: LlmRequest): LlmMessage[] {
	const err = new ValidationError();
	let messages: LlmMessage[] = [];
	if (r.messages !== undefined) {
		if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > 200) err.add("messages", "must be a non-empty list");
		else {
			messages = r.messages.map((m) => ({ role: m?.role, content: m?.content }) as LlmMessage);
			if (messages.some((m) => (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string")) err.add("messages", 'each is { role: "user" | "assistant", content: "..." }');
			else if (messages.at(-1)!.role !== "user") err.add("messages", "must end with a user message");
		}
	} else if (typeof r.prompt === "string" && r.prompt !== "") {
		messages = [{ role: "user", content: r.prompt }];
	} else {
		err.add("prompt", "give a prompt or messages");
	}
	if (r.system !== undefined && typeof r.system !== "string") err.add("system", "must be text");
	if (r.maxTokens !== undefined && (!Number.isInteger(r.maxTokens) || r.maxTokens < 1)) err.add("maxTokens", "must be a positive whole number");
	if (r.documents !== undefined && (!Array.isArray(r.documents) || r.documents.some((d) => typeof d?.data !== "string" || typeof d?.media_type !== "string"))) {
		err.add("documents", "each is { media_type, data (base64), name? }");
	}
	if (
		r.images !== undefined &&
		(!Array.isArray(r.images) || r.images.length > 20 || r.images.some((d) => typeof d?.data !== "string" || !IMAGE_TYPES.includes(d?.media_type)))
	) {
		err.add("images", `at most 20, each { media_type (${IMAGE_TYPES.join(", ")}), data (base64) }`);
	}
	if (r.connection !== undefined && typeof r.connection !== "string") err.add("connection", "must be a connection id, text or images");
	err.throwIfAny();
	return messages;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err: any) {
		const why = err?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : err?.cause?.message || err?.message || String(err);
		throw new LlmError(`could not reach ${new URL(url).host}: ${why}`);
	}
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	if (!res.ok) {
		const msg = json?.error?.message || json?.error || text.slice(0, 300) || res.statusText;
		throw new LlmError(`${new URL(url).host} answered ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
	}
	if (json === null) throw new LlmError(`${new URL(url).host} returned a non-JSON response`);
	return json;
}

function parseJsonText(text: string, who: string): unknown {
	const s = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(s);
	} catch {
		throw new LlmError(`${who} did not return valid JSON`);
	}
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

async function callProvider(c: LlmConnection, r: LlmRequest, messages: LlmMessage[]): Promise<LlmResult> {
	const maxTokens = Math.min(r.maxTokens ?? c.max_tokens, c.max_tokens);
	const provider = c.provider as Provider;
	const base = (c.base_url || DEFAULTS[provider].base_url).replace(/\/+$/, "");
	const model = c.model || DEFAULTS[provider].model;
	if (provider === "anthropic") {
		const docs = r.documents ?? [];
		const images = r.images ?? [];
		const msgs = messages.map((m, i) =>
			i === messages.length - 1 && m.role === "user" && docs.length + images.length > 0
				? {
						role: "user",
						// PDFs and pictures go before the text that refers to them.
						content: [
							...docs.map((d) => ({ type: "document", source: { type: "base64", media_type: d.media_type, data: d.data }, title: d.name || undefined })),
							...images.map((d) => ({ type: "image", source: { type: "base64", media_type: d.media_type, data: d.data } })),
							{ type: "text", text: m.content },
						],
					}
				: m,
		);
		const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages: msgs };
		if (r.system) body.system = r.system;
		body.output_config = r.schema ? { effort: c.effort, format: { type: "json_schema", schema: r.schema } } : { effort: c.effort };
		const headers: Record<string, string> = { "x-api-key": c.api_key, "anthropic-version": "2026-10-21" };
		if (FALLBACK_MODELS.test(model)) {
			// If the model declines, the API re-runs the request on a fallback model instead of failing.
			body.fallbacks = "default";
			headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
		}
		const res = await post(`${base}/v1/messages`, headers, body);
		if (res.stop_reason === "refusal") throw new LlmError(`the model declined${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""}`, 422);
		if (res.stop_reason === "max_tokens") throw new LlmError("the answer was cut off (max tokens); ask for less at a time");
		const text = (res.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("");
		return {
			text,
			data: r.schema ? parseJsonText(text, "Claude") : undefined,
			model: res.model ?? model,
			usage: { input_tokens: res.usage?.input_tokens ?? null, output_tokens: res.usage?.output_tokens ?? null },
		};
	}
	const images = r.images ?? [];
	const last = messages.length - 1;
	const all = [...(r.system ? [{ role: "system", content: r.system }] : []), ...messages];
	const auth: Record<string, string> = c.api_key ? { authorization: `Bearer ${c.api_key}` } : {};
	if (provider === "ollama") {
		const res = await post(`${base}/api/chat`, auth, {
			model,
			stream: false,
			...(r.schema ? { format: r.schema } : {}),
			options: { temperature: 0, num_predict: maxTokens },
			// Ollama takes pictures as base64 next to the message's text.
			messages: [
				...(r.system ? [{ role: "system", content: r.system }] : []),
				...messages.map((m, i) => (i === last && images.length > 0 ? { ...m, images: images.map((d) => d.data) } : m)),
			],
		});
		const text = String(res.message?.content ?? "");
		return {
			text,
			data: r.schema ? parseJsonText(text, "Ollama") : undefined,
			model: res.model ?? model,
			usage: { input_tokens: res.prompt_eval_count ?? null, output_tokens: res.eval_count ?? null },
		};
	}
	const res = await post(`${base}/chat/completions`, auth, {
		model,
		max_tokens: maxTokens,
		...(r.schema ? { response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: r.schema } } } : {}),
		messages:
			images.length === 0
				? all
				: [
						...(r.system ? [{ role: "system", content: r.system }] : []),
						...messages.map((m, i) =>
							i === last
								? {
										role: m.role,
										content: [
											{ type: "text", text: m.content },
											...images.map((d) => ({ type: "image_url", image_url: { url: `data:${d.media_type};base64,${d.data}` } })),
										],
									}
								: m,
						),
					],
	});
	const text = String(res.choices?.[0]?.message?.content ?? "");
	return {
		text,
		data: r.schema ? parseJsonText(text, model) : undefined,
		model: res.model ?? model,
		usage: { input_tokens: res.usage?.prompt_tokens ?? null, output_tokens: res.usage?.completion_tokens ?? null },
	};
}

/**
 * Calls the configured provider for `source` ("ledger" or a module id) and
 * logs the call. Modules must be allowed under Settings → LLM API.
 */
export async function llmComplete(app: App, source: string, r: LlmRequest): Promise<LlmResult> {
	const cfg = await readLlmConfig(app.integrations.dir);
	if (!cfg.connections.some(connectionReady)) throw new LlmError("no LLM connection is set up; an admin can add one under Settings → LLM API", 409);
	if (source !== "ledger" && !cfg.allow_modules.includes(source)) {
		throw new LlmError(`this module isn't allowed to use AI; an admin can allow it under Settings → LLM API`, 403);
	}
	const messages = checkRequest(r);
	const want = r.connection ?? ((r.images?.length ?? 0) + (r.documents?.length ?? 0) > 0 ? "images" : "text");
	const c = pickConnection(cfg, want);
	if (!c) {
		const what = want === "text" ? "text" : want === "images" ? "images and documents" : `the connection "${want}"`;
		throw new LlmError(`no LLM connection for ${what} is set up; an admin can add one under Settings → LLM API`, 409);
	}
	const started = Date.now();
	let result: LlmResult | null = null;
	let error = "";
	try {
		result = await callProvider(c, r, messages);
		return result;
	} catch (e) {
		error = (e as Error).message;
		throw e;
	} finally {
		await app.db
			.query(
				`INSERT INTO llm_usage (source, provider, model, input_tokens, output_tokens, ok, error, duration_ms, connection) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[source, c.provider, result?.model ?? c.model, result?.usage.input_tokens ?? null, result?.usage.output_tokens ?? null, result !== null, error.slice(0, 500), Date.now() - started, c.id],
			)
			.catch((e: Error) => log.warn("could not log AI usage", { err: e.message }));
	}
}

/** Usage for Settings → LLM API: per source over 30 days, and the latest calls. */
export async function llmUsage(app: App) {
	await app.db.query(`DELETE FROM llm_usage WHERE created_at < now() - interval '180 days'`).catch(() => undefined);
	const [bySource, recent] = await Promise.all([
		app.db.query(
			`SELECT source, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
			        coalesce(sum(input_tokens), 0)::bigint AS input_tokens, coalesce(sum(output_tokens), 0)::bigint AS output_tokens
			   FROM llm_usage WHERE created_at > now() - interval '30 days' GROUP BY source ORDER BY calls DESC`,
		),
		app.db.query(`SELECT source, connection, model, input_tokens, output_tokens, ok, error, duration_ms, created_at FROM llm_usage ORDER BY id DESC LIMIT 20`),
	]);
	return { last_30_days: bySource.rows, recent: recent.rows };
}
