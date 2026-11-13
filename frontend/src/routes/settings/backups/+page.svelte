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
		include_csv: boolean;
		share: Omit<BackupInfo['config']['share'], 'has_password'> & { password: string };
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
			include_csv: i.config.include_csv,
			share: (({ has_password: _, ...rest }) => ({ ...rest, password: '' }))(i.config.share),
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
			load(unwrap(await api().PUT('/backups/config', { body: body() })));
			saved = true;
		});
	};

	/** Settings to send: blank secrets keep the saved ones. */
	const body = () => ({
		schedule: form.schedule,
		include_csv: form.include_csv,
		share: { ...form.share, password: form.share.password || null },
		google: { ...form.google, client_secret: form.google.client_secret || null }
	});

	const testShare = () =>
		act(async () => {
			shareTest = unwrap(await api().POST('/backups/share/test', { body: { ...form.share, password: form.share.password || null } }));
		});

	// Restore: the backups that can be restored are listed when the card is opened.
	type Restorable = { source: 'share' | 'google'; name: string; size_bytes: number; modified_at: string };
	let restorable = $state<Restorable[] | null>(null);
	let restoreProblems = $state<string[]>([]);
	let confirmWord = $state('RESTORE');
	let chosen = $state('');
	let typed = $state('');
	let restoreError: unknown = $state(null);
	let unreachable = $state(false);
	const restoring = $derived(info.restore.state === 'running');
	const when = (name: string) => {
		const m = /^ledger-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-\d{2}([+-]\d{2})(\d{2})$/.exec(name);
		return m ? `${m[1]} ${m[2]}:${m[3]} (UTC${m[4]}:${m[5]})` : name;
	};
	async function loadRestorable() {
		restoreError = null;
		try {
			const r = unwrap(await api().GET('/backups/restorable'));
			restorable = r.backups;
			restoreProblems = r.problems;
			confirmWord = r.confirm;
		} catch (e) {
			restoreError = e;
		}
	}
	async function restore() {
		const [source, name] = chosen.split('|') as ['share' | 'google', string];
		if (!name || typed !== confirmWord) return;
		restoreError = null;
		busy = true;
		try {
			info = unwrap(await api().POST('/backups/restore', { body: { source, backup: name, confirm: typed } }));
			typed = '';
			chosen = '';
			pollRestore();
		} catch (e) {
			restoreError = e;
		} finally {
			busy = false;
		}
	}
	// Ledger stops for a moment during the switch, so failed requests are expected.
	let restoreTimer: ReturnType<typeof setInterval> | undefined;
	function pollRestore() {
		clearInterval(restoreTimer);
		restoreTimer = setInterval(async () => {
			try {
				const r = await api().GET('/backups');
				if (r.data) {
					info = r.data;
					unreachable = false;
				} else if (r.response.status === 401) {
					// The restored data doesn't have this session: sign in again.
					clearInterval(restoreTimer);
					location.href = '/login';
					return;
				} else unreachable = true;
			} catch {
				unreachable = true;
			}
			if (!unreachable && info.restore.state !== 'running') {
				clearInterval(restoreTimer);
				restorable = null;
			}
		}, 3000);
	}
	$effect(() => {
		if (info.restore.state === 'running' && !restoreTimer) pollRestore();
	});
	onDestroy(() => clearInterval(restoreTimer));

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
			load(unwrap(await api().PUT('/backups/config', { body: body() })));
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
				<li class:bad={!r.ok}>{r.ok ? '✓' : '✗'} <strong>{r.target === 'share' ? 'Network share' : 'Google Drive'}</strong>: {r.message}</li>
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
		<label class="inline"><input type="checkbox" bind:checked={form.include_csv} /> Also save CSV copies beside each backup</label>
		<p class="muted small" style="margin:0.2rem 0 0 1.6rem">
			A General Ledger CSV and each module's data as CSV (one file per module, or per table when a module has several), for the
			main books and every organization. They open in a spreadsheet; the <code>.dump</code> file is still what restores Ledger.
		</p>
	</section>

	<section class="card">
		<h2>
			<label class="inline big"><input type="checkbox" bind:checked={form.share.enabled} /> Network share (SMB)</label>
		</h2>
		<p class="muted small">
			A shared folder on a NAS or another computer: TrueNAS, Synology, QNAP, Unraid, Windows, a Samba server… Ledger saves
			each backup there and removes ones older than you choose.
		</p>
		<div class="segmented" role="radiogroup" aria-label="How Ledger reaches the share">
			<label class:on={form.share.mode === 'smb'}><input type="radio" value="smb" bind:group={form.share.mode} /> Connect to the share</label>
			<label class:on={form.share.mode === 'folder'}><input type="radio" value="folder" bind:group={form.share.mode} /> Folder mounted into this container</label>
		</div>
		{#if form.share.mode === 'smb'}
			<div class="row">
				<label style="flex:1; min-width:12rem">Server <input bind:value={form.share.server} required placeholder="nas.local or 192.168.1.20" autocomplete="off" /></label>
				<label style="flex:1; min-width:9rem">Share <input bind:value={form.share.share} required placeholder="backups" autocomplete="off" /></label>
				<label style="flex:1; min-width:9rem">Folder in the share <input bind:value={form.share.directory} placeholder="ledger" autocomplete="off" /></label>
			</div>
			<div class="row">
				<label style="flex:1; min-width:10rem">User name <input bind:value={form.share.username} autocomplete="off" placeholder="guest if empty" /></label>
				<label style="flex:1; min-width:10rem">
					Password
					<input type="password" bind:value={form.share.password} autocomplete="new-password" placeholder={info.config.share.has_password ? '•••••••• (saved)' : ''} />
				</label>
				<label style="min-width:8rem">Domain <input bind:value={form.share.domain} autocomplete="off" placeholder="optional" style="width:9rem" /></label>
			</div>
			<p class="muted small">
				Shown as <code>\\{form.share.server || 'server'}\{form.share.share || 'share'}{form.share.directory ? '\\' + form.share.directory.replaceAll('/', '\\') : ''}</code>.
				The folder is created if it's missing. Give Ledger a user of its own that may write only to this share.
			</p>
		{:else}
			<p class="muted small">
				For a share mounted on the Proxmox host and bind-mounted into this container (ZFS snapshots and replication
				then cover the backups too).
			</p>
			<div class="row">
				<label style="flex:1; min-width:16rem">
					Folder in the container
					<input bind:value={form.share.path} required placeholder="/app/csv_data/backups" />
				</label>
			</div>
			<details>
				<summary class="small">How to mount a share into the container</summary>
				<ol class="small">
					<li>On the NAS, share a folder over NFS or SMB with the Proxmox host.</li>
					<li>
						On the Proxmox host, mount it, e.g. <strong>Datacenter → Storage → Add → NFS / SMB/CIFS</strong> (it appears under
						<code>/mnt/pve/&lt;name&gt;</code>).
					</li>
					<li>
						Bind-mount it into this container (on the host): <code>pct set &lt;CTID&gt; -mp0 /mnt/pve/&lt;name&gt;,mp=/app/csv_data</code>,
						then restart the container.
					</li>
					<li>
						Unprivileged containers map uid 990 to 100990 on the host: on the host run
						<code>chown 100990:100990 /mnt/pve/&lt;name&gt;</code> (or allow that uid on the share).
					</li>
					<li>Press <strong>Test</strong> below. Paths under <code>/app/csv_data</code> or <code>/mnt</code> can be used.</li>
				</ol>
			</details>
		{/if}
		<div class="row">
			<label>Keep for (days) <input type="number" min="1" max="3650" bind:value={form.share.keep_days} required style="width:7rem" /></label>
			<button type="button" onclick={testShare} disabled={busy || !info.available}>Test</button>
		</div>
		{#if shareTest}<div class="notice {shareTest.ok ? 'ok' : 'error'}">{shareTest.message}</div>{/if}
		{#if info.share_files.length}
			<h3 class="small muted">Newest backups on the share (one folder each, named with its date and time)</h3>
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

<section class="card restore">
	<h2>Restore from a backup</h2>
	<p class="muted small">
		Replaces <strong>everything</strong> in Ledger with what a backup holds: all books (every organization), users, module data and
		the files modules keep. Ledger backs up the current data first, then stops for a moment while it switches. Anything entered since
		the chosen backup is no longer in Ledger afterwards (it is in the backup made just before the restore).
	</p>
	<p class="muted small">
		Settings kept in the books come from the backup: each module's settings, organizations, users and their roles, sidebar layouts.
		Settings kept on the server stay as they are now: these backup settings, the update schedule, LLM API and Gmail connections, and
		which modules are installed.
	</p>
	<ErrorNotice error={restoreError} />
	{#if restoring}
		<div class="notice device">
			<strong>Restoring {when(info.restore.backup)}…</strong>
			{info.restore.message}
			{#if unreachable}<br />Ledger is restarting; this page reconnects by itself.{/if}
		</div>
	{:else}
		{#if info.restore.state === 'ok'}
			<div class="notice ok">{info.restore.message} <span class="muted">({fmt(info.restore.finished_at)})</span></div>
		{:else if info.restore.state === 'error'}
			<div class="notice error">The restore from {when(info.restore.backup)} failed. {info.restore.message} <span class="muted">({fmt(info.restore.finished_at)})</span></div>
		{/if}
		{#if restorable === null}
			<button type="button" onclick={loadRestorable} disabled={!info.available || running}>Choose a backup to restore…</button>
		{:else}
			{#each restoreProblems as p (p)}<p class="warn-text small">{p}</p>{/each}
			{#if restorable.length === 0}
				<p>No backups were found on the destinations that are turned on.</p>
			{:else}
				<div class="row">
					<label>
						Backup
						<select bind:value={chosen}>
							<option value="">— choose —</option>
							{#each restorable as b (b.source + b.name)}
								<option value={`${b.source}|${b.name}`}>
									{when(b.name)} · {b.source === 'share' ? 'network share' : 'Google Drive'}{b.size_bytes ? ` · ${size(b.size_bytes)}` : ''}
								</option>
							{/each}
						</select>
					</label>
					{#if chosen}
						<label>
							Type {confirmWord} to confirm
							<input bind:value={typed} autocomplete="off" spellcheck="false" size="10" />
						</label>
						<button type="button" class="danger" onclick={restore} disabled={busy || running || typed !== confirmWord}>Restore this backup</button>
					{/if}
				</div>
				{#if chosen}
					<p class="small">
						Users, passwords and sign-ins come from that backup too, so you may have to sign in again with the password you had
						then. The backup must come from this version of Ledger or an older one.
					</p>
				{/if}
			{/if}
		{/if}
	{/if}
	<p class="muted small">
		Restoring by hand on the server:
		<a href="https://github.com/mastifdogo/Bookeeping/blob/main/docs/DEPLOYMENT.md#8-backups-and-restore" target="_blank" rel="noopener noreferrer"
			>Backups and restore</a
		> in the deployment guide.
	</p>
</section>

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
	.segmented {
		display: inline-flex;
		flex-wrap: wrap;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		margin: 0.25rem 0 0.5rem;
	}
	.segmented label {
		display: flex;
		flex-direction: row;
		align-items: center;
		padding: 0.4rem 0.8rem;
		cursor: pointer;
		color: var(--text);
		border-right: 1px solid var(--border);
	}
	.segmented label:last-child {
		border-right: none;
	}
	.segmented label.on {
		background: var(--accent);
		color: var(--accent-text);
	}
	.segmented input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.segmented label:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
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
	.restore select {
		width: auto;
		max-width: 100%;
	}
	.warn-text {
		color: var(--warn);
	}
</style>
