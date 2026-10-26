<script lang="ts">
	import { goto } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, today, unwrap, type Account, type Reconciliation } from '#lib/api/client.ts';
	import { naturalBalance, parseSignedAmount } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Bank and card accounts (assets and liabilities) are the usual ones to reconcile.
	let showAll = $state(false);
	let accounts = $derived(data.accounts.filter((a) => showAll || a.type === 'asset' || a.type === 'liability'));

	// Per account: the reconciliation in progress and the last finished one.
	let byAccount = $derived.by(() => {
		const m = new Map<string, { open?: Reconciliation; last?: Reconciliation }>();
		for (const r of data.reconciliations) {
			const e = m.get(r.account_code) ?? {};
			if (r.status === 'open') e.open = r;
			else if (!e.last || r.statement_date > e.last.statement_date) e.last = r;
			m.set(r.account_code, e);
		}
		return m;
	});

	let accountCode = $state('');
	let statementDate = $state(today());
	let balance = $state('');
	let busy = $state(false);
	let error: unknown = $state(null);
	let form: HTMLFormElement | undefined = $state();

	$effect.pre(() => {
		if (data.preselect && !accountCode) accountCode = data.preselect;
	});

	function startFor(a: Account) {
		accountCode = a.code;
		form?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		form?.querySelector<HTMLInputElement>('input[name=balance]')?.focus();
	}

	async function start(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		const cents = parseSignedAmount(balance);
		if (cents === null) {
			error = new Error('The statement balance must be an amount such as 1234.56 (or -12.50 if overdrawn).');
			return;
		}
		busy = true;
		try {
			const d = unwrap(
				await api().POST('/reconciliations', { body: { account_code: accountCode, statement_date: statementDate, statement_balance_cents: cents } })
			);
			await goto(`/reconcile/${d.reconciliation.id}`);
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	const openRow = (e: MouseEvent, href: string) => {
		if (!(e.target as HTMLElement).closest('a, button, input')) goto(href);
	};
</script>

<h1>Reconcile</h1>
<p class="muted" style="margin-top:0">
	Match an account against a bank or card statement: enter the statement's closing date and balance, then tick each
	transaction that appears on it. When the difference is 0.00, finish.
</p>

<form class="card" bind:this={form} onsubmit={start}>
	<h2 style="margin-top:0">New reconciliation</h2>
	<ErrorNotice {error} />
	<div class="toolbar" style="margin:0; align-items:flex-end">
		<label style="flex:1; min-width:14rem">
			Account
			<select bind:value={accountCode} required>
				<option value="" disabled>Choose an account</option>
				{#each data.accounts as a (a.code)}
					<option value={a.code}>{a.code} · {a.name} ({a.currency})</option>
				{/each}
			</select>
		</label>
		<label>Statement date <input type="date" bind:value={statementDate} required /></label>
		<label>
			Statement ending balance
			<input name="balance" bind:value={balance} inputmode="decimal" placeholder="0.00" required size="12" />
		</label>
		<button class="primary" disabled={busy || !accountCode}>Start</button>
	</div>
	<p class="muted small" style="margin-bottom:0">
		For a credit card or loan, enter the amount owed as a positive number.
	</p>
</form>

<div class="toolbar">
	<h2 style="margin:0">Accounts</h2>
	<span class="spacer"></span>
	<label class="inline"><input type="checkbox" bind:checked={showAll} /> Show all account types</label>
</div>
<div class="table-wrap">
	{#if accounts.length === 0}
		<div class="empty">No bank or card accounts yet. <a href="/accounts">Create one →</a></div>
	{:else}
		<table>
			<thead>
				<tr><th>Account</th><th>Last reconciled</th><th class="num">Reconciled balance</th><th class="num">Book balance</th><th></th></tr>
			</thead>
			<tbody>
				{#each accounts as a (a.code)}
					{@const r = byAccount.get(a.code)}
					<tr>
						<td><span class="mono">{a.code}</span> {a.name} <span class="muted small">{a.currency}</span></td>
						<td class="mono">{r?.last?.statement_date ?? '—'}</td>
						<td class="num">{#if r?.last}<Amount cents={r.last.statement_balance_cents} />{/if}</td>
						<td class="num"><Amount cents={naturalBalance(a.type, a.balance_cents)} /></td>
						<td class="num">
							{#if r?.open}
								<a class="button" href="/reconcile/{r.open.id}">Continue</a>
							{:else}
								<button onclick={() => startFor(a)}>Reconcile</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<h2>History</h2>
<div class="table-wrap">
	{#if data.reconciliations.length === 0}
		<div class="empty">No reconciliations yet.</div>
	{:else}
		<table>
			<thead>
				<tr><th>Statement</th><th>Account</th><th class="num">Balance</th><th class="num">Cleared</th><th>Status</th></tr>
			</thead>
			<tbody>
				{#each data.reconciliations as r (r.id)}
					<tr class="clickable" onclick={(e) => openRow(e, `/reconcile/${r.id}`)}>
						<td class="mono"><a href="/reconcile/{r.id}">{r.statement_date}</a></td>
						<td><span class="mono">{r.account_code}</span> {r.account_name}</td>
						<td class="num"><Amount cents={r.statement_balance_cents} currency={r.currency} /></td>
						<td class="num">{r.cleared_count}</td>
						<td>
							{#if r.status === 'open'}<span class="badge warn">in progress</span>{:else}<span class="badge ok">reconciled</span>
								<span class="muted small">{r.finished_by ? `by ${r.finished_by}` : ''}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	tr.clickable {
		cursor: pointer;
	}
</style>
