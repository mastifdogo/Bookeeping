<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { invalidateAll } from '$app/navigation';
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
		problems = [];
		checked = '';
		try {
			let res = await api().POST('/auth/root', { body: { on } });
			// Root mode is only left with the books intact; otherwise this root session can be reversed.
			if (!on && res.error?.error.code === 'root_not_intact') {
				problems = (res.error.error.details ?? []).map((d) => d.message);
				const list = problems.slice(0, 12).join('\n• ');
				if (
					!confirm(
						`The books are not intact, so root mode can't be left as it is:\n\n• ${list}${problems.length > 12 ? `\n… and ${problems.length - 12} more` : ''}\n\nOK: reverse everything done in this root session and leave root mode.\nCancel: stay in root mode and fix it.`
					)
				)
					return;
				res = await api().POST('/auth/root', { body: { on: false, reverse: true } });
			}
			unwrap(res);
			problems = [];
			await invalidateAll();
		} catch (err) {
			rootError = err;
		} finally {
			rootBusy = false;
		}
	}
	// What keeps root mode from being left, as last checked.
	let problems = $state<string[]>([]);
	let checked = $state('');
	async function checkBooks() {
		rootBusy = true;
		rootError = null;
		try {
			const r = unwrap(await api().GET('/root/check'));
			problems = r.problems;
			checked = r.intact ? 'The books are intact: root mode can be left.' : '';
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
			<input
				type="checkbox"
				role="switch"
				checked={data.user.root}
				disabled={rootBusy}
				onchange={(e) => {
					const want = e.currentTarget.checked;
					e.currentTarget.checked = data.user?.root === true; // it follows what the server says
					setRoot(want);
				}}
			/>
			<strong>{data.user.root ? 'Root mode is on' : 'Root mode is off'}</strong>
		</label>
		{#if data.user.root}<button disabled={rootBusy} onclick={checkBooks} style="margin-left:0.75rem">Check the books</button>{/if}
		{#if checked}<p class="small" style="color:var(--ok)">{checked}</p>{/if}
		{#if problems.length > 0}
			<div class="notice error small">
				<strong>Not intact.</strong> Fix these, or turn root mode off and reverse this root session:
				<ul style="margin:0.3rem 0 0; padding-left:1.2rem">
					{#each problems.slice(0, 50) as p (p)}<li>{p}</li>{/each}
				</ul>
			</div>
		{/if}
		<p class="small" style="margin-bottom:0">
			While it is on, the background is red and you can delete anything in the books: an account with every entry posted to it, a
			journal entry, or a single line of one. You can move a line to any account or change its amount, so an entry may be left
			unbalanced or with one line while you work. You can also change an account's type, and{#if data.user.server_admin}
				rename or delete users{:else} (as an admin of the main books) rename or delete users{/if}. Modules let you do the same to their
			records.
		</p>
		<p class="small" style="margin-bottom:0">
			<strong>Leaving root mode needs the books intact:</strong> every entry with at least two lines, debits equal to credits. If
			they aren't, you either fix them or everything done in this root session is reversed; logging out, or a login that times out,
			reverses it too. Every root action is kept in <a href="/settings/root">Settings → Root log</a>, where it can be reversed one
			by one.
		</p>
	</section>
{/if}

<style>
	.root-card.on {
		border-color: var(--danger);
	}
</style>
