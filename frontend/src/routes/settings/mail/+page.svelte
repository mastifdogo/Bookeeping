<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import GmailSettings from '#lib/components/GmailSettings.svelte';
	import { api, unwrap, type GmailInfo, type MailInfo } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Config = MailInfo['config'];
	type Security = Config['imap_security'];
	const SECURITY_LABELS: Record<string, string> = { starttls: 'STARTTLS', tls: 'TLS', none: 'None (not encrypted)' };

	let info = $state<MailInfo>(undefined!);
	let f = $state({
		account: '',
		from_name: '',
		username: '',
		password: '',
		imap_host: '',
		imap_port: 993,
		imap_security: 'tls' as Security,
		smtp_host: '',
		smtp_port: 465,
		smtp_security: 'tls' as Security,
		folder: 'INBOX',
		trust_certificate: false
	});
	let allowRead = $state<string[]>([]);
	let allowSend = $state<string[]>([]);
	let note = $state('');
	let checks = $state<{ imap: { ok: boolean; message: string }; smtp: { ok: boolean; message: string } } | null>(null);
	$effect.pre(() => load(data.info));
	function load(i: MailInfo) {
		info = i;
		const c = i.config;
		f = {
			account: c.account,
			from_name: c.from_name,
			username: c.username,
			password: '',
			imap_host: c.imap_host,
			imap_port: c.imap_port,
			imap_security: c.imap_security,
			smtp_host: c.smtp_host,
			smtp_port: c.smtp_port,
			smtp_security: c.smtp_security,
			folder: c.folder,
			trust_certificate: c.trust_certificate
		};
		allowRead = [...c.allow_read];
		allowSend = [...c.allow_send];
	}

	let gmail = $state<GmailInfo>(undefined!);
	$effect.pre(() => {
		gmail = data.gmail;
	});
	// Two kinds of mailbox share this tab; start on the one in use.
	let kind = $state<'imap' | 'gmail'>('imap');
	$effect.pre(() => {
		kind = data.kind === 'gmail' || data.kind === 'imap' ? data.kind : !data.info.config.connected && data.gmail.config.connected ? 'gmail' : 'imap';
	});
	const inUse = $derived(info.config.connected || info.config.can_send ? `${info.config.account || info.config.username} (IMAP and SMTP)` : gmail.config.connected ? `${gmail.config.account} (Gmail)` : '');

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

	function usePreset(p: Config['presets'][number]) {
		Object.assign(f, p.values);
		note = p.note;
		checks = null;
	}

	// The server and username the saved password belongs to; changing them needs the password again.
	const moved = $derived(info.config.has_password && (f.imap_host !== info.config.imap_host || f.smtp_host !== info.config.smtp_host || f.username !== info.config.username));

	const save = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			const { password, ...rest } = f;
			load(unwrap(await api().PUT('/integrations/mail', { body: { ...rest, password: password || null } })));
			checks = unwrap(await api().POST('/integrations/mail/test'));
			notice = 'Saved.';
		});
	};
	const test = () =>
		act(async () => {
			checks = unwrap(await api().POST('/integrations/mail/test'));
		});
	const forget = () =>
		act(async () => {
			if (!confirm('Remove this mailbox from Ledger? Modules can no longer read or send mail through it. Nothing changes in the mailbox itself.')) return;
			load(unwrap(await api().PUT('/integrations/mail', { body: { password: '', username: '', imap_host: '', smtp_host: '', account: '', from_name: '' } })));
			checks = null;
			notice = 'Mailbox removed.';
		});
	const saveGrants = () =>
		act(async () => {
			load(unwrap(await api().PUT('/integrations/mail', { body: { allow_read: allowRead, allow_send: allowSend } })));
			notice = 'Saved.';
		});
	const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id].sort() : list.filter((x) => x !== id));
</script>

<p class="muted" style="margin-top:0">
	One mailbox for Ledger's modules: reading bills and receipts, sending invoices. Connect it over IMAP and SMTP (this is
	how Proton Mail is reached, through Proton Mail Bridge) or connect a Gmail account. While an IMAP mailbox is set up,
	modules use it instead of Gmail.
	{#if inUse}Modules now use <strong>{inUse}</strong>.{:else}No mailbox is set up yet.{/if}
</p>
<div class="switch" role="tablist" aria-label="Kind of mailbox">
	<button type="button" role="tab" aria-selected={kind === 'imap'} class:on={kind === 'imap'} onclick={() => (kind = 'imap')}>
		Proton Mail Bridge or IMAP{#if info.config.connected}<span class="badge ok">set up</span>{/if}
	</button>
	<button type="button" role="tab" aria-selected={kind === 'gmail'} class:on={kind === 'gmail'} onclick={() => (kind = 'gmail')}>
		Gmail{#if gmail.config.connected}<span class="badge ok">connected</span>{/if}
	</button>
</div>

{#if kind === 'gmail'}
	<GmailSettings initial={data.gmail} onchange={(i) => (gmail = i)} />
{:else}
{#if !info.available}
	<div class="notice error">Mail settings aren't set up on this server (no <code>/var/lib/ledger/integrations</code>). Update Ledger, or run <code>deploy/install.sh</code>.</div>
{/if}
<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<p class="muted small" style="margin-top:0">
	Proton Mail Bridge must run on this server; any other mailbox with a password works too. The password stays on the server.
</p>

<form class="card" onsubmit={save}>
	<div class="head">
		<h2>Mailbox</h2>
		{#if info.config.connected}<span class="badge ok">set up</span>{/if}
		<span class="spacer"></span>
		{#each info.config.presets as p (p.id)}<button type="button" onclick={() => usePreset(p)}>Fill in for {p.label}</button>{/each}
	</div>
	{#if note}<p class="muted small">{note}</p>{/if}

	<div class="row">
		<label style="flex:2; min-width:14rem">Email address <input type="email" bind:value={f.account} placeholder="you@proton.me" autocomplete="off" /></label>
		<label style="flex:1; min-width:10rem">Name shown on mail sent <input bind:value={f.from_name} maxlength="100" autocomplete="off" /></label>
	</div>
	<div class="row">
		<label style="flex:1; min-width:14rem">Username <input bind:value={f.username} autocomplete="off" placeholder="usually the email address" /></label>
		<label style="flex:1; min-width:14rem">
			Password
			<input type="password" bind:value={f.password} autocomplete="new-password" required={moved} placeholder={info.config.has_password && !moved ? '•••••••• (saved; type to replace)' : ''} />
		</label>
	</div>
	{#if moved}<p class="muted small">The server or username changed: enter the password again.</p>{/if}

	<h3>Reading (IMAP)</h3>
	<div class="row">
		<label style="flex:2; min-width:12rem">Server <input bind:value={f.imap_host} placeholder="127.0.0.1" autocomplete="off" /></label>
		<label>Port <input type="number" min="1" max="65535" bind:value={f.imap_port} style="width:7rem" /></label>
		<label>
			Encryption
			<select bind:value={f.imap_security}>{#each info.config.securities as s (s)}<option value={s}>{SECURITY_LABELS[s] ?? s}</option>{/each}</select>
		</label>
		<label style="flex:1; min-width:9rem">Folder <input bind:value={f.folder} placeholder="INBOX" autocomplete="off" /></label>
	</div>
	{#if checks}<p class="small check" class:bad={!checks.imap.ok}>{checks.imap.ok ? '✓' : '✗'} {checks.imap.message}</p>{/if}

	<h3>Sending (SMTP)</h3>
	<div class="row">
		<label style="flex:2; min-width:12rem">Server <input bind:value={f.smtp_host} placeholder="127.0.0.1" autocomplete="off" /></label>
		<label>Port <input type="number" min="1" max="65535" bind:value={f.smtp_port} style="width:7rem" /></label>
		<label>
			Encryption
			<select bind:value={f.smtp_security}>{#each info.config.securities as s (s)}<option value={s}>{SECURITY_LABELS[s] ?? s}</option>{/each}</select>
		</label>
	</div>
	{#if checks}<p class="small check" class:bad={!checks.smtp.ok}>{checks.smtp.ok ? '✓' : '✗'} {checks.smtp.message}</p>{/if}

	<label class="inline" style="margin-top:0.75rem">
		<input type="checkbox" bind:checked={f.trust_certificate} />
		Accept the server's own certificate
	</label>
	<p class="muted small" style="margin:0.2rem 0 0">
		Needed for Proton Mail Bridge, which makes its certificate itself. Leave it off for a mail host on the internet.
	</p>
	{#if f.imap_security === 'none' || f.smtp_security === 'none'}
		<p class="notice error small">Without encryption the password crosses the network in the clear. Only use it for a server on this same machine.</p>
	{/if}

	<p style="margin-bottom:0" class="buttons">
		<button class="primary" disabled={busy || !info.available}>Save and test</button>
		{#if info.config.connected}
			<button type="button" disabled={busy} onclick={test}>Test again</button>
			<button type="button" disabled={busy} onclick={forget}>Remove mailbox</button>
		{/if}
	</p>
</form>

{#if info.config.connected || info.config.can_send}
	<section class="card">
		<h2>Modules that may use it</h2>
		{#if info.modules.length === 0}
			<p class="muted">No modules are installed.</p>
		{:else}
			<table>
				<thead>
					<tr><th>Module</th><th>Read mail</th><th>Send mail{#if !info.config.can_send}<span class="muted small" style="text-transform:none">&nbsp;(fill in sending above first)</span>{/if}</th></tr>
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
{/if}

<style>
	.switch {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		margin-bottom: 1rem;
	}
	.switch button {
		border: none;
		border-radius: 0;
		background: var(--surface);
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.switch button + button {
		border-left: 1px solid var(--border);
	}
	.switch button.on {
		background: var(--accent);
		color: var(--accent-text);
	}
	h2 {
		margin: 0;
	}
	h3 {
		margin: 1rem 0 0;
		font-size: 0.95rem;
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
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.5rem 0;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.check {
		margin: 0;
		color: var(--ok);
	}
	.check.bad {
		color: var(--danger);
	}
	select {
		width: auto;
	}
</style>
