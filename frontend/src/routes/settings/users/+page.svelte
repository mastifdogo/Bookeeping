<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type Currency, type MainRole, type Organization, type Role, type UserListItem } from '#lib/api/client.ts';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const ROLES: { value: Role; label: string; help: string }[] = [
		{ value: 'admin', label: 'Admin', help: 'Everything in these books. Admins of the main books also run the server: users, organizations, modules, backups, updates, AI and Gmail.' },
		{ value: 'bookkeeper', label: 'Bookkeeper', help: 'Works in the books: entries, accounts, reconciliation, imports and modules.' },
		{ value: 'viewer', label: 'Viewer', help: 'Reads the books and reports; changes nothing.' }
	];
	const MAIN_ROLES: { value: MainRole; label: string }[] = [...ROLES, { value: 'none', label: 'No access' }];

	type Mode = 'main' | 'existing' | 'new';
	const MODES: { value: Mode; label: string; help: string }[] = [
		{ value: 'main', label: 'Main books', help: 'They work in the main books.' },
		{ value: 'existing', label: 'Existing organization', help: "They get access to an organization's existing accounts and entries, and nothing else." },
		{ value: 'new', label: 'New organization', help: 'Fresh books of their own (a business or personal), separate from everyone else\'s.' }
	];

	let users = $state<UserListItem[]>([]);
	let orgs = $state<Organization[]>([]);
	$effect.pre(() => {
		users = data.users;
		orgs = data.orgs;
	});
	let me = $derived(page.data.user?.username);
	// Admins of the main books manage everyone and every organization; an
	// organization's admin manages that organization's users only.
	let serverAdmin = $derived(page.data.user?.server_admin === true);
	let myOrg = $derived(page.data.user?.organization);
	let existing = $state('');
	let existingRole = $state<Role>('viewer');
	let others = $derived(orgs.filter((o) => o.id !== 1));
	let error: unknown = $state(null);
	let notice = $state('');
	let busy = $state(false);

	// Add a user
	let name = $state('');
	let password = $state('');
	let role = $state<Role>('bookkeeper');
	let mode = $state<Mode>('main');
	let orgId = $state<number | null>(null);
	let orgName = $state('');
	let orgKind = $state<'business' | 'personal'>('personal');
	let starter = $state(true);
	let currency = $state<Currency>('CAD');

	// Add an organization
	let newOrgName = $state('');
	let newOrgKind = $state<'business' | 'personal'>('business');
	let newOrgStarter = $state(true);

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

	// Reloads this page's lists and the sidebar's list of books.
	const reload = () => invalidateAll();

	const pendingNote = (o: { status: string; name: string }) =>
		o.status === 'pending' ? ` ${o.name}'s books are being created; they'll be ready in a moment.` : o.status === 'error' ? ` ${o.name}'s books could not be created.` : '';

	const add = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			const organization =
				!serverAdmin || mode === 'main'
					? undefined
					: mode === 'existing'
						? { mode, organization_id: orgId ?? 0 }
						: { mode, name: orgName, kind: orgKind, chart: starter ? currency : null };
			const u = unwrap(await api().POST('/users', { body: { username: name, password, role, organization } }));
			const where = !serverAdmin ? (myOrg?.name ?? 'this organization') : mode === 'main' ? 'the main books' : (u.organizations[0]?.name ?? 'their organization');
			notice = `Added ${u.username} (${role} in ${where}). They can log in now.${u.organizations[0] ? pendingNote(u.organizations[0]) : ''}`;
			name = password = orgName = '';
			await reload();
		});
	};

	const update = (u: UserListItem, body: { role?: MainRole; is_active?: boolean; password?: string }, msg: string) =>
		act(async () => {
			unwrap(await api().PATCH('/users/{username}', { params: { path: { username: u.username } }, body }));
			notice = msg;
			await reload();
		});

	const setMember = (u: UserListItem, id: number, r: Role) =>
		act(async () => {
			unwrap(await api().PUT('/users/{username}/organizations/{orgId}', { params: { path: { username: u.username, orgId: id } }, body: { role: r } }));
			notice = `${u.username} is ${r} in ${orgs.find((o) => o.id === id)?.name ?? myOrg?.name}.`;
			await reload();
		});

	const removeMember = (u: UserListItem, id: number) =>
		act(async () => {
			const n = orgs.find((o) => o.id === id)?.name ?? myOrg?.name;
			if (!confirm(`Take ${u.username}'s access to ${n} away?`)) return;
			unwrap(await api().DELETE('/users/{username}/organizations/{orgId}', { params: { path: { username: u.username, orgId: id } } }));
			notice = `${u.username} no longer has access to ${n}.`;
			await reload();
		});

	function joinOrg(u: UserListItem, e: Event & { currentTarget: HTMLSelectElement }) {
		const id = Number(e.currentTarget.value);
		e.currentTarget.value = '';
		if (id) setMember(u, id, 'viewer');
	}

	const addOrg = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			const o = unwrap(await api().POST('/organizations', { body: { name: newOrgName, kind: newOrgKind, chart: newOrgStarter ? currency : null } }));
			notice = `Created ${o.name}; you're its admin. Switch to it from the sidebar.${pendingNote(o)}`;
			newOrgName = '';
			await reload();
		});
	};

	function renameOrg(o: Organization) {
		const n = prompt(`New name for ${o.name}`, o.name);
		if (n && n.trim() !== o.name)
			act(async () => {
				unwrap(await api().PATCH('/organizations/{orgId}', { params: { path: { orgId: o.id } }, body: { name: n } }));
				notice = `Renamed to ${n.trim()}.`;
				await reload();
			});
	}

	const addExisting = (e: SubmitEvent) => {
		e.preventDefault();
		return act(async () => {
			if (!myOrg) return;
			unwrap(await api().PUT('/users/{username}/organizations/{orgId}', { params: { path: { username: existing.trim(), orgId: myOrg.id } }, body: { role: existingRole } }));
			notice = `${existing.trim()} is ${existingRole} in ${myOrg.name}.`;
			existing = '';
			await reload();
		});
	};

	function resetPassword(u: UserListItem) {
		const pw = prompt(`New password for ${u.username} (at least 4 characters). Their sessions will end.`);
		if (pw) update(u, { password: pw }, `Password reset for ${u.username}.`);
	}

	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
	const memberCount = (id: number) => users.filter((u) => u.organizations.some((m) => m.id === id)).length;
</script>

<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

{#if serverAdmin}
<div class="table-wrap">
	<table>
		<thead><tr><th>User</th><th>Main books</th><th>Other books</th><th>Last login</th><th>Status</th><th></th></tr></thead>
		<tbody>
			{#each users as u (u.username)}
				<tr class:inactive={!u.is_active}>
					<td><strong>{u.username}</strong>{#if u.username === me}<span class="muted small">&nbsp;(you)</span>{/if}</td>
					<td>
						<select
							value={u.role}
							disabled={busy}
							aria-label="Role of {u.username} in the main books"
							onchange={(e) => update(u, { role: e.currentTarget.value as MainRole }, `${u.username} is now ${e.currentTarget.value === 'none' ? 'without access to' : e.currentTarget.value + ' in'} the main books.`)}
						>
							{#each MAIN_ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
						</select>
					</td>
					<td>
						<div class="chips">
							{#each u.organizations as m (m.id)}
								<span class="chip" class:pending={m.status !== 'ready'} title={m.status === 'ready' ? '' : m.status}>
									{m.name}
									<select
										value={m.role}
										disabled={busy}
										aria-label="Role of {u.username} in {m.name}"
										onchange={(e) => setMember(u, m.id, e.currentTarget.value as Role)}
									>
										{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
									</select>
									<button class="link" disabled={busy} title="Remove from {m.name}" onclick={() => removeMember(u, m.id)}>×</button>
								</span>
							{/each}
							{#if others.some((o) => !u.organizations.some((m) => m.id === o.id))}
								<select class="join" disabled={busy} aria-label="Give {u.username} access to an organization" onchange={(e) => joinOrg(u, e)}>
									<option value="">+ Add to…</option>
									{#each others.filter((o) => !u.organizations.some((m) => m.id === o.id)) as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
								</select>
							{/if}
						</div>
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

<form class="card" style="max-width:720px; margin-top:1rem" onsubmit={add}>
	<h2 style="margin-top:0">Add a user</h2>
	<div class="row">
		<label>Username <input bind:value={name} required maxlength="64" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" /></label>
		<label>Password <input type="password" bind:value={password} required minlength="4" autocomplete="new-password" /></label>
		<label>
			Role
			<select bind:value={role}>{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}</select>
		</label>
	</div>

	<fieldset class="modes">
		<legend>Books</legend>
		<div class="segmented" role="radiogroup" aria-label="Books">
			{#each MODES as m (m.value)}
				<label class:on={mode === m.value}>
					<input type="radio" name="mode" value={m.value} bind:group={mode} disabled={m.value === 'existing' && others.length === 0} />
					{m.label}
				</label>
			{/each}
		</div>
		<p class="muted small">{MODES.find((m) => m.value === mode)?.help}</p>
		{#if mode === 'existing'}
			<label>
				Organization
				<select bind:value={orgId} required>
					<option value={null} disabled>Choose…</option>
					{#each others as o (o.id)}<option value={o.id}>{o.name} ({o.kind})</option>{/each}
				</select>
			</label>
		{:else if mode === 'new'}
			<div class="row">
				<label>Name <input bind:value={orgName} required maxlength="100" placeholder={orgKind === 'personal' ? (name ? `${name}'s books` : 'Personal books') : 'Company name'} /></label>
				<label>
					Kind
					<select bind:value={orgKind}><option value="personal">Personal</option><option value="business">Business</option></select>
				</label>
			</div>
			<label class="check">
				<input type="checkbox" bind:checked={starter} />
				Start with a basic {orgKind} chart of accounts in
				<select bind:value={currency} disabled={!starter} aria-label="Currency"><option>CAD</option><option>USD</option></select>
			</label>
		{/if}
	</fieldset>
	<p class="muted small">{ROLES.find((r) => r.value === role)?.help}</p>
	<button class="primary" disabled={busy}>Add user</button>
</form>

<div class="card" style="max-width:720px">
	<h2 style="margin-top:0">Organizations</h2>
	<p class="muted small">
		Each organization has books of its own (accounts, entries, files and module data), kept in a separate database. Users
		switch between the books they belong to in the sidebar.
	</p>
	<ul class="orgs">
		{#each orgs as o (o.id)}
			<li>
				<strong>{o.name}</strong>
				<span class="muted small">{o.id === 1 ? 'main books' : o.kind} · {o.id === 1 ? users.filter((u) => u.role !== 'none').length : memberCount(o.id)} users</span>
				{#if o.status === 'pending'}<span class="badge warn">being created</span>{:else if o.status === 'error'}<span class="badge warn" title={o.message}>failed</span>{/if}
				<button class="link small" disabled={busy} onclick={() => renameOrg(o)}>Rename</button>
			</li>
		{/each}
	</ul>
	<form class="row" onsubmit={addOrg}>
		<label>New organization <input bind:value={newOrgName} required maxlength="100" placeholder="Name" /></label>
		<label>
			Kind
			<select bind:value={newOrgKind}><option value="business">Business</option><option value="personal">Personal</option></select>
		</label>
		<label class="check"><input type="checkbox" bind:checked={newOrgStarter} /> Starter accounts ({currency})</label>
		<button disabled={busy}>Create</button>
	</form>
</div>

{:else}
	<p class="muted">
		Users of <strong>{myOrg?.name}</strong>. You manage who works in these books and their role here. Other organizations and
		the main books are managed by admins of the main books.
	</p>
	<div class="table-wrap">
		<table>
			<thead><tr><th>User</th><th>Role in {myOrg?.name}</th><th>Last login</th><th>Status</th><th></th></tr></thead>
			<tbody>
				{#each users as u (u.username)}
					{@const m = u.organizations[0]}
					<tr class:inactive={!u.is_active}>
						<td><strong>{u.username}</strong>{#if u.username === me}<span class="muted small">&nbsp;(you)</span>{/if}</td>
						<td>
							{#if m}
								<select value={m.role} disabled={busy || u.username === me} aria-label="Role of {u.username}" onchange={(e) => setMember(u, m.id, e.currentTarget.value as Role)}>
									{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
								</select>
							{/if}
						</td>
						<td class="small">{fmt(u.last_login_at)}</td>
						<td>{#if u.is_active}<span class="badge ok">active</span>{:else}<span class="badge warn">disabled</span>{/if}</td>
						<td class="num actions">
							{#if u.manageable}
								<button disabled={busy} onclick={() => resetPassword(u)}>Reset password</button>
								{#if u.username !== me}
									<button disabled={busy} onclick={() => update(u, { is_active: !u.is_active }, `${u.username} ${u.is_active ? 'disabled; their sessions ended' : 'enabled'}.`)}>
										{u.is_active ? 'Disable' : 'Enable'}
									</button>
								{/if}
							{:else}
								<span class="muted small" title="They also have access to other books, so an admin of the main books resets their password or disables them.">also in other books</span>
							{/if}
							{#if u.username !== me && m}<button disabled={busy} onclick={() => removeMember(u, m.id)}>Remove</button>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<form class="card" style="max-width:720px; margin-top:1rem" onsubmit={add}>
		<h2 style="margin-top:0">Add a user to {myOrg?.name}</h2>
		<div class="row">
			<label>Username <input bind:value={name} required maxlength="64" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" /></label>
			<label>Password <input type="password" bind:value={password} required minlength="4" autocomplete="new-password" /></label>
			<label>
				Role
				<select bind:value={role}>{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}</select>
			</label>
			<button class="primary" disabled={busy}>Add user</button>
		</div>
		<p class="muted small">A new account with access to these books only.</p>
	</form>
	<form class="card" style="max-width:720px" onsubmit={addExisting}>
		<h2 style="margin-top:0">Add someone who already has an account</h2>
		<div class="row">
			<label>Their username <input bind:value={existing} required maxlength="64" autocomplete="off" /></label>
			<label>
				Role
				<select bind:value={existingRole}>{#each ROLES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}</select>
			</label>
			<button disabled={busy}>Give access</button>
		</div>
	</form>
{/if}

<div class="card small" style="max-width:720px">
	{#each ROLES as r (r.value)}<p style="margin:0.3rem 0"><strong>{r.label}</strong>: {r.help}</p>{/each}
	<p class="muted" style="margin-bottom:0">
		Each user has their own password, sidebar and sessions; entries record who posted them. Ledger always keeps at least
		one active admin of the main books.
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
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.1rem 0.25rem 0.1rem 0.6rem;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.chip.pending {
		opacity: 0.65;
	}
	.chip select,
	select.join {
		font-size: 0.8rem;
		padding: 0.1rem 0.3rem;
	}
	.chip button {
		font-size: 1rem;
		line-height: 1;
		padding: 0 0.3rem;
	}
	.modes {
		border: none;
		padding: 0;
		margin: 1rem 0 0;
	}
	.modes legend {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.segmented {
		display: inline-flex;
		flex-wrap: wrap;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.segmented label {
		display: flex;
		align-items: center;
		padding: 0.4rem 0.8rem;
		cursor: pointer;
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
	.segmented label:has(input:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.segmented label:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.check {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	.check input,
	.check select {
		width: auto;
		margin: 0;
	}
	.orgs {
		list-style: none;
		padding: 0;
		margin: 0 0 1rem;
	}
	.orgs li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: baseline;
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--border);
	}
</style>
