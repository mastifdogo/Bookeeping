<script lang="ts">
	// Customers and vendors: one list shared by Ledger and its modules. An
	// entity can be a customer, a vendor, or both.
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type Entity } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let canEdit = $derived(page.data.user != null && page.data.user.role !== 'viewer');

	type Show = 'all' | 'customer' | 'vendor';
	let show = $state<Show>('all');
	let q = $state('');
	let rows = $derived(
		data.entities.filter(
			(e) => (show === 'all' || (show === 'customer' ? e.is_customer : e.is_vendor)) && (!q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()))
		)
	);

	type Form = { name: string; is_customer: boolean; is_vendor: boolean; email: string; phone: string; address: string; notes: string };
	const blank = (): Form => ({ name: '', is_customer: false, is_vendor: true, email: '', phone: '', address: '', notes: '' });
	let form = $state<Form>(blank());
	let editing = $state<number | 'new' | null>(null);
	let busy = $state(false);
	let error = $state<unknown>(null);
	let notice = $state('');

	function start(e: Entity | null) {
		error = null;
		notice = '';
		editing = e ? e.id : 'new';
		form = e ? { name: e.name, is_customer: e.is_customer, is_vendor: e.is_vendor, email: e.email, phone: e.phone, address: e.address, notes: e.notes } : blank();
	}

	async function act(fn: () => Promise<string>) {
		busy = true;
		error = null;
		try {
			notice = await fn();
			editing = null;
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	const save = (ev: SubmitEvent) => {
		ev.preventDefault();
		return act(async () => {
			if (editing === 'new') {
				const e = unwrap(await api().POST('/entities', { body: form }));
				return `Added ${e.name}.`;
			}
			const e = unwrap(await api().PATCH('/entities/{entityId}', { params: { path: { entityId: editing as number } }, body: form }));
			return `Saved ${e.name}.`;
		});
	};
	const setActive = (e: Entity, active: boolean) =>
		act(async () => {
			unwrap(await api().PATCH('/entities/{entityId}', { params: { path: { entityId: e.id } }, body: { is_active: active } }));
			return active ? `${e.name} is active again.` : `${e.name} is inactive: it stays on past entries but isn't offered for new ones.`;
		});

	const roles = (e: Entity) => (e.is_customer && e.is_vendor ? 'Customer and vendor' : e.is_customer ? 'Customer' : 'Vendor');
	function toggleInactive(ev: Event) {
		goto((ev.currentTarget as HTMLInputElement).checked ? '?inactive=1' : '?', { reset: false });
	}
</script>

<div class="toolbar">
	<h1 style="margin:0">Entities <span class="muted" style="font-weight:400; font-size:1rem">customers &amp; vendors</span></h1>
	<span class="spacer"></span>
	<label class="inline"><input type="checkbox" checked={data.includeInactive} onchange={toggleInactive} /> Show inactive</label>
	{#if canEdit}<button class="primary" onclick={() => (editing === 'new' ? (editing = null) : start(null))}>{editing === 'new' ? 'Close' : '+ New'}</button>{/if}
</div>
<p class="muted small">
	One list for Ledger and its modules: the vendor on an expense, the customer on an invoice. An entity can be a customer, a vendor, or both.
</p>

{#if notice}<div class="notice ok">{notice}</div>{/if}

{#if editing !== null}
	<form class="card" onsubmit={save}>
		<ErrorNotice {error} />
		<div class="row">
			<label style="flex:2">Name <input bind:value={form.name} required maxlength="200" /></label>
			<fieldset class="roles">
				<legend>Is a</legend>
				<label class="inline"><input type="checkbox" bind:checked={form.is_customer} /> Customer</label>
				<label class="inline"><input type="checkbox" bind:checked={form.is_vendor} /> Vendor</label>
			</fieldset>
		</div>
		<div class="row">
			<label style="flex:1">Email <input type="email" bind:value={form.email} maxlength="200" /></label>
			<label style="flex:1">Phone <input bind:value={form.phone} maxlength="100" /></label>
		</div>
		<div class="row">
			<label style="flex:1">Address <input bind:value={form.address} maxlength="1000" /></label>
			<label style="flex:1">Notes <input bind:value={form.notes} maxlength="2000" /></label>
		</div>
		<p style="margin-bottom:0">
			<button class="primary" disabled={busy || (!form.is_customer && !form.is_vendor)}>{editing === 'new' ? 'Add' : 'Save'}</button>
			<button type="button" onclick={() => (editing = null)}>Cancel</button>
			{#if !form.is_customer && !form.is_vendor}<span class="muted small">Choose customer, vendor or both.</span>{/if}
		</p>
	</form>
{:else}
	<ErrorNotice {error} />
{/if}

<div class="toolbar">
	<div class="segmented" role="radiogroup" aria-label="Show">
		{#each [['all', 'All'], ['customer', 'Customers'], ['vendor', 'Vendors']] as [v, label] (v)}
			<label class:on={show === v}><input type="radio" name="show" value={v} bind:group={show} /> {label}</label>
		{/each}
	</div>
	<input type="search" bind:value={q} placeholder="Find by name" aria-label="Find by name" style="max-width:16rem" />
</div>

<div class="table-wrap">
	{#if rows.length === 0}
		<div class="empty">{data.entities.length === 0 ? 'No customers or vendors yet.' : 'None match.'}</div>
	{:else}
		<table>
			<thead><tr><th>Name</th><th>Is a</th><th>Email</th><th>Phone</th><th></th></tr></thead>
			<tbody>
				{#each rows as e (e.id)}
					<tr class:inactive={!e.is_active}>
						<td>
							<strong>{e.name}</strong>{#if !e.is_active} <span class="badge warn">inactive</span>{/if}
							{#if e.address || e.notes}<div class="muted small">{[e.address, e.notes].filter(Boolean).join(' · ')}</div>{/if}
						</td>
						<td>{roles(e)}</td>
						<td>{e.email}</td>
						<td>{e.phone}</td>
						<td class="num actions">
							<a class="button" href="/journal?entity_id={e.id}">Entries</a>
							{#if canEdit}
								<button disabled={busy} onclick={() => start(e)}>Edit</button>
								<button disabled={busy} onclick={() => setActive(e, !e.is_active)}>{e.is_active ? 'Deactivate' : 'Reactivate'}</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
		margin-bottom: 0.6rem;
	}
	.roles {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.roles legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0;
	}
	.actions {
		white-space: nowrap;
	}
	tr.inactive td {
		color: var(--muted);
	}
	.segmented {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.segmented label {
		display: flex;
		flex-direction: row;
		align-items: center;
		padding: 0.35rem 0.8rem;
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
</style>
