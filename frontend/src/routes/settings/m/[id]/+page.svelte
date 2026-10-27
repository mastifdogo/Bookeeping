<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type ModuleSettings } from '#lib/api/client.ts';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { arrangeNav } from '#lib/nav.ts';
	import NavIcon from '#lib/components/NavIcon.svelte';
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

	function reset(s: ModuleSettings | null) {
		settings = s;
		if (!s) return;
		form = Object.fromEntries(s.fields.map((f) => [f.key, f.type === 'secret' ? '' : (s.values[f.key] ?? (f.type === 'boolean' ? false : ''))]));
		clearSecret = {};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		saved = false;
		const values: Record<string, Value> = {};
		if (!settings) return;
		for (const f of settings.fields) {
			const v = form[f.key];
			if (f.type === 'secret') {
				if (clearSecret[f.key]) values[f.key] = '';
				else if (v) values[f.key] = v;
			} else if (f.type === 'number') {
				values[f.key] = v === '' || v === null ? null : Number(v);
			} else if ((f.type === 'text' || f.type === 'textarea') && v === '') {
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
		{#if data.installerAvailable && mod.state !== 'removing'}<button onclick={remove} disabled={busy}>Remove</button>{/if}
	</div>
	{#if mod.message}<p class="small" class:err={mod.state === 'failed' || mod.state === 'error'}>{mod.message}</p>{/if}
	{#if !settings}<p class="muted small" style="margin-bottom:0">This module has no settings of its own.</p>{/if}
</div>

{#if settings && settings.fields.length > 0}
	<form class="card" style="max-width:640px" onsubmit={save}>
		{#if saved}<div class="notice ok">Saved.</div>{/if}
		<ErrorNotice {error} />
		<div class="fields">
			{#each settings.fields as f (f.key)}
				{#if f.type === 'boolean'}
					<label class="inline">
						<input type="checkbox" checked={form[f.key] === true} onchange={(e) => (form[f.key] = e.currentTarget.checked)} />
						{f.label}
					</label>
				{:else}
					<label>
						<span>{f.label}{#if f.required}<span aria-hidden="true"> *</span>{/if}</span>
						{#if f.type === 'textarea'}
							<textarea rows="5" bind:value={form[f.key]} placeholder={f.default != null ? String(f.default) : ''}></textarea>
						{:else if f.type === 'select'}
							<select bind:value={form[f.key]}>
								{#if !f.required && f.default == null}<option value="">—</option>{/if}
								{#each f.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
							</select>
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
				{/if}
				{#if f.help}<p class="muted small help">{f.help}</p>{/if}
			{/each}
		</div>
		<p style="margin-bottom:0"><button class="primary" disabled={busy}>Save</button></p>
	</form>
{/if}

{#if settings?.page}
	<iframe class="card module-page" src={settings.page} title="Module settings"></iframe>
{/if}

{#if navItem?.hidden}
	<h2>{navItem.label}</h2>
	<p class="muted small" style="margin-top:0">
		Hidden from the sidebar, so it's shown here. Show it again under <a href="/settings/sidebar">Sidebar</a>.
	</p>
	<iframe class="card module-app" src="/m/{data.id}/" title={navItem.label}></iframe>
{/if}

<style>
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
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.help {
		margin: -0.35rem 0 0.2rem;
	}
	.module-page {
		display: block;
		width: 100%;
		min-height: 420px;
		padding: 0;
		margin-top: 1rem;
	}
</style>
