<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type GmailInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let info = $state<GmailInfo>(undefined!);
	let clientId = $state('');
	let clientSecret = $state('');
	let allowRead = $state<string[]>([]);
	let allowSend = $state<string[]>([]);
	$effect.pre(() => load(data.info));
	function load(i: GmailInfo) {
		info = i;
		clientId = i.config.client_id;
		clientSecret = '';
		allowRead = [...i.config.allow_read];
		allowSend = [...i.config.allow_send];
	}

	let busy = $state(false);
	let error: unknown = $state(null);
	let notice = $state('');
	// Most setups send invoices, so sending is asked for unless unticked.
	let wantSend = $state(true);
	let authUrl = $state('');
	let pasted = $state('');
	let showHelp = $state(false);

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

	const saveClient = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			load(unwrap(await api().PUT('/integrations/gmail', { body: { client_id: clientId, client_secret: clientSecret || null } })));
			notice = 'OAuth client saved.';
		});
	};
	const connect = (send = wantSend) =>
		act(async () => {
			wantSend = send;
			const r = unwrap(await api().POST('/integrations/gmail/start', { body: { send } }));
			authUrl = r.auth_url;
			window.open(authUrl, '_blank', 'noopener');
		});
	const finish = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			load(unwrap(await api().POST('/integrations/gmail/finish', { body: { url: pasted } })));
			authUrl = pasted = '';
			notice =
				wantSend && !info.config.can_send
					? `Connected as ${info.config.account}, but Google didn't allow sending: tick "Send email on your behalf" on Google's page and try again.`
					: `Connected as ${info.config.account}: ${info.config.can_send ? 'read and send' : 'read'} mail.`;
		});
	};
	const disconnect = () =>
		act(async () => {
			if (!confirm('Disconnect Gmail? Modules lose access until it is connected again.')) return;
			load(unwrap(await api().POST('/integrations/gmail/disconnect')));
		});
	const saveGrants = () =>
		act(async () => {
			load(unwrap(await api().PUT('/integrations/gmail', { body: { allow_read: allowRead, allow_send: allowSend } })));
			notice = 'Saved.';
		});
	const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id].sort() : list.filter((x) => x !== id));
</script>

{#if !info.available}
	<div class="notice error">Gmail settings aren't set up on this server (no <code>/var/lib/ledger/integrations</code>). Update Ledger, or run <code>deploy/install.sh</code>.</div>
{/if}
<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<p class="muted" style="margin-top:0">
	Connect one Gmail account for Ledger's modules: reading bills and receipts, sending invoices. Each module needs your
	permission below, separately for reading and sending. The tokens stay on the server.
</p>

<section class="card">
	<h2>Account</h2>
	{#if authUrl}
		<ol>
			<li>
				A Google page opened in a new tab (<a href={authUrl} target="_blank" rel="noopener noreferrer">open it again</a>). Choose your account and allow
				access{wantSend ? ', with sending ticked' : ''}. If Google warns that the app isn't verified, choose <em>Advanced → Go to … (unsafe)</em>: it's your
				own app.
			</li>
			<li>Your browser then lands on a page that doesn't load, starting with <code>{info.config.redirect_uri}</code>. That's expected.</li>
			<li>Copy that whole address from the address bar and paste it here:</li>
		</ol>
		<form class="row" onsubmit={finish}>
			<input bind:value={pasted} required placeholder="http://127.0.0.1/?state=…&code=…" style="flex:1; min-width:16rem" />
			<button class="primary" disabled={busy}>Finish</button>
			<button type="button" onclick={() => (authUrl = '')}>Cancel</button>
		</form>
	{:else if info.config.connected}
		<p>
			Connected as <strong>{info.config.account}</strong>:
			{info.config.can_read ? 'read' : ''}{info.config.can_read && info.config.can_send ? ' and ' : ''}{info.config.can_send ? 'send' : ''} mail.
		</p>
		{#if !info.config.can_send}
			<div class="notice warn-box">
				Gmail was connected without permission to send, so modules can't email (the Send mail boxes below are off).
				<button class="primary" disabled={busy || !info.available} onclick={() => connect(true)}>Allow sending mail</button>
			</div>
		{/if}
		<button disabled={busy} onclick={disconnect}>Disconnect</button>
	{:else if !info.config.client_id || !info.config.has_client_secret}
		<p class="muted">First save a Google OAuth client below.</p>
	{:else}
		<label class="inline"><input type="checkbox" bind:checked={wantSend} /> Allow sending mail too (for modules that email invoices)</label>
		<p><button class="primary" disabled={busy || !info.available} onclick={() => connect()}>Connect Gmail</button></p>
	{/if}
</section>

{#if info.config.connected}
	<section class="card">
		<h2>Modules that may use it</h2>
		{#if info.modules.length === 0}
			<p class="muted">No modules are installed.</p>
		{:else}
			<table>
				<thead>
					<tr><th>Module</th><th>Read mail</th><th>Send mail{#if !info.config.can_send}<span class="muted small" style="text-transform:none">&nbsp;(allow sending above first)</span>{/if}</th></tr>
				</thead>
				<tbody>
					{#each info.modules as m (m.id)}
						<tr>
							<td>{m.name} <span class="muted small">({m.id})</span></td>
							<td><input type="checkbox" aria-label="{m.name} may read mail" checked={allowRead.includes(m.id)} onchange={(e) => (allowRead = toggle(allowRead, m.id, e.currentTarget.checked))} /></td>
							<td>
								<input
									type="checkbox"
									aria-label="{m.name} may send mail"
									disabled={!info.config.can_send}
									title={info.config.can_send ? undefined : 'Gmail was connected without permission to send: press "Allow sending mail" above'}
									checked={allowSend.includes(m.id)}
									onchange={(e) => (allowSend = toggle(allowSend, m.id, e.currentTarget.checked))}
								/>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p style="margin-bottom:0"><button class="primary" disabled={busy} onclick={saveGrants}>Save</button></p>
		{/if}
	</section>
{/if}

<form class="card" onsubmit={saveClient}>
	<h2>Google OAuth client</h2>
	<div class="row">
		<label style="flex:1; min-width:16rem">Client ID <input bind:value={clientId} placeholder="1234567890-abc….apps.googleusercontent.com" autocomplete="off" /></label>
		<label style="flex:1; min-width:12rem">
			Client secret
			<input type="password" bind:value={clientSecret} autocomplete="new-password" placeholder={info.config.has_client_secret ? '•••••••• (saved)' : ''} />
		</label>
		<button class="primary" disabled={busy || !info.available}>Save</button>
	</div>
	<p class="muted small">Changing the client ID disconnects the account.</p>
	<button type="button" class="link" onclick={() => (showHelp = !showHelp)}>How do I get a client ID?</button>
	{#if showHelp}
		<ol class="small">
			<li>
				Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">console.cloud.google.com</a> and pick or create a project
				(the one from Backups is fine).
			</li>
			<li><strong>APIs &amp; Services → Library</strong>: enable the <strong>Gmail API</strong>.</li>
			<li>
				<strong>OAuth consent screen</strong>: <em>External</em>, your app name and email, and add your Gmail address as a test user. Gmail permissions are
				"restricted", so while the app is in <em>Testing</em> Google disconnects it every 7 days. To avoid that, <strong>Publish app</strong>; for your own
				account you can use it unverified (you'll click past a warning once).
			</li>
			<li>
				<strong>Credentials → Create credentials → OAuth client ID</strong>, type <strong>Desktop app</strong>. Copy the client ID and secret here and save.
			</li>
			<li>Press <strong>Connect Gmail</strong> above.</li>
		</ol>
	{/if}
</form>

<style>
	section h2,
	form h2 {
		margin-top: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
		margin: 0.5rem 0;
	}
	.warn-box {
		background: var(--warn-bg);
		color: var(--text);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	td input[type='checkbox'] {
		width: auto;
	}
	button.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
	}
</style>
