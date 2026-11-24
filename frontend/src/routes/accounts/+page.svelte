<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { ACCOUNT_KINDS, ACCOUNT_TYPES, CURRENCIES, api, kindLabel, unwrap, type Account, type AccountKind, type AccountType, type Currency } from '#lib/api/client.ts';
	import { naturalBalance } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let showForm = $state(false);
	let code = $state('');
	let name = $state('');
	let type = $state<AccountType>('asset');
	let currency = $state<Currency>('CAD');
	let description = $state('');
	let parent = $state('');
	// Chequing, savings (assets) or credit card (liabilities).
	let kind = $state<AccountKind | ''>('');
	let kinds = $derived(ACCOUNT_KINDS.filter((k) => k.type === type));
	$effect(() => {
		if (kind && !kinds.some((k) => k.value === kind)) kind = '';
	});
	// A sub-account sits under an account of the same type and currency.
	let parents = $derived(data.accounts.filter((a) => a.type === type && a.currency === currency));
	$effect(() => {
		if (parent && !parents.some((a) => a.code === parent)) parent = '';
	});
	let saving = $state(false);
	let error = $state<unknown>(null);
	let created = $state('');

	async function create(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const acc = unwrap(await api().POST('/accounts', { body: { code, name, type, currency, description, parent_code: parent || null, kind: kind || null } }));
			created = `Created ${acc.code} ${acc.name} (${acc.currency})${acc.parent_code ? ` under ${acc.parent_code}` : ''}.`;
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
	// By code (the default) the chart is a tree: each account, then its sub-accounts, indented.
	let tree = $derived(sort.key === 'code' && !sort.desc);
	// Sub-accounts are folded into their parent until it is expanded. Remembered in this browser.
	const OPEN_STORAGE = 'ledger.accounts.open';
	function readOpen(): string[] {
		try {
			const v = JSON.parse(localStorage.getItem(OPEN_STORAGE) ?? '[]');
			return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}
	let open = $state<string[]>(readOpen());
	function setOpen(next: string[]) {
		open = next;
		try {
			localStorage.setItem(OPEN_STORAGE, JSON.stringify(next));
		} catch {
			// storage blocked: keep it for this page only
		}
	}
	const toggle = (code: string) => setOpen(open.includes(code) ? open.filter((c) => c !== code) : [...open, code]);
	let folded = $derived([...new Set(data.accounts.map((a) => a.parent_code).filter((c): c is string => !!c && data.accounts.some((a) => a.code === c)))]);
	let allOpen = $derived(folded.length > 0 && folded.every((c) => open.includes(c)));
	let rows = $derived.by((): { a: Account; depth: number; kids: number }[] => {
		if (!tree) return sorted.map((a) => ({ a, depth: 0, kids: 0 }));
		const codes = new Set(sorted.map((a) => a.code));
		const under = new Map<string, Account[]>();
		for (const a of sorted) {
			// A sub-account whose parent isn't listed (inactive and hidden) shows at the top level.
			const key = a.parent_code && codes.has(a.parent_code) ? a.parent_code : '';
			under.set(key, [...(under.get(key) ?? []), a]);
		}
		const out: { a: Account; depth: number; kids: number }[] = [];
		// Every account below this one, however deep.
		const below = (code: string, depth = 0): number => (depth > 10 ? 0 : (under.get(code) ?? []).reduce((n, c) => n + 1 + below(c.code, depth + 1), 0));
		const walk = (key: string, depth: number) => {
			for (const a of under.get(key) ?? []) {
				out.push({ a, depth, kids: below(a.code) });
				if (depth < 10 && open.includes(a.code)) walk(a.code, depth + 1);
			}
		};
		walk('', 0);
		return out;
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
	// Clearing accounts should sit at zero: the ones that don't are pointed out.
	let uncleared = $derived([...data.accounts, ...data.hidden].filter((a) => a.kind === 'clearing' && a.is_active && a.balance_cents !== 0));
</script>

<div class="toolbar">
	<span class="spacer"></span>
	{#if tree && folded.length > 0}
		<button onclick={() => setOpen(allOpen ? [] : folded)}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
	{/if}
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
					{#each parents as p (p.code)}<option value={p.code}>{p.code} {p.name}</option>{/each}
				</select>
			</label>
			<label style="flex:1">Description <input bind:value={description} maxlength="1000" /></label>
			<button class="primary" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
		</div>
		<p class="muted small" style="margin-bottom:0">
			The currency cannot be changed later; the code can, on the account's page. A tag (chequing, savings, credit card) marks bank and card accounts, so forms and
			modules can offer them first.
		</p>
	</form>
{/if}

{#if uncleared.length > 0}
	<div class="notice warn-note">
		<strong>Clearing accounts with a balance.</strong> What is posted to a clearing account is meant to be cleared again, so it returns to
		zero:
		{#each uncleared as a, i (a.code)}{i ? ', ' : ' '}<a href="/accounts/{encodeURIComponent(a.code)}"><span class="mono">{a.code}</span> {a.name}</a>
			(<Amount cents={naturalBalance(a.type, a.balance_cents)} currency={a.currency} />){/each}.
	</div>
{/if}
{#if data.hidden.length > 0}
	<p class="muted small">
		{data.hidden.length} hidden account{data.hidden.length === 1 ? ' is' : 's are'} not listed here (clearing accounts, unless shown).
		<a href="/settings/clearing">Settings → Clearing accounts</a>
	</p>
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
				{#each rows as { a, depth, kids } (a.code)}
					<tr class="clickable" onclick={(e) => openRow(e, a.code)}>
						<td class="mono"><a href="/accounts/{encodeURIComponent(a.code)}">{a.code}</a></td>
						<td style:padding-left={depth ? `${0.6 + depth * 1.25}rem` : undefined}>
							{#if kids}
								<button class="fold" aria-expanded={open.includes(a.code)} aria-label="{open.includes(a.code) ? 'Hide' : 'Show'} the sub-accounts of {a.name}" title="{open.includes(a.code) ? 'Hide' : 'Show'} the {kids} sub-account{kids === 1 ? '' : 's'} of {a.name}" onclick={() => toggle(a.code)}>
									<span aria-hidden="true">{open.includes(a.code) ? '▾' : '▸'}</span>
								</button>
							{:else if depth}<span class="muted" aria-hidden="true">↳ </span>{/if}{a.name}
							{#if kids && !open.includes(a.code)}<button class="link small" onclick={() => toggle(a.code)}>{kids} sub-account{kids === 1 ? '' : 's'}</button>{/if}
							{#if a.entity}<a class="badge" href="/journal?entity_id={a.entity.id}" title="{a.entity.name}'s own account: what {a.entity.role === 'customer' ? 'they owe' : 'they are owed'}">{a.entity.role}</a>{/if}
							{#if a.kind}<span class="badge" class:warn={a.kind === 'clearing' && a.balance_cents !== 0}>{kindLabel(a.kind)}{a.kind === 'clearing' && a.balance_cents !== 0 ? ': not cleared' : ''}</span>{/if}
							{#if !tree && a.parent_code}<span class="muted small">(under {a.parent_code})</span>{/if}
							{#if a.description}<div class="muted small">{a.description}</div>{/if}
						</td>
						<td>{a.type}</td>
						<td>{a.currency}</td>
						<td class="num">
							<Amount cents={naturalBalance(a.type, a.balance_cents)} />
							{#if kids || a.total_balance_cents !== a.balance_cents}
								<div class="muted small">with sub-accounts <Amount cents={naturalBalance(a.type, a.total_balance_cents)} /></div>
							{/if}
						</td>
						<td>{#if !a.is_active}<span class="badge warn">inactive</span>{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
<p class="muted small">
	Balances use each account's normal side: debit for assets and expenses, credit for liabilities, equity and revenue. Sorted by code,
	sub-accounts are folded into their parent: ▸ shows them, and the parent's line gives the total with them. A parent's own balance is
	what is posted to it directly.
</p>

<style>
	.warn-note {
		background: var(--warn-bg);
		color: var(--text);
	}
	button.fold {
		all: unset;
		cursor: pointer;
		display: inline-block;
		width: 1.1rem;
		color: var(--muted);
	}
	button.fold:focus-visible {
		outline: 2px solid var(--accent);
		border-radius: 3px;
	}
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
