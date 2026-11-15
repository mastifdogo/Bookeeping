<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import ModuleImport from '#lib/components/ModuleImport.svelte';
	import AccountSelect from '#lib/components/AccountSelect.svelte';
	import { api, unwrap, type ModuleSettings } from '#lib/api/client.ts';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { arrangeNav } from '#lib/nav.ts';
	import NavIcon from '#lib/components/NavIcon.svelte';
	import { forwardSearchKeys } from '#lib/search-shortcut.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Value = string | number | boolean | null;
	let settings = $state<ModuleSettings | null>(null);
	// Form values; secret inputs start empty (blank keeps the stored secret).
	let form = $state<Record<string, Value>>({});
	let clearSecret = $state<Record<string, boolean>>({});
	$effect.pre(() => {
		reset(data.settings);
	});
	let busy = $state(false);
	let error: unknown = $state(null);
	let saved = $state(false);

	let mod = $derived(data.mod);
	// The module's sidebar entry, if it has one, and whether the user hid it.
	let navItem = $derived(arrangeNav(page.data.sidebar ?? [], page.data.modules ?? []).find((i) => i.id === `module:${data.id}`));
	const stateLabel: Record<string, [string, string]> = {
		running: ['ok', 'Running'],
		failed: ['danger', 'Failed to load'],
		error: ['danger', 'Install failed'],
		pending: ['warn', 'Installing'],
		removing: ['warn', 'Removing']
	};

	async function remove() {
		if (!confirm(`Remove ${mod.name}? Its data stays in the database and comes back if you add it again.`)) return;
		error = null;
		busy = true;
		try {
			unwrap(await api().DELETE('/modules/{moduleId}', { params: { path: { moduleId: data.id } } }));
			await invalidate('app:modules');
			await goto('/settings/modules');
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// Tabs: the ones the module declared (or one "Settings" tab for a module that declared none),
	// then "Import" when the module takes a CSV. The open one is in the address (?tab=).
	const IMPORT = '_import';
	type Tab = { id: string; label: string; help: string; page: string | null };
	let own = $derived<Tab[]>(
		settings?.tabs.length ? settings.tabs : settings && (settings.fields.length > 0 || settings.page) ? [{ id: '_settings', label: 'Settings', help: '', page: null }] : []
	);
	let tabs = $derived<Tab[]>([...own, ...(data.importInfo ? [{ id: IMPORT, label: 'Import', help: '', page: null }] : [])]);
	let tab = $derived(tabs.find((t) => t.id === page.url.searchParams.get('tab')) ?? tabs[0] ?? null);
	// The open tab's fields. A field that depends on another (show_if) shows only while that one has the right value.
	let tabFields = $derived(!settings || !tab || tab.id === IMPORT ? [] : settings.fields.filter((f) => (f.tab ?? own[0]!.id) === tab!.id || own[0]!.id === '_settings'));
	const visible = (f: ModuleSettings['fields'][number]) => !f.show_if || f.show_if.in.includes((form[f.show_if.key] ?? null) as never);
	let shownFields = $derived(tabFields.filter(visible));
	// Pages of the module's own shown on the open tab.
	let shownPages = $derived(
		!settings || !tab || tab.id === IMPORT ? [] : [...(tab.page ? [tab.page] : []), ...(settings.page && tab.id === own[0]?.id ? [settings.page] : [])]
	);
	// Accounts an account field offers: active ones, of its currency and types.
	const accountsFor = (f: ModuleSettings['fields'][number]) =>
		data.accounts.filter((a) => (a.is_active || a.code === form[f.key]) && (!f.currency || a.currency === f.currency) && (f.account_types.length === 0 || f.account_types.includes(a.type)));

	// A page of the module's is as tall as what it shows (it is on Ledger's own address, so it can be measured).
	function fitHeight(frame: HTMLIFrameElement) {
		let watch: ResizeObserver | undefined;
		const fit = () => {
			try {
				const doc = frame.contentDocument;
				if (doc?.documentElement) frame.style.height = `${Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 2}px`;
			} catch {
				// not measurable: the height in the stylesheet stays
			}
		};
		const onLoad = () => {
			fit();
			watch?.disconnect();
			try {
				const body = frame.contentDocument?.body;
				if (body) {
					watch = new ResizeObserver(fit);
					watch.observe(body);
				}
			} catch {
				// as above
			}
		};
		frame.addEventListener('load', onLoad);
		return () => {
			frame.removeEventListener('load', onLoad);
			watch?.disconnect();
		};
	}
	function openTab(id: string) {
		saved = false;
		error = null;
		const q = new URLSearchParams(page.url.search);
		if (id === tabs[0]?.id) q.delete('tab');
		else q.set('tab', id);
		goto(`?${q}`, { reset: false });
	}

	function reset(s: ModuleSettings | null) {
		settings = s;
		if (!s) return;
		form = Object.fromEntries(s.fields.filter((f) => f.type !== 'heading').map((f) => [f.key, f.type === 'secret' ? '' : (s.values[f.key] ?? (f.type === 'boolean' ? false : ''))]));
		clearSecret = {};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		saved = false;
		const values: Record<string, Value> = {};
		if (!settings) return;
		// Only the open tab's fields are sent; the others, and those not shown, keep their saved values.
		for (const f of shownFields) {
			if (f.type === 'heading') continue;
			const v = form[f.key];
			if (f.type === 'secret') {
				if (clearSecret[f.key]) values[f.key] = '';
				else if (v) values[f.key] = v;
			} else if (f.type === 'number') {
				values[f.key] = v === '' || v === null ? null : Number(v);
			} else if ((f.type === 'text' || f.type === 'textarea' || f.type === 'account') && v === '') {
				values[f.key] = null;
			} else {
				values[f.key] = v;
			}
		}
		busy = true;
		try {
			reset(unwrap(await api().PUT('/modules/{moduleId}/settings', { params: { path: { moduleId: data.id } }, body: { values } })));
			saved = true;
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
</script>

<div class="card about">
	<div class="head">
		{#if navItem}<NavIcon d={navItem.icon} fill={navItem.iconFill} url={navItem.iconUrl} size={28} />{/if}
		<div style="flex:1; min-width:0">
			<strong class="name">{mod.name}</strong>
			{#if mod.version}<span class="muted small">v{mod.version}</span>{/if}
			{#if mod.state in stateLabel}<span class="badge {stateLabel[mod.state]![0]}">{stateLabel[mod.state]![1]}</span>{/if}
			{#if mod.description}<div class="muted small">{mod.description}</div>{/if}
			{#if mod.repo}<div class="small"><a href="https://github.com/{mod.repo}" target="_blank" rel="noopener noreferrer">github.com/{mod.repo}</a></div>{/if}
		</div>
		{#if navItem}<a class="button" href={navItem.href}>Open</a>{/if}
		{#if data.installerAvailable && page.data.user?.server_admin && mod.state !== 'removing'}<button onclick={remove} disabled={busy}>Remove</button>{/if}
	</div>
	{#if mod.message}<p class="small" class:err={mod.state === 'failed' || mod.state === 'error'}>{mod.message}</p>{/if}
	{#if !settings}<p class="muted small" style="margin-bottom:0">This module has no settings of its own.</p>{/if}
</div>

{#if tabs.length > 1}
	<div class="subtabs" role="tablist" aria-label="{mod.name} settings">
		{#each tabs as t (t.id)}
			<button type="button" role="tab" aria-selected={t.id === tab?.id} class:on={t.id === tab?.id} onclick={() => openTab(t.id)}>{t.label}</button>
		{/each}
	</div>
{/if}
{#if tab?.help}<p class="muted small" style="margin-top:0">{tab.help}</p>{/if}

{#if tab?.id === IMPORT && data.importInfo}<ModuleImport moduleId={data.id} moduleName={mod.name} info={data.importInfo} />{/if}

{#if settings && shownFields.length > 0}
	<form class="card" onsubmit={save}>
		{#if (page.data.user?.organizations.length ?? 0) > 1}
			<p class="muted small" style="margin-top:0">
				Settings for <strong>{page.data.user?.organization.name}</strong>. Each organization keeps its own; switch books in
				the sidebar to change another's.
			</p>
		{/if}
		{#if saved}<div class="notice ok">Saved.</div>{/if}
		<ErrorNotice {error} />
		<div class="fields">
			{#each shownFields as f (f.key)}
				{#if f.type === 'heading'}
					<div class="wide heading">
						<h3>{f.label}</h3>
						{#if f.help}<p class="muted small">{f.help}</p>{/if}
					</div>
				{:else if f.type === 'boolean'}
					<div class="wide">
						<label class="inline">
							<input type="checkbox" checked={form[f.key] === true} onchange={(e) => (form[f.key] = e.currentTarget.checked)} />
							{f.label}
						</label>
						{#if f.help}<p class="muted small help">{f.help}</p>{/if}
					</div>
				{:else}
					<div class:wide={f.type === 'textarea'}>
						<label>
							<span>{f.label}{#if f.required}<span aria-hidden="true"> *</span>{/if}</span>
							{#if f.type === 'textarea'}
								<textarea rows="5" bind:value={form[f.key]} placeholder={f.default != null ? String(f.default) : ''}></textarea>
							{:else if f.type === 'select'}
								<select bind:value={form[f.key]}>
									{#if !f.required && f.default == null}<option value="">—</option>{/if}
									{#each f.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
								</select>
							{:else if f.type === 'account'}
								<AccountSelect
									bind:value={form[f.key] as string}
									accounts={accountsFor(f)}
									label={f.label}
									placeholder={f.required ? 'Choose account…' : '(none)'}
									required={f.required}
									defaults={{ ...(f.account_types[0] ? { type: f.account_types[0] as never } : {}), ...(f.currency ? { currency: f.currency as never } : {}) }}
								/>
							{:else if f.type === 'number'}
								<input type="number" step="any" min={f.min} max={f.max} bind:value={form[f.key]} placeholder={f.default != null ? String(f.default) : ''} />
							{:else if f.type === 'secret'}
								<input
									type="password"
									autocomplete="new-password"
									bind:value={form[f.key]}
									disabled={clearSecret[f.key]}
									placeholder={settings.secrets_set[f.key] ? '•••••••• (saved; type to replace)' : 'Not set'}
								/>
							{:else}
								<input bind:value={form[f.key]} placeholder={f.default != null ? String(f.default) : ''} />
							{/if}
						</label>
						{#if f.type === 'secret' && settings.secrets_set[f.key]}
							<label class="inline small"><input type="checkbox" bind:checked={clearSecret[f.key]} /> Remove the saved value</label>
						{/if}
						{#if f.help}<p class="muted small help">{f.help}</p>{/if}
					</div>
				{/if}
			{/each}
		</div>
		<p style="margin-bottom:0"><button class="primary" disabled={busy}>Save</button></p>
	</form>
{/if}

{#each shownPages as src (src)}
	<iframe class="card module-page" {src} title="Module settings{tab ? `: ${tab.label}` : ''}" {@attach forwardSearchKeys} {@attach fitHeight}></iframe>
{/each}

{#if navItem?.hidden}
	<h2>{navItem.label}</h2>
	<p class="muted small" style="margin-top:0">
		Hidden from the sidebar, so it's shown here. Show it again under <a href="/settings/sidebar">Sidebar</a>.
	</p>
	<iframe class="card module-app" src="/m/{data.id}/" title={navItem.label} {@attach forwardSearchKeys}></iframe>
{/if}

<style>
	.subtabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1rem;
	}
	.subtabs button {
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: none;
		padding: 0.4rem 0.8rem;
		color: var(--muted);
	}
	.subtabs button.on {
		color: var(--text);
		font-weight: 600;
		border-bottom-color: var(--accent);
	}
	.about .head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.name {
		font-size: 1.1rem;
		margin-right: 0.4rem;
	}
	.err {
		color: var(--danger);
	}
	.module-app {
		display: block;
		width: 100%;
		height: calc(100vh - 14rem);
		min-height: 420px;
		padding: 0;
	}
	/* Two columns where there is room; long text, tick boxes and headings take the whole width. */
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
		gap: 0.8rem 1.25rem;
		max-width: 56rem;
		align-items: start;
	}
	.fields .wide {
		grid-column: 1 / -1;
	}
	.fields .heading h3 {
		margin: 0.6rem 0 0;
		font-size: 1rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border);
	}
	.fields .heading:first-child h3 {
		margin-top: 0;
	}
	.fields .heading p {
		margin: 0.3rem 0 0;
	}
	.help {
		margin: 0.25rem 0 0;
	}
	.module-page {
		display: block;
		width: 100%;
		height: 420px;
		min-height: 6rem;
		padding: 0;
		margin-top: 1rem;
	}
</style>
