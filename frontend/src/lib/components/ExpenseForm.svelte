<script lang="ts">
	// A quick expense: what was paid, from which bank or card account, to
	// which expense account, and optionally the vendor. Posts the two-line
	// entry (debit the expense, credit what it was paid from).
	import { goto, invalidateAll } from '$app/navigation';
	import ErrorNotice from './ErrorNotice.svelte';
	import AccountSelect from './AccountSelect.svelte';
	import { api, kindLabel, today, unwrap, type Account, type Entity } from '#lib/api/client.ts';
	import { parseAmount } from '#lib/money.ts';

	// The active accounts, and the entities that are vendors.
	let data: { accounts: Account[]; vendors: Entity[] } = $props();

	let entryDate = $state(today());
	let amount = $state('');
	let paidFrom = $state('');
	let expense = $state('');
	let description = $state('');
	let reference = $state('');
	const NEW = '\u0000new';
	let vendor = $state<string>(''); // an entity id, '' or NEW
	let vendorName = $state('');
	let saving = $state(false);
	let another = $state(false);
	let error = $state<unknown>(null);
	let done = $state('');

	// Paid from: tagged bank and card accounts first, then other asset and liability accounts.
	let payAccounts = $derived(
		[...data.accounts.filter((a) => a.kind), ...data.accounts.filter((a) => !a.kind && (a.type === 'asset' || a.type === 'liability'))].map((a) => ({
			...a,
			name: a.kind ? `${a.name} (${kindLabel(a.kind)})` : a.name
		}))
	);
	let paid = $derived(data.accounts.find((a) => a.code === paidFrom));
	// The expense is in the currency it was paid in.
	let expenseAccounts = $derived(data.accounts.filter((a) => a.type === 'expense' && (!paid || a.currency === paid.currency)));
	$effect(() => {
		if (expense && !expenseAccounts.some((a) => a.code === expense)) expense = '';
	});
	let cents = $derived(parseAmount(amount));
	let ready = $derived(cents !== null && cents > 0 && paidFrom !== '' && expense !== '' && (vendor !== NEW || vendorName.trim() !== ''));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!ready || cents === null) return;
		saving = true;
		error = null;
		done = '';
		try {
			let entityId: number | null = vendor === '' || vendor === NEW ? null : Number(vendor);
			let name = data.vendors.find((v) => v.id === entityId)?.name ?? '';
			if (vendor === NEW) {
				const v = unwrap(await api().POST('/entities', { body: { name: vendorName, is_vendor: true } }));
				entityId = v.id;
				name = v.name;
			}
			const exp = data.accounts.find((a) => a.code === expense)!;
			const created = unwrap(
				await api().POST('/journal-entries', {
					body: {
						entry_date: entryDate,
						description: description.trim() || (name ? `${exp.name} - ${name}` : exp.name),
						reference,
						entity_id: entityId,
						lines: [
							{ account_code: expense, debit_cents: cents, credit_cents: 0, memo: '' },
							{ account_code: paidFrom, debit_cents: 0, credit_cents: cents, memo: '' }
						]
					}
				})
			);
			if (!another) return await goto(`/journal/${created.id}`);
			done = `Posted entry #${created.id}: ${amount} to ${exp.name}${name ? ` (${name})` : ''}.`;
			amount = description = reference = '';
			if (vendor === NEW) {
				// The new vendor is in the list after a reload of the page's data.
				await invalidateAll();
				vendor = String(entityId);
				vendorName = '';
			}
		} catch (err) {
			error = err;
		} finally {
			saving = false;
		}
	}
</script>

{#if done}<div class="notice ok">{done}</div>{/if}

<form class="card" onsubmit={submit}>
	<ErrorNotice {error} />
	<div class="row">
		<label>Date <input type="date" bind:value={entryDate} required /></label>
		<label>
			Amount
			<input class="amount" inputmode="decimal" bind:value={amount} required placeholder="0.00" size="12" aria-invalid={cents === null ? 'true' : undefined} />
		</label>
		<label style="flex:1; min-width:14rem">
			Paid from
			<AccountSelect bind:value={paidFrom} accounts={payAccounts} label="Paid from" required placeholder="Bank or card…" />
		</label>
	</div>
	<div class="row">
		<label style="flex:1; min-width:14rem">
			Expense account
			<AccountSelect bind:value={expense} accounts={expenseAccounts} label="Expense account" required defaults={{ type: 'expense', currency: paid?.currency }} />
		</label>
		<label style="flex:1; min-width:12rem">
			Vendor (optional)
			<select bind:value={vendor}>
				<option value="">— none —</option>
				{#each data.vendors as v (v.id)}<option value={String(v.id)}>{v.name}</option>{/each}
				<option value={NEW}>+ New vendor…</option>
			</select>
		</label>
		{#if vendor === NEW}
			<label style="flex:1; min-width:12rem">New vendor's name <input bind:value={vendorName} required maxlength="200" /></label>
		{/if}
	</div>
	<div class="row">
		<label style="flex:2; min-width:14rem">Description (optional) <input bind:value={description} maxlength="500" placeholder="What was it for?" /></label>
		<label style="flex:1">Reference <input bind:value={reference} maxlength="100" placeholder="Receipt / invoice #" /></label>
	</div>
	<p style="margin-bottom:0">
		<button class="primary" disabled={saving || !ready}>{saving ? 'Posting…' : 'Post expense'}</button>
		<label class="inline small" style="margin-left:0.75rem"><input type="checkbox" bind:checked={another} /> Enter another after this</label>
	</p>
	<p class="muted small" style="margin-bottom:0">
		Posts one entry: the expense account is debited, the account it was paid from is credited. Accounts tagged chequing, savings or
		credit card are listed first. For split or unusual entries switch to Journal entry above.
	</p>
</form>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
		margin-bottom: 0.7rem;
	}
	select {
		width: 100%;
	}
</style>
