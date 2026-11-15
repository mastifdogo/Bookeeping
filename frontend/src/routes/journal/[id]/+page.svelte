<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, today, unwrap } from '#lib/api/client.ts';
	import { centsToInput, parseAmount } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// Module names for links, from the sidebar's module entries.
	const moduleName = (id: string) => page.data.modules?.find((m: { id: string }) => m.id === id)?.label ?? id;
	let e = $derived(data.entry);

	let reversing = $state(false);
	let reverseDate = $state(today());
	let busy = $state(false);
	let error = $state<unknown>(null);

	let canEdit = $derived(page.data.user != null && page.data.user.role !== 'viewer');

	// Changing amounts: the same lines, new figures. Each change is logged below.
	let amending = $state(false);
	let draft = $state<Record<number, { debit: string; credit: string }>>({});
	let reason = $state('');
	function startAmend() {
		error = null;
		reversing = false;
		draft = Object.fromEntries(e.lines.map((l) => [l.line_number, { debit: l.debit_cents ? centsToInput(l.debit_cents) : '', credit: l.credit_cents ? centsToInput(l.credit_cents) : '' }]));
		reason = '';
		amending = true;
	}
	const cents = (s: string) => (s.trim() === '' ? 0 : parseAmount(s));
	// What each currency's debits and credits come to with the figures typed so far.
	let draftTotals = $derived(
		e.totals.map((t) => {
			let debit = 0;
			let credit = 0;
			let bad = false;
			for (const l of e.lines.filter((x) => x.currency === t.currency)) {
				const d = cents(draft[l.line_number]?.debit ?? '');
				const c = cents(draft[l.line_number]?.credit ?? '');
				if (d === null || c === null) bad = true;
				debit += d ?? 0;
				credit += c ?? 0;
			}
			return { currency: t.currency, debit, credit, bad };
		})
	);
	let changedLines = $derived(
		e.lines
			.map((l) => ({ line_number: l.line_number, debit_cents: cents(draft[l.line_number]?.debit ?? ''), credit_cents: cents(draft[l.line_number]?.credit ?? ''), was: l }))
			.filter((x) => x.debit_cents !== x.was.debit_cents || x.credit_cents !== x.was.credit_cents)
	);
	let canSave = $derived(
		amending && changedLines.length > 0 && draftTotals.every((t) => !t.bad && t.debit === t.credit) && changedLines.every((x) => x.debit_cents !== null && x.credit_cents !== null && (x.debit_cents > 0) !== (x.credit_cents > 0))
	);
	async function saveAmend(ev: SubmitEvent) {
		ev.preventDefault();
		busy = true;
		error = null;
		try {
			unwrap(
				await api().PATCH('/journal-entries/{entryId}/amounts', {
					params: { path: { entryId: e.id } },
					body: { lines: changedLines.map((x) => ({ line_number: x.line_number, debit_cents: x.debit_cents!, credit_cents: x.credit_cents! })), ...(reason.trim() ? { reason: reason.trim() } : {}) }
				})
			);
			amending = false;
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	async function reverse(ev: SubmitEvent) {
		ev.preventDefault();
		if (!confirm(`Post a reversing entry for #${e.id} dated ${reverseDate}?`)) return;
		busy = true;
		error = null;
		try {
			const rev = unwrap(
				await api().POST('/journal-entries/{entryId}/reverse', {
					params: { path: { entryId: e.id } },
					body: { entry_date: reverseDate }
				})
			);
			reversing = false;
			await goto(`/journal/${rev.id}`);
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
</script>

<p class="small"><a href="/journal">← Journal</a></p>

<div class="toolbar">
	<h1 style="margin:0">Entry #{e.id}</h1>
	{#if e.reverses_id}<span class="badge">reversal of <a href="/journal/{e.reverses_id}">#{e.reverses_id}</a></span>{/if}
	{#if e.reversed_by_id}<span class="badge warn">reversed by <a href="/journal/{e.reversed_by_id}">#{e.reversed_by_id}</a></span>{/if}
	{#if e.import_id}<span class="badge">imported (batch {e.import_id})</span>{/if}
	{#if e.amended}<span class="badge warn" title="Its amounts were changed after it was posted; see the changes below">amounts changed</span>{/if}
	<span class="spacer"></span>
	{#if !e.reverses_id && !e.reversed_by_id && canEdit}
		<button onclick={() => (amending ? (amending = false) : startAmend())}>{amending ? 'Cancel' : 'Change amounts…'}</button>
		<button class="danger" onclick={() => ((amending = false), (reversing = !reversing))}>Reverse…</button>
	{/if}
</div>

<ErrorNotice {error} />

{#if reversing}
	<form class="card toolbar" onsubmit={reverse}>
		<span>Posts a new entry that swaps every debit and credit of #{e.id}.</span>
		<label>Reversal date <input type="date" bind:value={reverseDate} required /></label>
		<button class="danger" disabled={busy}>Post reversal</button>
		<button type="button" onclick={() => (reversing = false)}>Cancel</button>
	</form>
{/if}

<div class="card">
	<div class="grid">
		<div><div class="muted small">Date</div><div class="mono">{e.entry_date}</div></div>
		<div><div class="muted small">Description</div><div>{e.description}</div></div>
		<div><div class="muted small">Reference</div><div>{e.reference || '—'}</div></div>
		{#if e.entity}<div><div class="muted small">Customer / vendor</div><div><a href="/journal?entity_id={e.entity.id}">{e.entity.name}</a></div></div>{/if}
		<div>
			<div class="muted small">Posted</div>
			<div class="small">{new Date(e.posted_at).toLocaleString()}{#if e.created_by} by <strong>{e.created_by}</strong>{/if}</div>
		</div>
	</div>
</div>

{#if e.links.length > 0}
	<div class="card links">
		<div class="muted small">Linked records</div>
		<ul>
			{#each e.links as l (l.module_id + ':' + l.ref)}
				<li>
					{#if l.href}<a href={l.href}>{l.label}</a>{:else}{l.label}{/if}
					<span class="muted small">from {moduleName(l.module_id)}</span>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<form onsubmit={saveAmend}>
{#if amending}
	<div class="card amend">
		<p style="margin:0">
			Type the new amounts below. Debits and credits must still be equal. The old and new figures, who changed them and when are kept with
			this entry. {#if e.links.length > 0}<strong>A module posted this entry; its own record does not change.</strong>{/if}
		</p>
		<div class="toolbar" style="margin:0.6rem 0 0; align-items:flex-end">
			<label style="flex:1; min-width:14rem">Why (optional) <input bind:value={reason} maxlength="500" placeholder="e.g. receipt total was 45.00" /></label>
			{#each draftTotals as t (t.currency)}
				<span class="small" class:off={t.bad || t.debit !== t.credit}>
					{t.currency}: {#if t.bad}an amount isn't a number{:else if t.debit === t.credit}balanced{:else}out by <Amount cents={Math.abs(t.debit - t.credit)} />{/if}
				</span>
			{/each}
			<button class="primary" disabled={busy || !canSave}>Save amounts</button>
		</div>
	</div>
{/if}
<div class="table-wrap">
	<table>
		<thead>
			<tr><th>#</th><th>Account</th><th>Memo</th><th>Currency</th><th class="num">Debit</th><th class="num">Credit</th></tr>
		</thead>
		<tbody>
			{#each e.lines as l (l.id)}
				<tr>
					<td class="muted">{l.line_number}</td>
					<td><a class="mono" href="/accounts/{encodeURIComponent(l.account_code)}">{l.account_code}</a> {l.account_name}</td>
					<td>{l.memo}</td>
					<td>{l.currency}</td>
					{#if amending && draft[l.line_number]}
						<td class="num"><input class="amt" inputmode="decimal" aria-label="Debit, line {l.line_number}" bind:value={draft[l.line_number]!.debit} oninput={() => draft[l.line_number]!.debit.trim() && (draft[l.line_number]!.credit = '')} /></td>
						<td class="num"><input class="amt" inputmode="decimal" aria-label="Credit, line {l.line_number}" bind:value={draft[l.line_number]!.credit} oninput={() => draft[l.line_number]!.credit.trim() && (draft[l.line_number]!.debit = '')} /></td>
					{:else}
						<td class="num"><Amount cents={l.debit_cents} blankZero /></td>
						<td class="num"><Amount cents={l.credit_cents} blankZero /></td>
					{/if}
				</tr>
			{/each}
		</tbody>
		<tfoot>
			{#each e.totals as t (t.currency)}
				<tr>
					<td colspan="3">Total</td>
					<td>{t.currency}</td>
					<td class="num"><Amount cents={t.amount_cents} /></td>
					<td class="num"><Amount cents={t.amount_cents} /></td>
				</tr>
			{/each}
		</tfoot>
	</table>
</div>
</form>

{#if e.changes && e.changes.length > 0}
	<h2>Changes to amounts</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr><th>When</th><th>By</th><th>Line</th><th>Account</th><th class="num">Was</th><th class="num">Now</th><th>Why</th></tr>
			</thead>
			<tbody>
				{#each e.changes as c (c.id)}
					<tr>
						<td class="small">{new Date(c.changed_at).toLocaleString()}</td>
						<td>{c.changed_by ?? '—'}</td>
						<td class="muted">{c.line_number}</td>
						<td><span class="mono">{c.account_code}</span> {c.account_name}</td>
						<td class="num"><Amount cents={c.old_debit_cents || c.old_credit_cents} /> {c.old_debit_cents ? 'Dr' : 'Cr'}</td>
						<td class="num"><Amount cents={c.new_debit_cents || c.new_credit_cents} /> {c.new_debit_cents ? 'Dr' : 'Cr'}</td>
						<td>{c.reason}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	input.amt {
		width: 8rem;
		text-align: right;
	}
	.amend .off {
		color: var(--danger);
	}
	.links ul {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
	}
	.links li {
		padding: 0.15rem 0;
	}
</style>
