<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type ModuleSettings } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Value = string | number | boolean | null;
	let settings = $state<ModuleSettings>(undefined!);
	// Form values; secret inputs start empty (blank keeps the stored secret).
	let form = $state<Record<string, Value>>({});
	let clearSecret = $state<Record<string, boolean>>({});
	$effect.pre(() => {
		reset(data.settings);
	});
	let busy = $state(false);
	let error: unknown = $state(null);
	let saved = $state(false);

	function reset(s: ModuleSettings) {
		settings = s;
		form = Object.fromEntries(s.fields.map((f) => [f.key, f.type === 'secret' ? '' : (s.values[f.key] ?? (f.type === 'boolean' ? false : ''))]));
		clearSecret = {};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		saved = false;
		const values: Record<string, Value> = {};
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

{#if settings.fields.length > 0}
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

{#if settings.page}
	<iframe class="card module-page" src={settings.page} title="Module settings"></iframe>
{/if}

<style>
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
