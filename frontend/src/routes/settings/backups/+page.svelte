<script lang="ts">
	import { onDestroy } from 'svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type BackupInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const zones: string[] = (() => {
		try {
			return Intl.supportedValuesOf('timeZone');
		} catch {
			return [Intl.DateTimeFormat().resolvedOptions().timeZone];
		}
	})();

	type Form = {
		schedule: BackupInfo['config']['schedule'];
		truenas: BackupInfo['config']['truenas'];
		google: { enabled: boolean; client_id: string; client_secret: string; keep_count: number };
	};
	let info = $state<BackupInfo>(undefined!);
	let form = $state<Form>(undefined!);
	$effect.pre(() => {
		load(data.info);
	});
	function load(i: BackupInfo) {
		info = i;
		form = {
			schedule: { ...i.config.schedule, days: [...i.config.schedule.days] },
			truenas: { ...i.config.truenas },
			google: { enabled: i.config.google.enabled, client_id: i.config.google.client_id, client_secret: '', keep_count: i.config.google.keep_count }
		};
	}

	let busy = $state(false);
	let error: unknown = $state(null);
	let saved = $state(false);
	let shareTest = $state<{ ok: boolean; message: string } | null>(null);
	let device = $state<{ user_code: string; verification_url: string } | null>(null);
	let deviceMsg = $state('');
	let showGoogleHelp = $state(false);

	const running = $derived(info.status.state === 'running');
	const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
	const size = (b: number | null) => (b === null ? '' : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KiB` : `${(b / 1024 / 1024).toFixed(1)} MiB`);
	const stateBadge: Record<string, [string, string]> = {
		running: ['warn', 'Running'],
		ok: ['ok', 'OK'],
		warning: ['warn', 'Partly failed'],
		error: ['danger', 'Failed']
	};

	function toggleDay(d: number) {
		form.schedule.days = form.schedule.days.includes(d) ? form.schedule.days.filter((x) => x !== d) : [...form.schedule.days, d].sort();
	}

	async function act(fn: () => Promise<unknown>) {
		error = null;
		saved = false;
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
			const google = { ...form.google, client_secret: form.google.client_secret || null };
			load(unwrap(await api().PUT('/backups/config', { body: { ...form, google } })));
			saved = true;
		});
	};

	const testShare = () =>
		act(async () => {
			shareTest = unwrap(await api().POST('/backups/truenas/test', { body: { path: form.truenas.path } }));
		});

	// While a backup runs, refresh every few seconds.
	let timer: ReturnType<typeof setInterval> | undefined;
	function poll() {
		clearInterval(timer);
		timer = setInterval(async () => {
			try {
				info = unwrap(await api().GET('/backups'));
			} catch {
				// keep trying
			}
			if (info.status.state !== 'running') clearInterval(timer);
		}, 2000);
	}
	let pollGoogle: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => {
		clearInterval(timer);
		clearTimeout(pollGoogle);
	});

	const runNow = () =>
		act(async () => {
			info = unwrap(await api().POST('/backups/run'));
			poll();
		});

	// Google: save the client first, then show Google's code and wait for approval.
	const connect = () =>
		act(async () => {
			const google = { ...form.google, client_secret: form.google.client_secret || null };
			load(unwrap(await api().PUT('/backups/config', { body: { ...form, google } })));
			const r = unwrap(await api().POST('/backups/google/connect'));
			device = r;
			deviceMsg = 'Waiting for you to approve…';
			const tick = async () => {
				try {
					const p = unwrap(await api().POST('/backups/google/poll'));
					if (p.state === 'pending') {
						pollGoogle = setTimeout(tick, r.interval * 1000);
						return;
					}
					device = null;
					deviceMsg =
						p.state === 'connected'
							? `Connected as ${p.account || 'your Google account'}.`
							: p.state === 'denied'
								? 'Access was denied.'
								: 'The code expired; connect again.';
					load(unwrap(await api().GET('/backups')));
				} catch (e) {
					device = null;
					deviceMsg = '';
					error = e;
				}
			};
			pollGoogle = setTimeout(tick, r.interval * 1000);
		});

	const disconnect = () =>
		act(async () => {
			if (!confirm('Disconnect Google Drive? Backups already in Drive stay there.')) return;
			load(unwrap(await api().POST('/backups/google/disconnect')));
			deviceMsg = '';
		});
</script>

{#if !info.available}
	<div class="notice error">
		Backups aren't set up on this server (no <code>/var/lib/ledger/backup</code>). Update Ledger, or install a release
		with <code>deploy/install.sh</code>.
	</div>
{/if}

<ErrorNotice {error} />
{#if saved}<div class="notice ok">Settings saved.</div>{/if}

<div class="card">
	<div class="toolbar" style="margin:0">
		<div>
			{#if info.status.state in stateBadge}
				<span class="badge {stateBadge[info.status.state]![0]}">{stateBadge[info.status.state]![1]}</span>
			{/if}
			{info.status.message || 'No backup has run since backups moved into the app.'}
		</div>
		<span class="spacer"></span>
		<button class="primary" onclick={runNow} disabled={busy || running || !info.available}>Back up now</button>
	</div>
	{#if info.status.results.length}
		<ul class="results">
			{#each info.status.results as r (r.target)}
				<li class:bad={!r.ok}>{r.ok ? '✓' : '✗'} <strong>{r.target === 'truenas' ? 'TrueNAS' : 'Google Drive'}</strong>: {r.message}</li>
			{/each}
		</ul>
	{/if}
	<p class="muted small" style="margin-bottom:0">
		Last run: {fmt(info.status.started_at) + (info.status.trigger ? ` (${info.status.trigger})` : '')}
		{#if info.status.size_bytes}· {size(info.status.size_bytes)}{/if}
		· Next: {info.next_run ? fmt(info.next_run) : 'none (schedule off)'}
	</p>
</div>

<form onsubmit={save}>
	<section class="card">
		<h2>Schedule</h2>
		<label class="inline"><input type="checkbox" bind:checked={form.schedule.enabled} /> Back up automatically</label>
		<div class="days">
			{#each DAYS as name, d (d)}
				<label class="inline"><input type="checkbox" checked={form.schedule.days.includes(d)} onchange={() => toggleDay(d)} /> {name}</label>
			{/each}
		</div>
		<div class="row">
			<label>Time <input type="time" bind:value={form.schedule.time} required /></label>
			<label>
				Time zone
				<select bind:value={form.schedule.timezone}>
					{#if !zones.includes(form.schedule.timezone)}<option value={form.schedule.timezone}>{form.schedule.timezone}</option>{/if}
					{#each zones as z (z)}<option value={z}>{z}</option>{/each}
				</select>
			</label>
		</div>
		<p class="muted small">Ledger also backs up before installing an update.</p>
	</section>

	<section class="card">
		<h2>
			<label class="inline big"><input type="checkbox" bind:checked={form.truenas.enabled} /> TrueNAS share</label>
		</h2>
		<p class="muted small">
			A dataset on your TrueNAS, mounted into this container (a Proxmox bind mount). ZFS snapshots and replication
			then cover the backups too.
		</p>
		<div class="row">
			<label style="flex:1; min-width:16rem">
				Folder in the container
				<input bind:value={form.truenas.path} required placeholder="/app/csv_data/backups" />
			</label>
			<label>Keep for (days) <input type="number" min="1" max="3650" bind:value={form.truenas.keep_days} required style="width:7rem" /></label>
			<button type="button" onclick={testShare} disabled={busy || !info.available}>Test</button>
		</div>
		{#if shareTest}<div class="notice {shareTest.ok ? 'ok' : 'error'}">{shareTest.message}</div>{/if}
		<details>
			<summary class="small">How to mount a TrueNAS share</summary>
			<ol class="small">
				<li>On TrueNAS, share a dataset over NFS (or SMB) with the Proxmox host.</li>
				<li>
					On the Proxmox host, mount it, e.g. <strong>Datacenter → Storage → Add → NFS</strong> (it appears under
					<code>/mnt/pve/&lt;name&gt;</code>).
				</li>
				<li>
					Bind-mount it into this container (on the host): <code>pct set &lt;CTID&gt; -mp0 /mnt/pve/&lt;name&gt;,mp=/app/csv_data</code>,
					then restart the container.
				</li>
				<li>
					Unprivileged containers map uid 990 to 100990 on the host: on the host run
					<code>chown 100990:100990 /mnt/pve/&lt;name&gt;</code> (or allow that uid on the TrueNAS share).
				</li>
				<li>Press <strong>Test</strong> above. Paths under <code>/app/csv_data</code> or <code>/mnt</code> can be used.</li>
			</ol>
		</details>
		{#if info.share_files.length}
			<h3 class="small muted">Newest backups on the share</h3>
			<table class="files">
				<tbody>
					{#each info.share_files as f (f.name)}
						<tr><td class="mono">{f.name}</td><td class="num">{size(f.size_bytes)}</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="card">
		<h2>
			<label class="inline big"><input type="checkbox" bind:checked={form.google.enabled} /> Google Drive</label>
		</h2>
		<p class="muted small">
			Uploads each backup to a <strong>Ledger backups</strong> folder in your Drive. Ledger can only see files it created
			there, nothing else in your Drive.
		</p>
		{#if info.config.google.connected}
			<div class="notice ok">
				Connected as <strong>{info.config.google.account || 'your Google account'}</strong>.
				<button type="button" class="link" onclick={disconnect} disabled={busy}>Disconnect</button>
			</div>
		{/if}
		<div class="row">
			<label style="flex:1; min-width:16rem">
				OAuth client ID
				<input bind:value={form.google.client_id} placeholder="1234567890-abc….apps.googleusercontent.com" autocomplete="off" />
			</label>
			<label style="flex:1; min-width:12rem">
				Client secret
				<input
					type="password"
					bind:value={form.google.client_secret}
					autocomplete="new-password"
					placeholder={info.config.google.has_client_secret ? '•••••••• (saved)' : ''}
				/>
			</label>
			<label>Keep newest <input type="number" min="1" max="1000" bind:value={form.google.keep_count} required style="width:6rem" /></label>
		</div>
		{#if device}
			<div class="notice device">
				Open <a href={device.verification_url} target="_blank" rel="noopener noreferrer">{device.verification_url}</a> and enter
				<strong class="code">{device.user_code}</strong>
				<div class="small">{deviceMsg}</div>
			</div>
		{:else if deviceMsg}
			<p class="small">{deviceMsg}</p>
		{/if}
		{#if !info.config.google.connected}
			<button type="button" onclick={connect} disabled={busy || !!device || !form.google.client_id || !info.available || (!form.google.client_secret && !info.config.google.has_client_secret)}>
				Save and connect Google Drive
			</button>
		{/if}
		<button type="button" class="link small" onclick={() => (showGoogleHelp = !showGoogleHelp)}>How do I get a client ID?</button>
		{#if showGoogleHelp}
			<ol class="small">
				<li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">console.cloud.google.com</a> and create a project (e.g. "Ledger").</li>
				<li><strong>APIs &amp; Services → Library</strong>: enable the <strong>Google Drive API</strong>.</li>
				<li>
					<strong>OAuth consent screen</strong>: choose <em>External</em>, fill in the app name and your email, and add
					yourself as a test user. Then <strong>Publish app</strong> (status <em>In production</em>): otherwise Google
					disconnects Ledger every 7 days. The <code>drive.file</code> permission Ledger asks for doesn't need Google's review.
				</li>
				<li>
					<strong>Credentials → Create credentials → OAuth client ID</strong>, application type
					<strong>TVs and Limited Input devices</strong>. Copy the client ID and secret here.
				</li>
				<li>Press <strong>Save and connect</strong>, open the link shown, and enter the code.</li>
			</ol>
		{/if}
	</section>

	<p>
		<button class="primary" disabled={busy || !info.available || form.schedule.days.length === 0}>Save settings</button>
		<span class="muted small">Backups contain all your books and password hashes; keep the destinations private.</span>
	</p>
</form>

<details class="card small">
	<summary>Restoring a backup</summary>
	<p>
		Backups are PostgreSQL dumps (<code>pg_restore</code> format). To restore one, follow
		<a href="https://github.com/mastifdogo/Bookeeping/blob/main/docs/DEPLOYMENT.md#8-backups-and-restore" target="_blank" rel="noopener noreferrer"
			>Backups and restore</a
		> in the deployment guide. From Google Drive, download the file first and copy it into the container.
	</p>
</details>

<style>
	section h2 {
		margin-top: 0;
	}
	.big {
		font-size: 1.1rem;
		color: var(--text);
		font-weight: 600;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
		margin: 0.5rem 0;
	}
	.days {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.6rem 0;
	}
	.results {
		margin: 0.6rem 0 0.4rem;
		padding-left: 1.1rem;
		list-style: none;
		padding: 0;
	}
	.results li {
		color: var(--ok);
	}
	.results li.bad {
		color: var(--danger);
	}
	.files {
		max-width: 520px;
	}
	.code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 1.3rem;
		letter-spacing: 0.08em;
		margin-left: 0.3rem;
	}
	.device {
		background: var(--warn-bg);
		color: var(--text);
	}
	button.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		margin-left: 0.5rem;
	}
	details summary {
		cursor: pointer;
		color: var(--accent);
	}
	h3 {
		margin: 1rem 0 0.3rem;
	}
</style>
