<script lang="ts">
	import { page } from '$app/state';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type Account } from '#lib/api/client.ts';
	import { naturalBalance } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The page's copy, updated by each answer from the server.
	let accounts = $state<Account[]>([]);
	$effect.pre(() => {
		accounts = data.clearing;
	});
	let canEdit = $derived(page.data.user != null && page.data.user.role !== 'viewer');
	let busy = $state('');
	let error: unknown = $state(null);

	const made = (a: Account) =>
		a.module_id === 'ledger' ? 'Ledger (reconciliation)' : a.module_id ? (page.data.modules?.find((m: { id: string }) => m.id === a.module_id)?.label ?? a.module_id) : 'A person';

	async function setShown(a: Account, shown: boolean) {
		error = null;
		busy = a.code;
		try {
			const saved = unwrap(await api().PATCH('/accounts/{accountCode}', { params: { path: { accountCode: a.code } }, body: { hidden: !shown } }));
			accounts = accounts.map((x) => (x.code === saved.code ? saved : x));
		} catch (e) {
			error = e;
		} finally {
			busy = '';
		}
	}
</script>

<p class="muted" style="margin-top:0">
	Clearing accounts hold one side of a transaction until the other side is posted, so they come back to zero. Modules make their
	own, and Ledger posts what a reconciliation couldn't match to <strong>Unreconciled</strong>. They are hidden from the account
	list and the account dropdowns; reports and balances still count them. Turn one on to show it.
</p>
<ErrorNotice {error} />

<div class="table-wrap">
	{#if accounts.length === 0}
		<div class="empty">No clearing accounts yet.</div>
	{:else}
		<table>
			<thead>
				<tr><th>Account</th><th>Made by</th><th class="num">Balance</th><th>Shown</th></tr>
			</thead>
			<tbody>
				{#each accounts as a (a.code)}
					<tr>
						<td>
							<a href="/accounts/{encodeURIComponent(a.code)}"><span class="mono">{a.code}</span> {a.name}</a>
							<span class="muted small">{a.currency}</span>
							{#if !a.is_active}<span class="badge warn">inactive</span>{/if}
						</td>
						<td>{made(a)}</td>
						<td class="num">
							<Amount cents={naturalBalance(a.type, a.balance_cents)} />
							{#if a.balance_cents !== 0}<span class="badge warn">not cleared</span>{/if}
						</td>
						<td>
							<label class="switch">
								<input
									type="checkbox"
									role="switch"
									checked={!a.hidden}
									disabled={!canEdit || busy === a.code}
									aria-label="Show {a.code} {a.name} in account lists"
									onchange={(e) => setShown(a, e.currentTarget.checked)}
								/>
								<span class="small">{a.hidden ? 'Hidden' : 'Shown'}</span>
							</label>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.switch {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
		white-space: nowrap;
	}
</style>
