// The AI provider set under Settings → AI, shared by Ledger and modules
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

export interface LlmConfig {
	/** "" until set up. */
	provider: Provider | "";
	model: string;
	base_url: string;
	api_key: string;
	effort: (typeof EFFORTS)[number];
	/** Upper bound on max_tokens for any one call. */
	max_tokens: number;
	/** Modules allowed to use it (ctx.llm). Ledger itself always may. */
	allow_modules: string[];
}

export const LLM_DEFAULTS: LlmConfig = { provider: "", model: "", base_url: "", api_key: "", effort: "low", max_tokens: 16_000, allow_modules: [] };

export const readLlmConfig = (dir: string) => readIntegration(dir, "llm", LLM_DEFAULTS);

/** Settings without the key, for the browser. */
export function publicLlmConfig(c: LlmConfig) {
	const { api_key, ...rest } = c;
	return { ...rest, has_api_key: api_key !== "", configured: llmReady(c), providers: PROVIDERS, defaults: DEFAULTS };
}

export function llmReady(c: LlmConfig): boolean {
	if (!c.provider) return false;
	if (c.provider === "anthropic") return c.api_key !== "";
	return c.model !== "";
}

/** Applies a change from Settings → AI. api_key: omitted or null keeps it, "" clears it. */
export function applyLlmChange(c: LlmConfig, v: unknown): LlmConfig {
	const err = new ValidationError();
	const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
	const keys = ["provider", "model", "base_url", "api_key", "effort", "max_tokens", "allow_modules"];
	for (const k of Object.keys(o)) if (!keys.includes(k)) err.add(k, "unknown field");
	const next = structuredClone(c);
	if (o.provider !== undefined) {
		if (o.provider !== "" && !PROVIDERS.includes(o.provider as Provider)) err.add("provider", `must be one of ${PROVIDERS.join(", ")}`);
		else next.provider = o.provider as Provider | "";
	}
	if (o.model !== undefined) {
		if (typeof o.model !== "string" || o.model.length > 200 || /\s/.test(o.model.trim())) err.add("model", "must be a model name");
		else next.model = o.model.trim();
	}
	if (o.base_url !== undefined) {
		const u = typeof o.base_url === "string" ? o.base_url.trim() : null;
		if (u === null || (u !== "" && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(u))) err.add("base_url", "must be an http(s) URL");
		else next.base_url = u.replace(/\/+$/, "");
	}
	if (o.api_key !== undefined && o.api_key !== null) {
		if (typeof o.api_key !== "string" || o.api_key.length > 500 || /\s/.test(o.api_key)) err.add("api_key", "is not valid");
		else next.api_key = o.api_key;
	}
	if (o.effort !== undefined) {
		if (!EFFORTS.includes(o.effort as never)) err.add("effort", "must be low, medium or high");
		else next.effort = o.effort as LlmConfig["effort"];
	}
	if (o.max_tokens !== undefined) {
		if (!Number.isInteger(o.max_tokens) || (o.max_tokens as number) < 256 || (o.max_tokens as number) > MAX_TOKENS_LIMIT) err.add("max_tokens", `must be 256 to ${MAX_TOKENS_LIMIT}`);
		else next.max_tokens = o.max_tokens as number;
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

async function callProvider(c: LlmConfig, r: LlmRequest, messages: LlmMessage[]): Promise<LlmResult> {
	const maxTokens = Math.min(r.maxTokens ?? c.max_tokens, c.max_tokens);
	const provider = c.provider as Provider;
	const base = (c.base_url || DEFAULTS[provider].base_url).replace(/\/+$/, "");
	const model = c.model || DEFAULTS[provider].model;
	if (provider === "anthropic") {
		const docs = r.documents ?? [];
		const msgs = messages.map((m, i) =>
			i === messages.length - 1 && m.role === "user" && docs.length > 0
				? {
						role: "user",
						// PDFs go before the text that refers to them.
						content: [
							...docs.map((d) => ({ type: "document", source: { type: "base64", media_type: d.media_type, data: d.data }, title: d.name || undefined })),
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
	const all = [...(r.system ? [{ role: "system", content: r.system }] : []), ...messages];
	const auth: Record<string, string> = c.api_key ? { authorization: `Bearer ${c.api_key}` } : {};
	if (provider === "ollama") {
		const res = await post(`${base}/api/chat`, auth, {
			model,
			stream: false,
			...(r.schema ? { format: r.schema } : {}),
			options: { temperature: 0, num_predict: maxTokens },
			messages: all,
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
		messages: all,
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
 * logs the call. Modules must be allowed under Settings → AI.
 */
export async function llmComplete(app: App, source: string, r: LlmRequest): Promise<LlmResult> {
	const c = await readLlmConfig(app.integrations.dir);
	if (!llmReady(c)) throw new LlmError("no AI provider is set up; an admin can choose one under Settings → AI", 409);
	if (source !== "ledger" && !c.allow_modules.includes(source)) {
		throw new LlmError(`this module isn't allowed to use AI; an admin can allow it under Settings → AI`, 403);
	}
	const messages = checkRequest(r);
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
				`INSERT INTO llm_usage (source, provider, model, input_tokens, output_tokens, ok, error, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[source, c.provider, result?.model ?? c.model, result?.usage.input_tokens ?? null, result?.usage.output_tokens ?? null, result !== null, error.slice(0, 500), Date.now() - started],
			)
			.catch((e: Error) => log.warn("could not log AI usage", { err: e.message }));
	}
}

/** Usage for Settings → AI: per source over 30 days, and the latest calls. */
export async function llmUsage(app: App) {
	await app.db.query(`DELETE FROM llm_usage WHERE created_at < now() - interval '180 days'`).catch(() => undefined);
	const [bySource, recent] = await Promise.all([
		app.db.query(
			`SELECT source, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
			        coalesce(sum(input_tokens), 0)::bigint AS input_tokens, coalesce(sum(output_tokens), 0)::bigint AS output_tokens
			   FROM llm_usage WHERE created_at > now() - interval '30 days' GROUP BY source ORDER BY calls DESC`,
		),
		app.db.query(`SELECT source, model, input_tokens, output_tokens, ok, error, duration_ms, created_at FROM llm_usage ORDER BY id DESC LIMIT 20`),
	]);
	return { last_30_days: bySource.rows, recent: recent.rows };
}
