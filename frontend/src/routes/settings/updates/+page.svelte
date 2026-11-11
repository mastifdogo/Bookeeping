<script lang="ts">
	import { onDestroy } from 'svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type UpdateInfo, type UpdateSchedule } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const zones: string[] = (() => {
		try {
			return Intl.supportedValuesOf('timeZone');
		} catch {
			return [browserZone];
		}
	})();

	// svelte-ignore state_referenced_locally
	let info = $state<UpdateInfo>(data.info);
	// The form edits a copy; a never-saved schedule starts in the browser's time zone.
	function formFrom(i: UpdateInfo): UpdateSchedule {
		const s = { ...i.schedule, days: [...i.schedule.days] };
		if (i.status === null && !s.enabled && s.timezone === 'UTC') s.timezone = browserZone;
		return s;
	}
	// svelte-ignore state_referenced_locally
	let form = $state<UpdateSchedule>(formFrom(data.info));
	let busy = $state(false);
	let error = $state<unknown>(null);
	let saved = $state(false);

	const running = $derived(info.status?.state === 'running');
	const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

	function toggleDay(d: number) {
		form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d].sort();
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		saved = false;
		busy = true;
		try {
			info = unwrap(await api().PUT('/system/update/schedule', { body: form }));
			form = formFrom(info);
			saved = true;
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// While a check runs, refresh every few seconds.
	let timer: ReturnType<typeof setInterval> | undefined;
	function poll() {
		clearInterval(timer);
		let rounds = 0;
		timer = setInterval(async () => {
			rounds++;
			try {
				info = unwrap(await api().GET('/system/update'));
			} catch {
				// the server may be restarting or rebooting; keep trying
			}
			if ((rounds > 3 && !running) || rounds > 600) clearInterval(timer);
		}, 3000);
	}
	onDestroy(() => clearInterval(timer));

	// Following Ledger's repository after a rename on GitHub (same repository only).
	let editingRepo = $state(false);
	let repoInput = $state('');
	let repoSaved = $state('');
	async function saveRepo(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		repoSaved = '';
		busy = true;
		try {
			info = unwrap(await api().PUT('/system/update/repo', { body: { repo: repoInput } }));
			repoSaved = `Updates now come from ${info.repo.current}.`;
			editingRepo = false;
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function checkNow() {
		error = null;
		busy = true;
		try {
			info = unwrap(await api().POST('/system/update/check'));
			poll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
</script>


<div class="card">
	<p style="margin-top:0">
		Installed version: <strong>{info.current_version}</strong>
		{#if info.status?.latest_version}
			<span class="muted">· latest on GitHub: {info.status.latest_version}</span>
		{/if}
	</p>
	{#if repoSaved}<div class="notice ok">{repoSaved}</div>{/if}
	{#if editingRepo}
		<form class="repo-edit" onsubmit={saveRepo}>
			<input bind:value={repoInput} required aria-label="Ledger's repository" placeholder="owner/name or https://github.com/owner/name" />
			<button class="primary" disabled={busy}>Save</button>
			<button type="button" onclick={() => (editingRepo = false)}>Cancel</button>
		</form>
		<p class="muted small">
			For when Ledger's repository was renamed or moved on GitHub. Only the same repository is accepted (GitHub keeps its id
			across renames), because the updater installs from it with full rights.
		</p>
	{:else}
		<p class="small">
			Updates come from <a href="https://github.com/{info.repo.current}" target="_blank" rel="noreferrer">github.com/{info.repo.current}</a>
			{#if info.updater_installed}<button class="link" onclick={() => ((editingRepo = true), (repoInput = info.repo.current))}>Change</button>{/if}
			{#if info.repo.current !== info.repo.installed}<span class="muted">(renamed from {info.repo.installed})</span>{/if}
		</p>
	{/if}
	{#if !info.updater_installed}
		<div class="notice error">
			Automatic updates aren't set up on this server. They are installed with the release (<code>deploy/install.sh</code>).
		</div>
	{:else}
		{#if info.status}
			<p>
				{#if info.status.state === 'running'}<span class="badge warn">Running</span>
				{:else if info.status.state === 'error'}<span class="badge danger">Failed</span>
				{:else if info.status.state === 'ok'}<span class="badge ok">OK</span>{/if}
				{info.status.message}
			</p>
			<p class="muted small">
				Last run: {fmt(info.status.started_at)} ({info.status.trigger ?? '—'})
				{#if info.status.finished_at}· finished {fmt(info.status.finished_at)}{/if}
			</p>
		{:else}
			<p class="muted">The updater hasn't run yet.</p>
		{/if}
		<p class="muted small">Next scheduled run: {info.next_run_at ? fmt(info.next_run_at) : 'none (schedule off)'}</p>
		<button onclick={checkNow} disabled={busy || running}>Check for updates now</button>
		<span class="muted small">Installs a newer release if there is one. Reboots only if it installed one (and reboot isn't set to never).</span>
	{/if}
</div>

<form class="card" onsubmit={save} style="max-width:640px">
	<h2 style="margin-top:0">Schedule</h2>
	{#if saved}<div class="notice ok">Schedule saved.</div>{/if}
	<ErrorNotice {error} />
	<div style="display:flex; flex-direction:column; gap:0.9rem">
		<label class="inline"><input type="checkbox" bind:checked={form.on_startup} /> Update when the server starts</label>
		<p class="muted small" style="margin:-0.6rem 0 0 1.6rem">
			About a minute after the container boots, check for a new Ledger release and module updates and install them, like
			“Check for updates now”. Works with or without the schedule below.
		</p>
		<label class="inline"><input type="checkbox" bind:checked={form.enabled} /> Install updates automatically on a schedule</label>
		<fieldset style="border:none; padding:0; margin:0">
			<legend class="muted small" style="margin-bottom:0.3rem">Days</legend>
			<div style="display:flex; flex-wrap:wrap; gap:0.75rem">
				{#each DAYS as name, d (d)}
					<label class="inline"><input type="checkbox" checked={form.days.includes(d)} onchange={() => toggleDay(d)} /> {name}</label>
				{/each}
			</div>
		</fieldset>
		<div style="display:flex; flex-wrap:wrap; gap:1rem">
			<label>Time <input type="time" bind:value={form.time} required /></label>
			<label>
				Time zone
				<select bind:value={form.timezone}>
					{#if !zones.includes(form.timezone)}<option value={form.timezone}>{form.timezone}</option>{/if}
					{#each zones as z (z)}<option value={z}>{z}</option>{/each}
				</select>
			</label>
		</div>
		<label>
			Reboot the container
			<select bind:value={form.reboot}>
				<option value="always">Every scheduled run, even if already up to date</option>
				<option value="after_update">Only after installing an update</option>
				<option value="never">Never (the app restarts by itself after an update)</option>
			</select>
		</label>
		<div><button class="primary" disabled={busy || !info.updater_installed || form.days.length === 0}>Save schedule</button></div>
	</div>
	<p class="muted small" style="margin-bottom:0">
		Before installing, the server backs up the database to the destinations under
		<a href="/settings/backups">Backups</a>. If the new version doesn't start, it puts the previous one back.
	</p>
</form>

<style>
	.repo-edit {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.repo-edit input {
		flex: 1;
		min-width: 14rem;
	}
	button.link {
		background: none;
		border: none;
		padding: 0 0.3rem;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
</style>
