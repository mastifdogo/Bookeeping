<script lang="ts">
	import { onDestroy } from 'svelte';
	import { invalidate } from '$app/navigation';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type ModulePreview, type ModulesInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let info = $state<ModulesInfo>(data.info);
	let repo = $state('');
	let preview = $state<ModulePreview | null>(null);
	let busy = $state(false);
	let error = $state<unknown>(null);

	const working = $derived(info.modules.some((m) => m.state === 'pending' || m.state === 'removing'));

	// While the installer works, refresh every few seconds; the sidebar follows.
	let timer: ReturnType<typeof setInterval> | undefined;
	function poll() {
		clearInterval(timer);
		let rounds = 0;
		timer = setInterval(async () => {
			rounds++;
			try {
				info = unwrap(await api().GET('/modules'));
				await invalidate('app:modules');
			} catch {
				// Ledger restarts after installing a module; keep trying.
			}
			if ((rounds > 3 && !working) || rounds > 200) clearInterval(timer);
		}, 3000);
	}
	onDestroy(() => clearInterval(timer));

	async function lookUp(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		preview = null;
		busy = true;
		try {
			preview = unwrap(await api().POST('/modules/preview', { body: { repo } }));
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function install() {
		if (!preview) return;
		error = null;
		busy = true;
		try {
			info = unwrap(await api().POST('/modules', { body: { repo: preview.repo } }));
			preview = null;
			repo = '';
			poll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function remove(id: string, name: string) {
		if (!confirm(`Remove ${name}? Its data stays in the database and comes back if you add it again.`)) return;
		error = null;
		busy = true;
		try {
			info = unwrap(await api().DELETE('/modules/{moduleId}', { params: { path: { moduleId: id } } }));
			poll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function updateAll() {
		error = null;
		busy = true;
		try {
			info = unwrap(await api().POST('/modules/sync'));
			poll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	const badge: Record<string, string> = { running: 'ok', failed: 'danger', error: 'danger', pending: 'warn', removing: 'warn' };
	const stateLabel: Record<string, string> = { running: 'Running', failed: 'Failed to load', error: 'Install failed', pending: 'Installing', removing: 'Removing' };
</script>

<h1>Modules</h1>

<p class="muted" style="margin-top:0">
	Modules add features such as invoicing, budgets or integrations. Each one comes from a GitHub repository with a
	<code>ledger-module.json</code> file, and installs from its latest release.
</p>

<ErrorNotice {error} />

{#if !info.installer_available}
	<div class="notice error">
		Modules can't be installed on this server: the updater isn't set up. It comes with the release (<code>deploy/install.sh</code>).
	</div>
{/if}

<div class="card">
	<h2 style="margin-top:0">Installed</h2>
	{#if info.modules.length === 0}
		<p class="muted">No modules yet.</p>
	{:else}
		<table>
			<thead><tr><th>Module</th><th>Version</th><th>Status</th><th></th></tr></thead>
			<tbody>
				{#each info.modules as m (m.repo ?? m.id)}
					<tr>
						<td>
							<strong>{m.name}</strong>
							{#if m.repo}<div class="muted small"><a href="https://github.com/{m.repo}" target="_blank" rel="noreferrer">{m.repo}</a></div>{/if}
							{#if m.description}<div class="small">{m.description}</div>{/if}
						</td>
						<td>{m.version ?? '—'}</td>
						<td>
							<span class="badge {badge[m.state]}">{stateLabel[m.state]}</span>
							{#if m.message}<div class="muted small">{m.message}</div>{/if}
						</td>
						<td style="text-align:right; white-space:nowrap">
							{#if m.nav_label && m.id}<a class="button" href="/apps/{m.id}">Open</a>{/if}
							{#if m.id && m.state !== 'removing'}
								<button onclick={() => remove(m.id!, m.name)} disabled={busy || !info.installer_available}>Remove</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p style="margin-bottom:0">
			<button onclick={updateAll} disabled={busy || !info.installer_available}>Update modules now</button>
			<span class="muted small">Modules also update with Ledger on the schedule set under <a href="/system">Updates</a>.</span>
		</p>
	{/if}
</div>

<form class="card" onsubmit={lookUp} style="max-width:760px">
	<h2 style="margin-top:0">Add a module</h2>
	<div class="toolbar" style="margin-bottom:0.5rem">
		<label style="flex:1">
			GitHub repository
			<input bind:value={repo} placeholder="owner/name or https://github.com/owner/name" required />
		</label>
		<button disabled={busy || !info.installer_available}>Look up</button>
	</div>

	{#if preview}
		<div class="card" style="margin:0.75rem 0 0">
			<p style="margin-top:0">
				<strong>{preview.manifest.name}</strong> {preview.manifest.version}
				<span class="muted small">· {preview.repo} · release {preview.tag}</span>
			</p>
			{#if preview.manifest.description}<p>{preview.manifest.description}</p>{/if}
			<ul class="small muted">
				{#if preview.manifest.server}<li>Runs code inside Ledger</li>{/if}
				{#if preview.manifest.ui}<li>Adds a page{preview.manifest.nav ? ` ("${preview.manifest.nav.label}" in the sidebar)` : ''}</li>{/if}
				{#if preview.manifest.migrations}<li>Creates its own database tables</li>{/if}
			</ul>
			{#if !preview.compatible}
				<div class="notice error">This module needs Ledger {preview.manifest.ledger}; this server runs {preview.ledger_version}.</div>
			{:else}
				<div class="notice error">
					<strong>Only install modules from people you trust.</strong> A module runs inside Ledger: it can read all of your
					books and post journal entries. (It cannot edit or delete posted entries; the database prevents that.)
				</div>
				<button class="primary" type="button" onclick={install} disabled={busy}>Install {preview.manifest.name}</button>
			{/if}
		</div>
	{/if}
</form>
