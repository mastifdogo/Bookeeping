<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type LlmInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const LABELS: Record<string, string> = {
		anthropic: 'Claude (Anthropic API)',
		ollama: 'Ollama (a model on your own computer or server)',
		openai: 'OpenAI-compatible server (LM Studio, llama.cpp, vLLM…)'
	};
	const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1'];

	type Form = { provider: string; model: string; base_url: string; api_key: string; clear_key: boolean; effort: string; max_tokens: number; allow_modules: string[] };
	let info = $state<LlmInfo>(undefined!);
	let form = $state<Form>(undefined!);
	$effect.pre(() => load(data.info));
	function load(i: LlmInfo) {
		info = i;
		const c = i.config;
		form = { provider: c.provider, model: c.model, base_url: c.base_url, api_key: '', clear_key: false, effort: c.effort, max_tokens: c.max_tokens, allow_modules: [...c.allow_modules] };
	}
	let busy = $state(false);
	let error: unknown = $state(null);
	let notice = $state('');
	let defaults = $derived(form.provider ? info.config.defaults[form.provider] : undefined);

	async function act(fn: () => Promise<void>) {
		error = null;
		notice = '';
		busy = true;
		try {
			await fn();
		} catch (e) {
			error = e;
		} finally {
			busy = false;
		}
	}

	const save = (e?: SubmitEvent) => {
		e?.preventDefault();
		return act(async () => {
			const { clear_key, api_key, ...rest } = form;
			load(unwrap(await api().PUT('/integrations/llm', { body: { ...rest, provider: rest.provider as never, effort: rest.effort as never, api_key: clear_key ? '' : api_key || null } })));
			notice = 'Saved.';
		});
	};
	const test = () =>
		act(async () => {
			const r = unwrap(await api().POST('/integrations/llm/test'));
			notice = `It works: ${r.model} answered "${r.text}" in ${(r.duration_ms / 1000).toFixed(1)} s.`;
			load(unwrap(await api().GET('/integrations/llm')));
		});

	function toggleModule(id: string, on: boolean) {
		form.allow_modules = on ? [...form.allow_modules, id].sort() : form.allow_modules.filter((m) => m !== id);
	}
	const nameOf = (source: string) => (source === 'ledger' ? 'Ledger (test)' : (info.modules.find((m) => m.id === source)?.name ?? source));
	const n = (x: number | null) => (x === null ? '—' : x.toLocaleString());
</script>

{#if !info.available}
	<div class="notice error">AI settings aren't set up on this server (no <code>/var/lib/ledger/integrations</code>). Update Ledger, or run <code>deploy/install.sh</code>.</div>
{/if}
<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<p class="muted" style="margin-top:0">
	One AI provider for Ledger and its modules (sorting transactions, reading bills, …). The key stays on the server;
	modules call it through Ledger, and only the ones you allow below.
</p>

<form onsubmit={save}>
	<section class="card">
		<h2>Provider</h2>
		<label>
			Provider
			<select bind:value={form.provider}>
				<option value="">None (AI off)</option>
				{#each info.config.providers as p (p)}<option value={p}>{LABELS[p] ?? p}</option>{/each}
			</select>
		</label>
		{#if form.provider}
			<div class="row">
				<label style="flex:1; min-width:14rem">
					Model
					<input bind:value={form.model} placeholder={defaults?.model || 'model name'} list="ai-models" autocomplete="off" />
					{#if form.provider === 'anthropic'}<datalist id="ai-models">{#each CLAUDE_MODELS as m (m)}<option value={m}></option>{/each}</datalist>{/if}
				</label>
				<label style="flex:1; min-width:14rem">
					Server address
					<input bind:value={form.base_url} placeholder={defaults?.base_url} />
				</label>
			</div>
			<div class="row">
				<label style="flex:1; min-width:14rem">
					{form.provider === 'anthropic' ? 'API key' : 'API key (if the server needs one)'}
					<input
						type="password"
						bind:value={form.api_key}
						disabled={form.clear_key}
						autocomplete="new-password"
						placeholder={info.config.has_api_key ? '•••••••• (saved; type to replace)' : form.provider === 'anthropic' ? 'sk-ant-…' : ''}
					/>
				</label>
				{#if form.provider === 'anthropic'}
					<label>
						Effort
						<select bind:value={form.effort}><option value="low">Low (fast, cheap)</option><option value="medium">Medium</option><option value="high">High</option></select>
					</label>
				{/if}
				<label>Max tokens per call <input type="number" min="256" max="64000" step="1" bind:value={form.max_tokens} style="width:8rem" /></label>
			</div>
			{#if info.config.has_api_key}<label class="inline small"><input type="checkbox" bind:checked={form.clear_key} /> Remove the saved key</label>{/if}
			{#if form.provider === 'anthropic'}
				<p class="muted small">
					Get a key at console.anthropic.com → API keys. With Claude, what modules send (transactions, bills) goes to
					Anthropic's API. Ollama keeps everything on your network.
				</p>
			{/if}
		{/if}
	</section>

	<section class="card">
		<h2>Modules that may use it</h2>
		{#if info.modules.length === 0}
			<p class="muted">No modules are installed.</p>
		{:else}
			<div class="checks">
				{#each info.modules as m (m.id)}
					<label class="inline">
						<input type="checkbox" checked={form.allow_modules.includes(m.id)} onchange={(e) => toggleModule(m.id, e.currentTarget.checked)} />
						{m.name} <span class="muted small">({m.id})</span>
					</label>
				{/each}
			</div>
		{/if}
	</section>

	<p>
		<button class="primary" disabled={busy || !info.available}>Save</button>
		<button type="button" disabled={busy || !info.config.configured} onclick={test}>Test</button>
		{#if !info.config.configured}<span class="muted small">Save a provider to test it.</span>{/if}
	</p>
</form>

<section class="card">
	<h2>Usage, last 30 days</h2>
	{#if info.usage.last_30_days.length === 0}
		<p class="muted">No calls yet.</p>
	{:else}
		<table>
			<thead><tr><th>Used by</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Input tokens</th><th class="num">Output tokens</th></tr></thead>
			<tbody>
				{#each info.usage.last_30_days as u (u.source)}
					<tr><td>{nameOf(u.source)}</td><td class="num">{n(u.calls)}</td><td class="num">{n(u.failed)}</td><td class="num">{n(u.input_tokens)}</td><td class="num">{n(u.output_tokens)}</td></tr>
				{/each}
			</tbody>
		</table>
		{#if info.usage.recent.some((r) => !r.ok)}
			<h3 class="small muted">Recent failures</h3>
			<ul class="small">
				{#each info.usage.recent.filter((r) => !r.ok).slice(0, 5) as r, i (i)}<li>{new Date(r.created_at).toLocaleString()} · {nameOf(r.source)}: {r.error}</li>{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	section h2 {
		margin-top: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.75rem 0 0.5rem;
	}
	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	select {
		width: auto;
	}
</style>
