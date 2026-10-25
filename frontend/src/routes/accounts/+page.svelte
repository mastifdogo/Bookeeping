<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { ACCOUNT_TYPES, CURRENCIES, api, unwrap, type Account, type AccountType, type Currency } from '#lib/api/client.ts';
	import { naturalBalance } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let showForm = $state(false);
	let code = $state('');
	let name = $state('');
	let type = $state<AccountType>('asset');
	let currency = $state<Currency>('CAD');
	let description = $state('');
	let saving = $state(false);
	let error = $state<unknown>(null);
	let created = $state('');

	async function create(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const acc = unwrap(await api().POST('/accounts', { body: { code, name, type, currency, description } }));
			created = `Created ${acc.code} ${acc.name} (${acc.currency}).`;
			code = name = description = '';
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			saving = false;
		}
	}

	// Sorting: click a column heading; again to reverse. Remembered in this browser.
	type SortKey = 'code' | 'name' | 'type' | 'currency' | 'balance' | 'status';
	const SORT_STORAGE = 'ledger.accounts.sort';
	function readSort(): { key: SortKey; desc: boolean } {
		try {
			const v = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? 'null');
			if (v && ['code', 'name', 'type', 'currency', 'balance', 'status'].includes(v.key)) return { key: v.key, desc: v.desc === true };
		} catch {
			// no saved order
		}
		return { key: 'code', desc: false };
	}
	let sort = $state(readSort());
	function sortBy(key: SortKey) {
		sort = { key, desc: sort.key === key ? !sort.desc : key === 'balance' };
		try {
			localStorage.setItem(SORT_STORAGE, JSON.stringify(sort));
		} catch {
			// storage blocked: keep it for this page only
		}
	}
	const byCode = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
	let sorted = $derived.by(() => {
		const cmp: Record<SortKey, (a: Account, b: Account) => number> = {
			code: (a, b) => byCode(a.code, b.code),
			name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
			type: (a, b) => ACCOUNT_TYPES.indexOf(a.type) - ACCOUNT_TYPES.indexOf(b.type),
			currency: (a, b) => a.currency.localeCompare(b.currency),
			balance: (a, b) => naturalBalance(a.type, a.balance_cents) - naturalBalance(b.type, b.balance_cents),
			status: (a, b) => Number(a.is_active) - Number(b.is_active)
		};
		const f = cmp[sort.key];
		const dir = sort.desc ? -1 : 1;
		return [...data.accounts].sort((a, b) => dir * f(a, b) || byCode(a.code, b.code));
	});
	const columns: { key: SortKey; label: string; num?: boolean }[] = [
		{ key: 'code', label: 'Code' },
		{ key: 'name', label: 'Name' },
		{ key: 'type', label: 'Type' },
		{ key: 'currency', label: 'Currency' },
		{ key: 'balance', label: 'Balance', num: true },
		{ key: 'status', label: 'Status' }
	];

	// The whole row opens the account (the code stays a real link for
	// keyboards, new tabs and middle-clicks).
	function openRow(e: MouseEvent, code: string) {
		if ((e.target as HTMLElement).closest('a, button, input') || window.getSelection()?.toString()) return;
		goto(`/accounts/${encodeURIComponent(code)}`);
	}

	function toggleInactive(e: Event) {
		goto((e.currentTarget as HTMLInputElement).checked ? '?inactive=1' : '?', { reset: false });
	}
</script>

<div class="toolbar">
	<h1 style="margin:0">Accounts</h1>
	<span class="spacer"></span>
	<label class="inline"><input type="checkbox" checked={data.includeInactive} onchange={toggleInactive} /> Show inactive</label>
	<button class="primary" onclick={() => (showForm = !showForm)}>{showForm ? 'Close' : '+ New account'}</button>
</div>

{#if created}<div class="notice ok">{created}</div>{/if}

{#if showForm}
	<form class="card" onsubmit={create}>
		<ErrorNotice {error} />
		<div class="toolbar" style="margin:0">
			<label>Code <input bind:value={code} required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" placeholder="1000" size="8" /></label>
			<label style="flex:1">Name <input bind:value={name} required maxlength="200" placeholder="Bank CAD" /></label>
			<label>
				Type
				<select bind:value={type}>
					{#each ACCOUNT_TYPES as t (t)}<option value={t}>{t}</option>{/each}
				</select>
			</label>
			<label>
				Currency
				<select bind:value={currency}>
					{#each CURRENCIES as c (c)}<option value={c}>{c}</option>{/each}
				</select>
			</label>
			<label style="flex:1">Description <input bind:value={description} maxlength="1000" /></label>
			<button class="primary" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
		</div>
		<p class="muted small" style="margin-bottom:0">The code and currency cannot be changed later.</p>
	</form>
{/if}

<div class="table-wrap">
	{#if data.accounts.length === 0}
		<div class="empty">No accounts yet.</div>
	{:else}
		<table>
			<thead>
				<tr>
					{#each columns as c (c.key)}
						<th class:num={c.num} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
							<button class="sort" onclick={() => sortBy(c.key)}
								>{c.label}<span class="arrow" aria-hidden="true">{sort.key === c.key ? (sort.desc ? '▼' : '▲') : ''}</span></button
							>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as a (a.code)}
					<tr class="clickable" onclick={(e) => openRow(e, a.code)}>
						<td class="mono"><a href="/accounts/{encodeURIComponent(a.code)}">{a.code}</a></td>
						<td>{a.name}{#if a.description}<div class="muted small">{a.description}</div>{/if}</td>
						<td>{a.type}</td>
						<td>{a.currency}</td>
						<td class="num"><Amount cents={naturalBalance(a.type, a.balance_cents)} /></td>
						<td>{#if !a.is_active}<span class="badge warn">inactive</span>{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
<p class="muted small">Balances use each account's normal side: debit for assets and expenses, credit for liabilities, equity and revenue.</p>

<style>
	button.sort {
		all: unset;
		cursor: pointer;
		font: inherit;
		color: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
		white-space: nowrap;
	}
	button.sort:hover {
		color: var(--text);
	}
	button.sort:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.arrow {
		display: inline-block;
		width: 1em;
		font-size: 0.7em;
		text-align: center;
	}
	tr.clickable {
		cursor: pointer;
	}
</style>
