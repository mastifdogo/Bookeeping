<script lang="ts">
	// Pay bill (a vendor) and Receive payment (a customer): who, the bank or
	// credit card account, the date and the amount. It posts one entry
	// between that account and the vendor's or customer's own account (a
	// sub-account of accounts payable or receivable, made the first time), so
	// what is still owed is that account's balance.
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import ErrorNotice from './ErrorNotice.svelte';
	import AccountSelect from './AccountSelect.svelte';
	import { api, kindLabel, today, unwrap, type Account, type Entity } from '#lib/api/client.ts';
	import { formatCents, parseAmount } from '#lib/money.ts';

	// role "vendor": Pay bill; "customer": Receive payment. `entities`: the active vendors or customers.
	let data: { role: 'vendor' | 'customer'; accounts: Account[]; entities: Entity[]; preset?: number | null } = $props();
	let paying = $derived(data.role === 'vendor');

	let who = $state<number | ''>(untrack(() => (data.preset && data.entities.some((x) => x.id === data.preset) ? data.preset : '')));
	let account = $state('');
	let entryDate = $state(today());
	let amount = $state('');
	let reference = $state('');
	let another = $state(false);
	let saving = $state(false);
	let error = $state<unknown>(null);
	let done = $state('');

	const isBank = (a: Account) => a.kind === 'chequing' || a.kind === 'savings' || a.kind === 'credit_card';
	// Bank and card accounts first, then the other asset and liability accounts (not customers' or vendors' own, nor receivables or payables).
	let bankAccounts = $derived(
		[...data.accounts.filter(isBank), ...data.accounts.filter((a) => !isBank(a) && !a.entity && !a.kind && (a.type === 'asset' || a.type === 'liability'))].map((a) => ({
			...a,
			name: a.kind ? `${a.name} (${kindLabel(a.kind)})` : a.name
		}))
	);
	let entity = $derived(data.entities.find((x) => x.id === who));
	let bank = $derived(data.accounts.find((a) => a.code === account));
	// What is owed in their own accounts (in the bank account's currency once one is chosen).
	let owed = $derived((entity?.accounts ?? []).filter((a) => a.role === data.role && a.owed_cents !== 0 && (!bank || a.currency === bank.currency)));
	let cents = $derived(parseAmount(amount));
	let ready = $derived(who !== '' && account !== '' && cents !== null && cents > 0);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!ready || cents === null || who === '') return;
		saving = true;
		error = null;
		done = '';
		try {
			const created = unwrap(
				await api().POST('/entities/{entityId}/payments', {
					params: { path: { entityId: who } },
					body: { role: data.role, account_code: account, entry_date: entryDate, amount_cents: cents, reference }
				})
			);
			if (!another) return await goto(`/journal/${created.id}`);
			const own = created.lines.find((l) => l.account_code !== account);
			done = `Posted entry #${created.id}: ${amount} ${paying ? 'paid to' : 'received from'} ${entity?.name ?? ''}${own ? `, in ${own.account_code} ${own.account_name}` : ''}.`;
			amount = reference = '';
			await invalidateAll(); // what is owed has changed
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
	{#if data.entities.length === 0}
		<div class="notice">There are no {paying ? 'vendors' : 'customers'} yet. <a href="/entities">Add one under Entities</a>.</div>
	{/if}
	<div class="row">
		<label style="flex:1; min-width:12rem">
			{paying ? 'Vendor' : 'Customer'}
			<select bind:value={who} required>
				<option value="" disabled>Choose a {paying ? 'vendor' : 'customer'}…</option>
				{#each data.entities as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
			</select>
		</label>
		<label style="flex:1; min-width:14rem">
			{paying ? 'Paid from' : 'Deposited to'}
			<AccountSelect bind:value={account} accounts={bankAccounts} label={paying ? 'Bank or credit card account' : 'Bank account'} required placeholder={paying ? 'Bank or card…' : 'Bank account…'} defaults={{ type: 'asset' }} />
		</label>
	</div>
	<div class="row">
		<label>Date <input type="date" bind:value={entryDate} required /></label>
		<label>
			Amount
			<input class="amount" inputmode="decimal" bind:value={amount} required placeholder="0.00" size="12" aria-invalid={cents === null ? 'true' : undefined} />
		</label>
		<label style="flex:1">Reference <input bind:value={reference} maxlength="100" placeholder={paying ? 'Cheque / confirmation #' : 'Cheque / deposit #'} /></label>
	</div>
	{#if entity}
		<p class="small" style="margin-top:0">
			{#if owed.length}
				{#each owed as o (o.code)}
					<span class="badge {o.owed_cents > 0 ? 'warn' : ''}">
						{o.owed_cents > 0 ? (paying ? `You owe ${entity.name}` : `${entity.name} owes`) : paying ? `${entity.name} holds a credit of` : `${entity.name} has a credit of`}
						{formatCents(Math.abs(o.owed_cents))}
						{o.currency}
					</span>
					<button type="button" class="link" onclick={() => (amount = formatCents(Math.abs(o.owed_cents)).replaceAll(',', ''))} disabled={o.owed_cents <= 0}>use this amount</button>
					<a href="/accounts/{o.code}">{o.code}</a>
				{/each}
			{:else}
				<span class="muted">Nothing is owed {paying ? 'to' : 'by'} {entity.name}{bank ? ` in ${bank.currency}` : ''} right now.</span>
			{/if}
		</p>
	{/if}
	<p style="margin-bottom:0">
		<button class="primary" disabled={saving || !ready}>{saving ? 'Posting…' : paying ? 'Pay bill' : 'Receive payment'}</button>
		<label class="inline small" style="margin-left:0.75rem"><input type="checkbox" bind:checked={another} /> Enter another after this</label>
	</p>
	<p class="muted small" style="margin-bottom:0">
		{#if paying}
			Posts one entry: the vendor's own account under accounts payable is debited (you owe them less), the bank or card is credited.
		{:else}
			Posts one entry: the bank is debited, the customer's own account under accounts receivable is credited (they owe less).
		{/if}
		Each {paying ? 'vendor' : 'customer'} has an account of their own, made the first time something is posted for them; its balance is what is still owed.
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
