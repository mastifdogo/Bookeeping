<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type Role, type User } from '#lib/api/client.ts';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const ROLES: { value: Role; label: string; help: string }[] = [
		{ value: 'admin', label: 'Admin', help: 'Everything, including users, modules, backups, updates, AI and Gmail.' },
		{ value: 'bookkeeper', label: 'Bookkeeper', help: 'Works in the books: entries, accounts, reconciliation, imports and modules.' },
		{ value: 'viewer', label: 'Viewer', help: 'Reads the books and reports; changes nothing.' }
	];

	let users = $state<User[]>([]);
	$effect.pre(() => {
		users = data.users;
	});
	let me = $derived(page.data.user?.username);
	let error: unknown = $state(null);
	let notice = $state('');
	let busy = $state(false);

	let name = $state('');
	let password = $state('');
	let role = $state<Role>('bookkeeper');

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

	const reload = async () => {
		users = unwrap(await api().GET('/users')).data;
	};

	const add = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			const u = unwrap(await api().POST('/users', { body: { username: name, password, role } }));
			notice = `Added ${u.username} (${u.role}). They can log in now.`;
			name = password = '';
			await reload();
		});
	};

	const update = (u: User, body: { role?: Role; is_active?: boolean; password?: string }, msg: string) =>
		act(async () => {
			unwrap(await api().PATCH('/users/{username}', { params: { path: { username: u.username } }, body }));
			notice = msg;
			await reload();
		});

	function resetPassword(u: User) {
		const pw = prompt(`New password for ${u.username} (at least 4 characters). Their sessions will end.`);
		if (pw) update(u, { password: pw }, `Password reset for ${u.username}.`);
	}

	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
</script>

<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<div class="table-wrap">
	<table>
		<thead><tr><th>User</th><th>Role</th><th>Last login</th><th>Status</th><th></th></tr></thead>
		<tbody>
			{#each users as u (u.username)}
				<tr class:inactive={!u.is_active}>
					<td><strong>{u.username}</strong>{#if u.username === me}<span class="muted small">&nbsp;(you)</span>{/if}</td>
					<td>
						<select
							value={u.role}
							disabled={busy}
							aria-label="Role of {u.username}"
							onchange={(e) => update(u, { role: e.currentTarget.value as Role }, `${u.username} is now ${e.currentTarget.value}.`)}
						>
							{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
						</select>
					</td>
					<td class="small">{fmt(u.last_login_at)}</td>
					<td>{#if u.is_active}<span class="badge ok">active</span>{:else}<span class="badge warn">disabled</span>{/if}</td>
					<td class="num actions">
						<button disabled={busy} onclick={() => resetPassword(u)}>Reset password</button>
						{#if u.username !== me}
							<button disabled={busy} onclick={() => update(u, { is_active: !u.is_active }, `${u.username} ${u.is_active ? 'disabled; their sessions ended' : 'enabled'}.`)}>
								{u.is_active ? 'Disable' : 'Enable'}
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<form class="card" style="max-width:640px; margin-top:1rem" onsubmit={add}>
	<h2 style="margin-top:0">Add a user</h2>
	<div class="row">
		<label>Username <input bind:value={name} required maxlength="64" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" /></label>
		<label>Password <input type="password" bind:value={password} required minlength="4" autocomplete="new-password" /></label>
		<label>
			Role
			<select bind:value={role}>{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}</select>
		</label>
		<button class="primary" disabled={busy}>Add</button>
	</div>
	<p class="muted small" style="margin-bottom:0">{ROLES.find((r) => r.value === role)?.help}</p>
</form>

<div class="card small" style="max-width:640px">
	{#each ROLES as r (r.value)}<p style="margin:0.3rem 0"><strong>{r.label}</strong>: {r.help}</p>{/each}
	<p class="muted" style="margin-bottom:0">
		Each user has their own password, sidebar and sessions; entries record who posted them. Ledger always keeps at least
		one active admin.
	</p>
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
	}
	select {
		width: auto;
	}
	.actions {
		white-space: nowrap;
	}
	.actions button {
		margin-left: 0.3rem;
	}
	tr.inactive td {
		color: var(--muted);
	}
</style>
