<script lang="ts">
	// Shown instead of everything else while the user must choose a new
	// password: the first login on a new server, whose password starts as 1234.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import { _safeNext } from '../+layout';

	let password = $state('');
	let again = $state('');
	let busy = $state(false);
	let error = $state<unknown>(null);
	let mismatch = $derived(again !== '' && password !== again);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (password !== again) return;
		busy = true;
		error = null;
		try {
			const res = await api().POST('/auth/password', { body: { current_password: '', new_password: password } });
			if (res.response.status !== 204) unwrap(res);
			password = again = '';
			await goto(_safeNext(page.url.searchParams.get('next')), { replace: true, invalidateAll: true });
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function logout() {
		await api().POST('/auth/logout');
		await goto('/login', { replace: true, invalidateAll: true });
	}
</script>

<svelte:head><title>Choose a password · Ledger</title></svelte:head>

<form class="card box" onsubmit={submit}>
	<h1>Choose your password</h1>
	<p class="muted">
		You logged in as <strong>{page.data.user?.username}</strong> with the starting password. Choose your own now: a password, or a
		4-digit passcode. It replaces the starting one.
	</p>
	<ErrorNotice {error} />
	<label>
		New password or passcode
		<input type="password" bind:value={password} autocomplete="new-password" required minlength="4" maxlength="72" />
	</label>
	<label>
		Again
		<input type="password" bind:value={again} autocomplete="new-password" required minlength="4" aria-invalid={mismatch ? 'true' : undefined} />
	</label>
	{#if mismatch}<p class="neg small">The two don't match.</p>{/if}
	<button class="primary" disabled={busy || password.length < 4 || password !== again}>{busy ? 'Saving…' : 'Save and continue'}</button>
	<p class="muted small">At least 4 characters. <button type="button" class="link" onclick={logout}>Log out</button></p>
</form>

<style>
	.box {
		max-width: 400px;
		margin: 12vh auto 0;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 1.5rem;
	}
	.box h1,
	.box p {
		margin: 0;
	}
	.neg {
		color: var(--danger);
	}
	button.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
	}
</style>
