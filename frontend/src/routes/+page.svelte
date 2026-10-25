<script lang="ts">
	import Amount from '#lib/components/Amount.svelte';
	import EntryTotals from '#lib/components/EntryTotals.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, today, unwrap, type DashboardItem } from '#lib/api/client.ts';
	import { invalidate } from '$app/navigation';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error: unknown = $state(null);
	let busy: number | null = $state(null);

	let summary = $derived(data.dashboard.summary);
	let notifications = $derived(data.dashboard.notifications);
	let todos = $derived(data.dashboard.todos);
	let openTodos = $derived(todos.filter((t) => t.closed_at === null).length);

	const monthName = (d: string) => new Date(d + 'T00:00:00').toLocaleString(undefined, { month: 'long' });
	const levelClass: Record<DashboardItem['level'], string> = { info: '', success: 'ok', warning: 'warn', danger: 'danger' };
	const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	async function act(item: DashboardItem, action: 'close' | 'reopen') {
		error = null;
		busy = item.id;
		try {
			unwrap(await api().POST(`/dashboard/items/{itemId}/${action}`, { params: { path: { itemId: item.id } } }));
			await invalidate('app:dashboard');
		} catch (e) {
			error = e;
		} finally {
			busy = null;
		}
	}
</script>

<h1>Dashboard</h1>

<ErrorNotice {error} />

{#if !data.hasAccounts}
	<div class="card">
		<p><strong>Welcome!</strong> Start by creating your chart of accounts.</p>
		<p>
			Each account has one currency (CAD or USD). For CAD↔USD transfers, create an FX clearing account
			(type <em>equity</em>, e.g. “Currency trading CAD/USD”) in each currency.
		</p>
		<a class="button" href="/accounts">Set up accounts →</a>
	</div>
{/if}

{#if summary.currencies.length > 0}
	<div class="grid">
		{#each summary.currencies as s (s.currency)}
			<section class="card">
				<h2 style="margin-top:0">{s.currency}</h2>
				<div class="stat">
					<span class="muted small">Net worth</span>
					<strong class="big"><Amount cents={s.net_worth_cents} currency={s.currency} /></strong>
					<span class="muted small">
						Assets <Amount cents={s.assets_cents} /> · Liabilities <Amount cents={s.liabilities_cents} />
					</span>
				</div>
				<table>
					<thead>
						<tr><th></th><th class="num">{monthName(s.month.from)}</th><th class="num">{s.year.from.slice(0, 4)} to date</th></tr>
					</thead>
					<tbody>
						<tr>
							<td>Revenue</td>
							<td class="num"><Amount cents={s.month.revenue_cents} /></td>
							<td class="num"><Amount cents={s.year.revenue_cents} /></td>
						</tr>
						<tr>
							<td>Expenses</td>
							<td class="num"><Amount cents={s.month.expenses_cents} /></td>
							<td class="num"><Amount cents={s.year.expenses_cents} /></td>
						</tr>
					</tbody>
					<tfoot>
						<tr>
							<td>Net income</td>
							<td class="num"><Amount cents={s.month.net_income_cents} /></td>
							<td class="num"><Amount cents={s.year.net_income_cents} /></td>
						</tr>
					</tfoot>
				</table>
				{#if s.top_expenses.length > 0}
					<h3 class="small muted">Top expenses this month</h3>
					<ul class="bars">
						{#each s.top_expenses as e (e.account_code)}
							<li>
								<span class="label"><a href="/accounts/{e.account_code}">{e.account_name}</a></span>
								<span class="num"><Amount cents={e.amount_cents} /></span>
								<span
									class="bar"
									style="width:{s.top_expenses[0]!.amount_cents > 0
										? Math.max(2, (100 * e.amount_cents) / s.top_expenses[0]!.amount_cents)
										: 0}%"
								></span>
							</li>
						{/each}
					</ul>
				{/if}
				<p class="small" style="margin-bottom:0">
					<a href="/reports">Full reports →</a>
				</p>
			</section>
		{/each}
	</div>
{/if}

<div class="grid two">
	<section class="card">
		<h2 style="margin-top:0">Notifications</h2>
		{#if notifications.length === 0}
			<p class="muted">Nothing new.</p>
		{:else}
			<ul class="items">
				{#each notifications as n (n.id)}
					<li class="item level-{n.level}">
						<div class="item-main">
							<div>
								{#if n.level !== 'info'}<span class="badge {levelClass[n.level]}">{n.level}</span>{/if}
								{#if n.link}<a href={n.link}><strong>{n.title}</strong></a>{:else}<strong>{n.title}</strong>{/if}
							</div>
							{#if n.body}<div class="body">{n.body}</div>{/if}
							<div class="muted small">{n.source_name} · {when(n.updated_at)}</div>
						</div>
						<button class="link" title="Dismiss" aria-label="Dismiss" disabled={busy === n.id} onclick={() => act(n, 'close')}
							>✕</button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card">
		<h2 style="margin-top:0">To-do {#if openTodos > 0}<span class="badge">{openTodos}</span>{/if}</h2>
		{#if todos.length === 0}
			<p class="muted">Nothing to do. Modules add to-dos here.</p>
		{:else}
			<ul class="items">
				{#each todos as t (t.id)}
					{@const done = t.closed_at !== null}
					{@const overdue = !done && t.due_date !== null && t.due_date < today()}
					<li class="item" class:done>
						<input
							type="checkbox"
							checked={done}
							disabled={busy === t.id}
							aria-label={done ? 'Mark not done' : 'Mark done'}
							onchange={() => act(t, done ? 'reopen' : 'close')}
						/>
						<div class="item-main">
							<div>
								{#if t.link}<a href={t.link}>{t.title}</a>{:else}{t.title}{/if}
							</div>
							{#if t.body}<div class="body">{t.body}</div>{/if}
							<div class="muted small">
								{t.source_name}
								{#if t.due_date}· <span class:overdue>due {t.due_date}</span>{/if}
								{#if done}· {t.closed_by ? `done by ${t.closed_by}` : 'done'}{/if}
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<div class="toolbar">
	<h2 style="margin:0">Recent entries</h2>
	<span class="spacer"></span>
	<a class="button" href="/journal/new">+ New entry</a>
</div>

<div class="table-wrap">
	{#if data.entries.length === 0}
		<div class="empty">No journal entries yet.</div>
	{:else}
		<table>
			<thead>
				<tr><th>Date</th><th>#</th><th>Description</th><th class="num">Amount</th></tr>
			</thead>
			<tbody>
				{#each data.entries as e (e.id)}
					<tr>
						<td class="mono">{e.entry_date}</td>
						<td><a href="/journal/{e.id}">{e.id}</a></td>
						<td>{e.description}</td>
						<td class="num"><EntryTotals totals={e.totals} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-bottom: 1rem;
	}
	.big {
		font-size: 1.6rem;
	}
	h3 {
		margin: 1rem 0 0.4rem;
		font-weight: 600;
	}
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.bars li {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0 0.5rem;
		margin-bottom: 0.4rem;
	}
	.bars .label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar {
		grid-column: 1 / -1;
		height: 4px;
		border-radius: 2px;
		background: var(--accent);
		opacity: 0.6;
	}
	.two {
		margin-top: 1rem;
	}
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		padding: 0.55rem 0;
		border-top: 1px solid var(--border);
	}
	.item:first-child {
		border-top: none;
		padding-top: 0;
	}
	.item-main {
		flex: 1;
		min-width: 0;
	}
	.item .body {
		margin: 0.15rem 0;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.item input[type='checkbox'] {
		margin-top: 0.25rem;
		width: auto;
	}
	.level-warning {
		box-shadow: inset 3px 0 var(--warn);
		padding-left: 0.6rem;
	}
	.level-danger {
		box-shadow: inset 3px 0 var(--danger);
		padding-left: 0.6rem;
	}
	.level-success {
		box-shadow: inset 3px 0 var(--ok);
		padding-left: 0.6rem;
	}
	.done .item-main > div:first-child {
		text-decoration: line-through;
		color: var(--muted);
	}
	.overdue {
		color: var(--danger);
	}
	button.link {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		padding: 0 0.25rem;
		font-size: 1rem;
	}
	button.link:hover {
		color: var(--text);
	}
</style>
