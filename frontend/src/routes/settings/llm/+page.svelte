<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type LlmInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const USE_LABELS: Record<string, string> = { text: 'Text', images: 'Images and documents' };

	type Use = 'text' | 'images';
	type Provider = LlmInfo['config']['connections'][number]['provider'];
	/** What the server knows about a provider: its label, default address and model, whether it needs a key. */
	const about = (p: string) => info.config.provider_info.find((x) => x.id === p);
	/** Models each provider offers, fetched with "Find models" (by connection row). */
	let models = $state<Record<number, string[]>>({});

	type Conn = {
		id: string;
		name: string;
		provider: Provider;
		model: string;
		base_url: string;
		api_key: string;
		clear_key: boolean;
		has_api_key: boolean;
		configured: boolean;
		effort: 'low' | 'medium' | 'high';
		max_tokens: number;
		uses: Use[];
		/** Not saved yet: its id can still change. */
		fresh: boolean;
	};
	let info = $state<LlmInfo>(undefined!);
	let conns = $state<Conn[]>([]);
	let allow = $state<string[]>([]);
	$effect.pre(() => load(data.info));
	function load(i: LlmInfo) {
		info = i;
		conns = i.config.connections.map((c) => ({ ...c, api_key: '', clear_key: false, uses: [...c.uses] as Use[], fresh: false }));
		allow = [...i.config.allow_modules];
	}
	let busy = $state(false);
	let error: unknown = $state(null);
	let notice = $state('');

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

	/** A free id like "vision" or "main-2". */
	function freeId(base: string): string {
		let id = base;
		for (let n = 2; conns.some((c) => c.id === id); n++) id = `${base}-${n}`;
		return id;
	}

	function add() {
		const first = conns.length === 0;
		const id = freeId(first ? 'main' : 'vision');
		// A new connection is usually for pictures: it takes them over from the ones above.
		if (!first) for (const c of conns) c.uses = c.uses.filter((u) => u !== 'images');
		conns.push({
			id,
			name: first ? 'Main' : 'Images',
			provider: conns[0]?.provider ?? info.config.provider_info[0]!.id as Provider,
			model: '',
			base_url: '',
			api_key: '',
			clear_key: false,
			has_api_key: false,
			configured: false,
			effort: 'low',
			max_tokens: 16000,
			uses: first ? ['text', 'images'] : ['images'],
			fresh: true
		});
	}

	function remove(i: number) {
		if (!confirm(`Remove the connection "${conns[i]!.name}"? Its saved key is deleted when you save.`)) return;
		conns.splice(i, 1);
	}

	function move(i: number, d: -1 | 1) {
		const [c] = conns.splice(i, 1);
		conns.splice(i + d, 0, c!);
	}

	function toggleUse(c: Conn, u: Use, on: boolean) {
		c.uses = on ? [...new Set([...c.uses, u])] : c.uses.filter((x) => x !== u);
	}

	// Which connection answers each kind of request: the first ready one that lists it.
	const answering = (u: Use) =>
		conns.find((c) => c.uses.includes(u) && (!about(c.provider)?.needs_key || (c.has_api_key && !c.clear_key) || c.api_key) && (c.model || about(c.provider)?.model));

	const findModels = (c: Conn, i: number) =>
		act(async () => {
			const body = { ...(c.fresh ? {} : { connection: c.id }), provider: c.provider, base_url: c.base_url.trim(), ...(c.api_key ? { api_key: c.api_key } : {}) };
			const r = unwrap(await api().POST('/integrations/llm/models', { body }));
			models[i] = r.models;
			notice = r.models.length === 0 ? 'The provider listed no models.' : `${r.models.length} models found: pick one in the Model box.`;
		});

	const save = (e?: SubmitEvent) => {
		e?.preventDefault();
		return act(async () => {
			const body = {
				connections: conns.map((c) => ({
					id: c.id,
					name: c.name,
					provider: c.provider,
					model: c.model,
					base_url: c.base_url,
					api_key: c.clear_key ? '' : c.api_key || null,
					effort: c.effort,
					max_tokens: c.max_tokens,
					uses: c.uses
				})),
				allow_modules: allow
			};
			load(unwrap(await api().PUT('/integrations/llm', { body })));
			notice = 'Saved.';
		});
	};
	const test = (c: Conn) =>
		act(async () => {
			const r = unwrap(await api().POST('/integrations/llm/test', { body: { connection: c.id } }));
			notice = `${c.name} works: ${r.model} answered "${r.text}" in ${(r.duration_ms / 1000).toFixed(1)} s.`;
			load(unwrap(await api().GET('/integrations/llm')));
		});

	function toggleModule(id: string, on: boolean) {
		allow = on ? [...allow, id].sort() : allow.filter((m) => m !== id);
	}
	const nameOf = (source: string) => (source === 'ledger' ? 'Ledger (test)' : (info.modules.find((m) => m.id === source)?.name ?? source));
	const n = (x: number | null) => (x === null ? '—' : x.toLocaleString());
	const saved = (c: Conn) => info.config.connections.find((x) => x.id === c.id);
</script>

{#if !info.available}
	<div class="notice error">LLM settings aren't set up on this server (no <code>/var/lib/ledger/integrations</code>). Update Ledger, or run <code>deploy/install.sh</code>.</div>
{/if}
<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<p class="muted" style="margin-top:0">
	LLM connections for Ledger and its modules (sorting transactions, reading bills and receipts, …), from any provider: a
	hosted service, or a model on your own computer. Keys stay on the server;
	modules call the models through Ledger, and only the ones you allow below. Add a second connection to send pictures
	and PDFs to a vision model while text goes elsewhere.
</p>

<form onsubmit={save}>
	<section class="card summary">
		<div><span class="muted small">Text goes to</span> <strong>{answering('text')?.name ?? 'nothing (not set up)'}</strong></div>
		<div><span class="muted small">Images and documents go to</span> <strong>{answering('images')?.name ?? 'nothing (not set up)'}</strong></div>
		<p class="muted small" style="margin:0.25rem 0 0">The first connection (from the top) that is ticked for a kind of request answers it. Modules can also ask for a connection by its id.</p>
	</section>

	{#each conns as c, i (i)}
		<section class="card conn">
			<div class="head">
				<h2>{c.name || 'New connection'}</h2>
				{#if c.configured}<span class="badge ok">ready</span>{:else if !c.fresh}<span class="badge warn">incomplete</span>{/if}
				<span class="spacer"></span>
				<button type="button" class="icon" disabled={i === 0} title="Move up" onclick={() => move(i, -1)}>↑</button>
				<button type="button" class="icon" disabled={i === conns.length - 1} title="Move down" onclick={() => move(i, 1)}>↓</button>
				{#if saved(c)?.configured}<button type="button" disabled={busy} onclick={() => test(c)}>Test</button>{/if}
				<button type="button" onclick={() => remove(i)}>Remove</button>
			</div>
			<div class="row">
				<label style="flex:1; min-width:10rem">Name <input bind:value={c.name} required maxlength="60" /></label>
				<label>
					Id
					<input bind:value={c.id} required pattern="[a-z][a-z0-9\-]*" maxlength="32" readonly={!c.fresh} style="width:9rem" title={c.fresh ? 'Modules can ask for this connection by id' : "Can't change once saved"} />
				</label>
				<label style="flex:2; min-width:14rem">
					Provider
					<select bind:value={c.provider} onchange={() => delete models[i]}>{#each info.config.provider_info as p (p.id)}<option value={p.id}>{p.label}</option>{/each}</select>
				</label>
			</div>
			<fieldset class="uses">
				<legend class="small muted">Use for</legend>
				{#each info.config.uses as u (u)}
					<label class="inline"><input type="checkbox" checked={c.uses.includes(u as Use)} onchange={(e) => toggleUse(c, u as Use, e.currentTarget.checked)} /> {USE_LABELS[u] ?? u}</label>
				{/each}
			</fieldset>
			<div class="row">
				<label style="flex:1; min-width:14rem">
					Model
					<span class="with-button">
						<input bind:value={c.model} placeholder={about(c.provider)?.model || 'model name'} list="models-{i}" autocomplete="off" />
						<button type="button" disabled={busy} onclick={() => findModels(c, i)} title="Ask the provider which models it offers">Find models</button>
					</span>
					<datalist id="models-{i}">{#each models[i] ?? [] as m (m)}<option value={m}></option>{/each}</datalist>
				</label>
				<label style="flex:1; min-width:14rem">
					Server address
					<input bind:value={c.base_url} placeholder={about(c.provider)?.base_url} />
				</label>
			</div>
			<div class="row">
				<label style="flex:1; min-width:14rem">
					{about(c.provider)?.needs_key ? 'API key' : 'API key (if the server needs one)'}
					<input
						type="password"
						bind:value={c.api_key}
						disabled={c.clear_key}
						autocomplete="new-password"
						placeholder={c.has_api_key ? '•••••••• (saved; type to replace)' : ''}
					/>
				</label>
				{#if about(c.provider)?.effort}
					<label>
						Effort
						<select bind:value={c.effort}><option value="low">Low (fast, cheap)</option><option value="medium">Medium</option><option value="high">High</option></select>
					</label>
				{/if}
				<label>Max tokens per call <input type="number" min="256" max="64000" step="1" bind:value={c.max_tokens} style="width:8rem" /></label>
			</div>
			{#if c.has_api_key}<label class="inline small"><input type="checkbox" bind:checked={c.clear_key} /> Remove the saved key</label>{/if}
			{#if c.uses.includes('images')}
				<p class="muted small">
					Pick a model that can see pictures.
					{about(c.provider)?.pdf ? 'PDFs are sent to it as files.' : 'This provider gets only the text of a request with PDFs, not the files.'}
				</p>
			{/if}
		</section>
	{/each}

	<p><button type="button" onclick={add}>+ Add a connection</button></p>

	<section class="card">
		<h2>Modules that may use them</h2>
		{#if info.modules.length === 0}
			<p class="muted">No modules are installed.</p>
		{:else}
			<div class="checks">
				{#each info.modules as m (m.id)}
					<label class="inline">
						<input type="checkbox" checked={allow.includes(m.id)} onchange={(e) => toggleModule(m.id, e.currentTarget.checked)} />
						{m.name} <span class="muted small">({m.id})</span>
					</label>
				{/each}
			</div>
		{/if}
		<p class="muted small" style="margin-bottom:0">
			Modules only suggest what the AI came up with; a person approves each action before anything is posted, sent or changed.
		</p>
	</section>

	<p><button class="primary" disabled={busy || !info.available}>Save</button></p>
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
				{#each info.usage.recent.filter((r) => !r.ok).slice(0, 5) as r, i (i)}<li>{new Date(r.created_at).toLocaleString()} · {nameOf(r.source)}{r.connection ? ` via ${r.connection}` : ''}: {r.error}</li>{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	section h2 {
		margin: 0;
	}
	.summary {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.spacer {
		flex: 1;
	}
	.with-button {
		display: flex;
		gap: 0.4rem;
	}
	.with-button input {
		flex: 1;
		min-width: 0;
	}
	.with-button button {
		white-space: nowrap;
	}
	button.icon {
		padding: 0.2rem 0.5rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.75rem 0 0.5rem;
	}
	.uses {
		border: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		align-items: center;
	}
	.uses legend {
		float: left;
		margin-right: 0.5rem;
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
