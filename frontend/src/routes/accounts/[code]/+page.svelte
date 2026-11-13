<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import { openRow } from '#lib/rows.ts';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { ACCOUNT_KINDS, api, kindLabel, unwrap, type Account, type AccountKind } from '#lib/api/client.ts';
	import { naturalBalance } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let account = $derived(data.ledger.account);

	let from = $state('');
	let to = $state('');
	$effect.pre(() => {
		from = data.from;
		to = data.to;
	});

	let editing = $state(false);
	let name = $state('');
	let description = $state('');
	let parent = $state('');
	let kind = $state<AccountKind | ''>('');
	let kinds = $derived(ACCOUNT_KINDS.filter((k) => k.type === account.type));
	// Accounts this one could sit under: same type and currency, not itself or anything below it.
	let candidates = $state<Account[]>([]);
	let children = $derived(data.accounts.filter((a) => a.parent_code === account.code));
	let parentAccount = $derived(data.accounts.find((a) => a.code === account.parent_code));
	let busy = $state(false);
	let error = $state<unknown>(null);

	function applyFilter(e: SubmitEvent) {
		e.preventDefault();
		const q = new URLSearchParams();
		if (from) q.set('from', from);
		if (to) q.set('to', to);
		goto(`?${q}`, { reset: false });
	}

	function startEdit() {
		name = account.name;
		description = account.description;
		parent = account.parent_code ?? '';
		kind = account.kind ?? '';
		const below = new Set([account.code]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const a of data.accounts) if (a.parent_code && below.has(a.parent_code) && !below.has(a.code)) (below.add(a.code), (grew = true));
		}
		candidates = data.accounts.filter((a) => a.type === account.type && a.currency === account.currency && !below.has(a.code));
		editing = true;
	}

	async function update(body: { name?: string; description?: string; is_active?: boolean; parent_code?: string | null; kind?: AccountKind | null }) {
		busy = true;
		error = null;
		try {
			unwrap(await api().PATCH('/accounts/{accountCode}', { params: { path: { accountCode: account.code } }, body }));
			editing = false;
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
</script>

<p class="small"><a href="/accounts">← Accounts</a></p>

<div class="toolbar">
	<h1 style="margin:0">
		<span class="mono">{account.code}</span>
		{account.name}
		<span class="badge">{account.type}</span>
		<span class="badge">{account.currency}</span>
		{#if account.kind}<span class="badge">{kindLabel(account.kind)}</span>{/if}
		{#if !account.is_active}<span class="badge warn">inactive</span>{/if}
	</h1>
	<span class="spacer"></span>
	<a class="button" href="/reconcile?account={encodeURIComponent(account.code)}">Reconcile</a>
	<button onclick={startEdit} disabled={busy}>Edit</button>
	<button onclick={() => update({ is_active: !account.is_active })} disabled={busy}>
		{account.is_active ? 'Deactivate' : 'Reactivate'}
	</button>
</div>
{#if account.description && !editing}<p class="muted">{account.description}</p>{/if}
{#if parentAccount || children.length}
	<p class="small">
		{#if parentAccount}Sub-account of <a href="/accounts/{encodeURIComponent(parentAccount.code)}"><span class="mono">{parentAccount.code}</span> {parentAccount.name}</a>.{/if}
		{#if children.length}
			Sub-accounts:
			{#each children as c, i (c.code)}{i ? ', ' : ''}<a href="/accounts/{encodeURIComponent(c.code)}"><span class="mono">{c.code}</span> {c.name}</a>{/each}.
			Balance with sub-accounts: <strong><Amount cents={naturalBalance(account.type, account.total_balance_cents)} currency={account.currency} /></strong>
			(this page lists what is posted to {account.code} itself).
		{/if}
	</p>
{/if}

<ErrorNotice {error} />

{#if editing}
	<form
		class="card toolbar"
		onsubmit={(e) => {
			e.preventDefault();
			update({ name, description, ...(parent !== (account.parent_code ?? '') ? { parent_code: parent || null } : {}), ...(kind !== (account.kind ?? '') ? { kind: kind || null } : {}) });
		}}
	>
		<label style="flex:1">Name <input bind:value={name} required maxlength="200" /></label>
		<label style="flex:2">Description <input bind:value={description} maxlength="1000" /></label>
		{#if kinds.length}
			<label>
				Tag
				<select bind:value={kind}>
					<option value="">— none —</option>
					{#each kinds as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
				</select>
			</label>
		{/if}
		<label>
			Sub-account of
			<select bind:value={parent}>
				<option value="">— none (top level) —</option>
				{#each candidates as p (p.code)}<option value={p.code}>{p.code} {p.name}</option>{/each}
			</select>
		</label>
		<button class="primary" disabled={busy}>Save</button>
		<button type="button" onclick={() => (editing = false)}>Cancel</button>
	</form>
{/if}

<form class="toolbar" onsubmit={applyFilter}>
	<label>From <input type="date" bind:value={from} /></label>
	<label>To <input type="date" bind:value={to} /></label>
	<button>Apply</button>
	{#if data.from || data.to}<a class="button" href="?">Clear</a>{/if}
	<span class="spacer"></span>
	<a class="button" href="/journal?account_code={encodeURIComponent(account.code)}">Entries using this account</a>
</form>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Date</th><th>Entry</th><th>Description</th>
				<th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance (Dr +)</th>
			</tr>
		</thead>
		<tbody>
			{#if data.from}
				<tr>
					<td class="mono">{data.from}</td><td></td><td class="muted">Opening balance</td><td></td><td></td>
					<td class="num"><Amount cents={data.ledger.opening_balance_cents} /></td>
				</tr>
			{/if}
			{#each data.ledger.lines as l (l.line_id)}
				<tr class="clickable" onclick={(ev) => openRow(ev, `/journal/${l.journal_entry_id}`)}>
					<td class="mono">{l.entry_date}</td>
					<td><a class="quiet" href="/journal/{l.journal_entry_id}">#{l.journal_entry_id}</a></td>
					<td>
						{l.description}
						{#if l.memo}<div class="muted small">{l.memo}</div>{/if}
					</td>
					<td class="num"><Amount cents={l.debit_cents} blankZero /></td>
					<td class="num"><Amount cents={l.credit_cents} blankZero /></td>
					<td class="num"><Amount cents={l.running_balance_cents} /></td>
				</tr>
			{:else}
				<tr><td colspan="6" class="empty">No postings in this period.</td></tr>
			{/each}
		</tbody>
		<tfoot>
			<tr>
				<td colspan="5">Closing balance</td>
				<td class="num"><Amount cents={data.ledger.closing_balance_cents} currency={account.currency} /></td>
			</tr>
		</tfoot>
	</table>
</div>
