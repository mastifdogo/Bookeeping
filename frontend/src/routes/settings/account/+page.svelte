<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { invalidate } from '$app/navigation';
	import { api, unwrap } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let current = $state('');
	let next = $state('');
	let repeat = $state('');
	let busy = $state(false);
	let error = $state<unknown>(null);
	let done = $state(false);

	// Root mode: admins only; lasts until it is turned off or they log out.
	let rootBusy = $state(false);
	let rootError = $state<unknown>(null);
	async function setRoot(on: boolean) {
		if (on && !confirm('Turn on root mode?\n\nYou can then delete bookkeeping accounts with every entry posted to them, change an account\'s type, and rename or delete users. Each root action is logged under Settings → Root log and can be reversed there.')) return;
		rootBusy = true;
		rootError = null;
		try {
			unwrap(await api().POST('/auth/root', { body: { on } }));
			await invalidate('app:user');
		} catch (err) {
			rootError = err;
		} finally {
			rootBusy = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		done = false;
		if (next !== repeat) {
			error = new Error('The new passwords do not match.');
			return;
		}
		busy = true;
		try {
			const res = await api().POST('/auth/password', { body: { current_password: current, new_password: next } });
			if (res.response.status !== 204) unwrap(res);
			current = next = repeat = '';
			done = true;
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
</script>

<div class="card">
	<p style="margin-top:0">
		Signed in as <strong>{data.user?.username}</strong>, <span class="badge">{data.user?.role}</span> in
		<strong>{data.user?.organization.name}</strong>.
		{#if data.user?.last_login_at}<span class="muted small">Last login {new Date(data.user.last_login_at).toLocaleString()}.</span>{/if}
	</p>
</div>

<form class="card" onsubmit={submit} style="max-width:480px">
	<h2 style="margin-top:0">Change password</h2>
	{#if done}<div class="notice ok">Password changed. Your other sessions were logged out.</div>{/if}
	<ErrorNotice {error} />
	<div style="display:flex; flex-direction:column; gap:0.8rem">
		<label>Current password <input type="password" bind:value={current} autocomplete="current-password" required /></label>
		<label>New password <input type="password" bind:value={next} autocomplete="new-password" required minlength="4" /></label>
		<label>Repeat new password <input type="password" bind:value={repeat} autocomplete="new-password" required minlength="4" /></label>
		<div><button class="primary" disabled={busy}>Change password</button></div>
	</div>
	<p class="muted small" style="margin-bottom:0">At least 4 characters (a 4-digit PIN works). Longer is safer: a few random words make a strong, memorable password.</p>
</form>

{#if data.user?.role === 'admin'}
	<section class="card root-card" class:on={data.user.root} style="max-width:640px">
		<h2 style="margin-top:0">Root mode</h2>
		<ErrorNotice error={rootError} />
		<label class="inline">
			<input type="checkbox" role="switch" checked={data.user.root} disabled={rootBusy} onchange={(e) => setRoot(e.currentTarget.checked)} />
			<strong>{data.user.root ? 'Root mode is on' : 'Root mode is off'}</strong>
		</label>
		<p class="small" style="margin-bottom:0">
			While it is on, the background is red and you can delete a bookkeeping account with every journal entry posted to it, change
			an account's type, and{#if data.user.server_admin} rename or delete users{:else} (as an admin of the main books) rename or delete users{/if}.
			Every root action is kept in <a href="/settings/root">Settings → Root log</a>, where it can be reversed. It ends when you
			turn it off or log out.
		</p>
	</section>
{/if}

<style>
	.root-card.on {
		border-color: var(--danger);
	}
</style>
