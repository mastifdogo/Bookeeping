<script lang="ts">
	import { goto } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import AccountSelect from '#lib/components/AccountSelect.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import StatementPicker from '#lib/components/StatementPicker.svelte';
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
	let statementId = $state<number | null>(null);
	let reading = $state(false);
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

	// The AI reads the statement's closing date and balance, starts the reconciliation and ticks what matches.
	async function readAndStart() {
		error = null;
		if (!accountCode || statementId === null) {
			error = new Error('Choose the account and the statement first.');
			return;
		}
		busy = reading = true;
		try {
			const d = unwrap(await api().POST('/reconciliations/from-statement', { body: { account_code: accountCode, document_id: statementId } }));
			await goto(`/reconcile/${d.reconciliation.id}`);
		} catch (err) {
			error = err;
		} finally {
			busy = reading = false;
		}
	}

	async function start(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!statementDate || balance.trim() === '') {
			error = new Error('Enter the statement date and ending balance, or choose a statement and have the AI read it.');
			return;
		}
		const cents = parseSignedAmount(balance);
		if (cents === null) {
			error = new Error('The statement balance must be an amount such as 1234.56 (or -12.50 if overdrawn).');
			return;
		}
		busy = true;
		try {
			const d = unwrap(
				await api().POST('/reconciliations', { body: { account_code: accountCode, statement_date: statementDate, statement_balance_cents: cents, document_id: statementId } })
			);
			await goto(`/reconcile/${d.reconciliation.id}`);
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// History: every reconciliation session, named by the day its statement ends.
	const describe = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
	let filterAccount = $state('');
	let filterYear = $state('');
	let historyAccounts = $derived([...new Map(data.reconciliations.map((r) => [r.account_code, r.account_name])).entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })));
	let years = $derived([...new Set(data.reconciliations.map((r) => r.statement_date.slice(0, 4)))].sort().reverse());
	let history = $derived(
		data.reconciliations
			.filter((r) => (!filterAccount || r.account_code === filterAccount) && (!filterYear || r.statement_date.startsWith(filterYear)))
			.sort((a, b) => b.statement_date.localeCompare(a.statement_date) || b.id - a.id)
	);

	const openRow = (e: MouseEvent, href: string) => {
		if (!(e.target as HTMLElement).closest('a, button, input')) goto(href);
	};
</script>

<h1>Reconcile</h1>
<p class="muted" style="margin-top:0">
	Match an account against a bank or card statement. Choose the statement's PDF and the AI reads its closing date,
	balance and lines, then ticks the transactions that match, with the statement shown beside them for you to check. Or
	enter the date and balance yourself and tick each transaction. When the difference is 0.00, finish.
</p>

<form class="card" bind:this={form} onsubmit={start}>
	<h2 style="margin-top:0">New reconciliation</h2>
	<ErrorNotice {error} />
	<div class="toolbar" style="margin:0; align-items:flex-end">
		<label style="flex:1; min-width:14rem">
			Account
			<AccountSelect bind:value={accountCode} accounts={data.accounts} label="Account" placeholder="Choose an account" required defaults={{ type: 'asset' }} />
		</label>
		<div class="field" style="flex:1; min-width:16rem">
			<span>Statement</span>
			<StatementPicker bind:value={statementId} statements={data.statements} disabled={busy} onerror={(e) => (error = e)} />
		</div>
	</div>
	<div class="toolbar" style="margin:0.75rem 0 0; align-items:flex-end">
		<button type="button" class="primary" disabled={busy || !accountCode || statementId === null} onclick={readAndStart}>
			{reading ? 'Reading the statement…' : 'Read statement and pre-reconcile'}
		</button>
		<span class="muted small" style="align-self:center">or enter them yourself:</span>
		<label>Statement date <input type="date" bind:value={statementDate} /></label>
		<label>
			Statement ending balance
			<input name="balance" bind:value={balance} inputmode="decimal" placeholder="0.00" size="12" />
		</label>
		<button disabled={busy || !accountCode}>Start</button>
	</div>
	<p class="muted small" style="margin-bottom:0">
		For a credit card or loan, enter the amount owed as a positive number. Reading a statement uses the LLM connection for
		images and documents (Settings → LLM API); what it ticks is a first pass that you check before finishing.
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

<div class="toolbar">
	<h2 style="margin:0">History</h2>
	<span class="spacer"></span>
	{#if data.reconciliations.length > 0}
		<label>
			Account
			<select bind:value={filterAccount}>
				<option value="">All accounts</option>
				{#each historyAccounts as [code, name] (code)}<option value={code}>{code} {name}</option>{/each}
			</select>
		</label>
		<label>
			Year
			<select bind:value={filterYear}>
				<option value="">All years</option>
				{#each years as y (y)}<option value={y}>{y}</option>{/each}
			</select>
		</label>
	{/if}
</div>
<div class="table-wrap">
	{#if data.reconciliations.length === 0}
		<div class="empty">No reconciliations yet.</div>
	{:else if history.length === 0}
		<div class="empty">No reconciliations for that account and year.</div>
	{:else}
		<table>
			<thead>
				<tr><th>Reconciliation</th><th>Year</th><th>Account</th><th class="num">Statement balance</th><th class="num">Cleared</th><th>Status</th></tr>
			</thead>
			<tbody>
				{#each history as r (r.id)}
					<tr class="clickable" onclick={(e) => openRow(e, `/reconcile/${r.id}`)}>
						<td><a href="/reconcile/{r.id}"><strong>{describe(r.statement_date)}</strong></a></td>
						<td class="mono">{r.statement_date.slice(0, 4)}</td>
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
	select {
		width: auto;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
