<script lang="ts">
	import { goto } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type ReconciliationDetail } from '#lib/api/client.ts';
	import { centsToInput, parseSignedAmount } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The page's copy, replaced by each answer from the server.
	let d = $state<ReconciliationDetail>(undefined!);
	$effect.pre(() => {
		d = data.detail;
	});
	let rec = $derived(d.reconciliation);
	let open = $derived(rec.status === 'open');
	let error: unknown = $state(null);
	let busy = $state(false);
	let hideCleared = $state(false);
	let editing = $state(false);
	let editDate = $state('');
	let editBalance = $state('');

	let shown = $derived(hideCleared ? d.lines.filter((l) => !l.cleared) : d.lines);
	let allCleared = $derived(d.lines.length > 0 && d.lines.every((l) => l.cleared));
	let clearedCount = $derived(d.lines.filter((l) => l.cleared).length);
	let debitNormal = $derived(rec.account_type === 'asset' || rec.account_type === 'expense');

	const path = () => ({ params: { path: { reconciliationId: rec.id } } });

	async function run(fn: () => Promise<ReconciliationDetail | void>) {
		error = null;
		busy = true;
		try {
			const r = await fn();
			if (r) d = r;
		} catch (e) {
			error = e;
		} finally {
			busy = false;
		}
	}

	function toggle(ids: number[], clear: boolean) {
		// Show the tick at once; the server's answer replaces it.
		const set = new Set(ids);
		d = { ...d, lines: d.lines.map((l) => (set.has(l.transaction_id) ? { ...l, cleared: clear } : l)) };
		run(async () => unwrap(await api().POST('/reconciliations/{reconciliationId}/cleared', { ...path(), body: clear ? { clear: ids } : { unclear: ids } })));
	}

	function startEdit() {
		editDate = rec.statement_date;
		editBalance = centsToInput(rec.statement_balance_cents) || '0';
		editing = true;
	}

	function saveEdit(e: SubmitEvent) {
		e.preventDefault();
		const cents = parseSignedAmount(editBalance);
		if (cents === null) {
			error = new Error('The statement balance must be an amount such as 1234.56.');
			return;
		}
		run(async () => {
			const r = unwrap(
				await api().PATCH('/reconciliations/{reconciliationId}', { ...path(), body: { statement_date: editDate, statement_balance_cents: cents } })
			);
			editing = false;
			return r;
		});
	}

	const finish = () => run(async () => unwrap(await api().POST('/reconciliations/{reconciliationId}/finish', path())));
	const undo = () => run(async () => unwrap(await api().POST('/reconciliations/{reconciliationId}/undo', path())));
	function discard() {
		if (!confirm('Discard this reconciliation? Ticked lines go back to uncleared.')) return;
		run(async () => {
			const res = await api().DELETE('/reconciliations/{reconciliationId}', path());
			if (res.response.status !== 204) unwrap(res);
			await goto('/reconcile');
		});
	}
</script>

<p class="small"><a href="/reconcile">← Reconcile</a></p>

<div class="toolbar">
	<h1 style="margin:0">
		<span class="mono">{rec.account_code}</span>
		{rec.account_name}
		<span class="badge">{rec.currency}</span>
		{#if open}<span class="badge warn">in progress</span>{:else}<span class="badge ok">reconciled</span>{/if}
	</h1>
	<span class="spacer"></span>
	{#if open}
		<button onclick={discard} disabled={busy}>Discard</button>
		<button class="primary" onclick={finish} disabled={busy || d.difference_cents !== 0}>Finish</button>
	{:else}
		<button onclick={undo} disabled={busy} title="Reopen for changes (most recent reconciliation only)">Undo</button>
	{/if}
</div>

<ErrorNotice {error} />

<div class="summary">
	<div class="card stat">
		<span class="muted small">Statement {rec.statement_date}</span>
		{#if editing}
			<form onsubmit={saveEdit} class="edit">
				<input type="date" bind:value={editDate} required />
				<input bind:value={editBalance} inputmode="decimal" required size="10" aria-label="Statement ending balance" />
				<button class="primary" disabled={busy}>Save</button>
				<button type="button" onclick={() => (editing = false)}>Cancel</button>
			</form>
		{:else}
			<strong class="big"><Amount cents={rec.statement_balance_cents} /></strong>
			{#if open}<button class="link small" onclick={startEdit}>Change</button>{/if}
		{/if}
	</div>
	<div class="card stat">
		<span class="muted small">Cleared balance</span>
		<strong class="big"><Amount cents={d.cleared_balance_cents} /></strong>
		<span class="muted small">Earlier statements <Amount cents={d.opening_balance_cents} /> · {clearedCount} ticked</span>
	</div>
	<div class="card stat" class:balanced={d.difference_cents === 0} class:off={d.difference_cents !== 0}>
		<span class="muted small">Difference</span>
		<strong class="big"><Amount cents={d.difference_cents} /></strong>
		<span class="small">
			{#if d.difference_cents === 0}{open ? 'Balanced. Ready to finish.' : `Reconciled${rec.finished_by ? ` by ${rec.finished_by}` : ''}.`}{:else}Tick
				lines until this is 0.00.{/if}
		</span>
	</div>
</div>

<div class="toolbar">
	<h2 style="margin:0">Transactions to {rec.statement_date}</h2>
	<span class="spacer"></span>
	<label class="inline"><input type="checkbox" bind:checked={hideCleared} /> Hide ticked</label>
</div>

<div class="table-wrap">
	{#if d.lines.length === 0}
		<div class="empty">No transactions in this account on or before {rec.statement_date}.</div>
	{:else}
		<table>
			<thead>
				<tr>
					<th style="width:2rem">
						<input
							type="checkbox"
							checked={allCleared}
							disabled={!open || busy}
							aria-label="Tick all"
							onchange={(e) =>
								toggle(
									d.lines.filter((l) => l.cleared !== (e.currentTarget as HTMLInputElement).checked).map((l) => l.transaction_id),
									(e.currentTarget as HTMLInputElement).checked
								)}
						/>
					</th>
					<th>Date</th>
					<th>#</th>
					<th>Description</th>
					<th class="num">{debitNormal ? 'Deposit' : 'Charge'}</th>
					<th class="num">{debitNormal ? 'Withdrawal' : 'Payment'}</th>
				</tr>
			</thead>
			<tbody>
				{#each shown as l (l.transaction_id)}
					<tr
						class:cleared={l.cleared}
						class:clickable={open}
						onclick={(e) => open && !(e.target as HTMLElement).closest('a, input') && toggle([l.transaction_id], !l.cleared)}
					>
						<td>
							<input
								type="checkbox"
								checked={l.cleared}
								disabled={!open || busy}
								aria-label="Ticked"
								onchange={() => toggle([l.transaction_id], !l.cleared)}
							/>
						</td>
						<td class="mono">{l.entry_date}</td>
						<td><a href="/journal/{l.journal_entry_id}">{l.journal_entry_id}</a></td>
						<td>
							{l.description}{#if l.reference}<span class="muted small"> · {l.reference}</span>{/if}
							{#if l.memo}<div class="muted small">{l.memo}</div>{/if}
						</td>
						<td class="num"><Amount cents={l.amount_cents > 0 ? l.amount_cents : 0} blankZero /></td>
						<td class="num"><Amount cents={l.amount_cents < 0 ? -l.amount_cents : 0} blankZero /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0;
	}
	.big {
		font-size: 1.5rem;
	}
	.balanced {
		border-color: var(--ok);
		box-shadow: inset 4px 0 var(--ok);
	}
	.off {
		box-shadow: inset 4px 0 var(--warn);
	}
	.edit {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.edit input {
		width: auto;
	}
	button.link {
		align-self: flex-start;
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
	}
	tr.clickable {
		cursor: pointer;
	}
	tr.cleared td {
		background: var(--ok-bg);
	}
	td input[type='checkbox'],
	th input[type='checkbox'] {
		width: auto;
		margin: 0;
	}
</style>
