<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import TagFields from '#lib/components/TagFields.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import { emptyTagForm, tagBody, tagLabel, tagKey } from '#lib/tags.ts';
	import EntryTotals from '#lib/components/EntryTotals.svelte';
	import { _HIDE_REVERSED_KEY, _PAGE_SIZE } from './+page';
	// The whole row opens the entry (the number stays a link for keyboards and new tabs).
	import { openRow } from '#lib/rows.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let from = $state('');
	let to = $state('');
	let accountCode = $state('');
	let tag = $state('');
	$effect.pre(() => {
		from = data.filter.from;
		to = data.filter.to;
		accountCode = data.filter.account_code;
		tag = data.filter.tag;
	});

	function href(offset: number, f: { from: string; to: string; account_code: string; hide_reversed: boolean; tag?: string } = { from, to, account_code: accountCode, hide_reversed: data.filter.hide_reversed, tag }) {
		const q = new URLSearchParams();
		if (f.from) q.set('from', f.from);
		if (f.to) q.set('to', f.to);
		if (f.account_code) q.set('account_code', f.account_code);
		if (f.tag) q.set('tag', f.tag);
		q.set('hide_reversed', f.hide_reversed ? '1' : '0');
		if (offset > 0) q.set('offset', String(offset));
		return `?${q}`;
	}

	function toggleReversed(e: Event) {
		const on = (e.currentTarget as HTMLInputElement).checked;
		try {
			localStorage.setItem(_HIDE_REVERSED_KEY, on ? '1' : '0');
		} catch {
			// storage blocked: the address still carries it
		}
		goto(href(0, { ...data.filter, hide_reversed: on }), { reset: false });
	}

	// Tagging many entries at once: tick them (or all on the page), then add or take off a tag.
	let canTag = $derived(page.data.user?.role !== 'viewer');
	let selected = $state<number[]>([]);
	let tagForm = $state(emptyTagForm());
	let busy = $state(false);
	let error: unknown = $state(null);
	let done = $state('');
	// A new page of entries starts with nothing ticked.
	$effect.pre(() => {
		void data.entries;
		selected = [];
	});
	let allOnPage = $derived(data.entries.length > 0 && data.entries.every((e) => selected.includes(e.id)));
	function toggle(id: number, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id);
		done = '';
	}
	function toggleAll(on: boolean) {
		selected = on ? data.entries.map((e) => e.id) : [];
		done = '';
	}
	async function batch(action: 'set' | 'remove') {
		error = null;
		done = '';
		const body = action === 'set' ? tagBody({ ...tagForm, id: '' }) : tagBody({ ...tagForm, id: '', entity: tagForm.entity || '0', description: '', quantity: '', rate: '1' });
		if (typeof body === 'string') {
			error = new Error(body);
			return;
		}
		delete body.id;
		if (action === 'remove') {
			delete body.description;
			delete body.quantity;
			delete body.rate_cents;
			delete body.unit;
			if (!tagForm.entity) delete body.entity_id;
		}
		busy = true;
		try {
			const r = unwrap(await api().POST('/journal-entries/tags', { body: { ...body, entry_ids: selected, action } }));
			const n = r.changed;
			done = `${action === 'set' ? 'Tagged' : 'Took the tag off'} ${n} entr${n === 1 ? 'y' : 'ies'}${n < r.entries ? ` (${r.entries - n} ${action === 'set' ? 'already had it' : "didn't have it"})` : ''}.`;
			await invalidateAll();
		} catch (e) {
			error = e;
		} finally {
			busy = false;
		}
	}

	function apply(e: SubmitEvent) {
		e.preventDefault();
		goto(href(0), { reset: false });
	}
</script>

<div class="toolbar">
	<h1 style="margin:0">Journal</h1>
	<span class="spacer"></span>
	<a class="button" href="/journal/new?type=expense">+ New expense</a>
	<a class="button" href="/journal/new">+ New entry</a>
</div>

<form class="toolbar" onsubmit={apply}>
	<label>From <input type="date" bind:value={from} /></label>
	<label>To <input type="date" bind:value={to} /></label>
	<label>
		Account
		<select bind:value={accountCode}>
			<option value="">All accounts</option>
			{#each data.accounts as a (a.code)}<option value={a.code}>{a.code} — {a.name} ({a.currency})</option>{/each}
		</select>
	</label>
	<label>
		Tag
		<select bind:value={tag} style="width:auto">
			<option value="">Any</option>
			{#each data.tags as t (t.tag)}<option value={t.tag}>{t.tag}{t.entries ? ` (${t.entries})` : ''}</option>{/each}
		</select>
	</label>
	<button>Filter</button>
	{#if data.filter.from || data.filter.to || data.filter.account_code || data.filter.tag}<a class="button" href={href(0, { from: '', to: '', account_code: '', hide_reversed: data.filter.hide_reversed })}>Clear</a>{/if}
	<span class="spacer"></span>
	<label class="inline"><input type="checkbox" checked={data.filter.hide_reversed} onchange={toggleReversed} /> Hide reversed</label>
</form>

{#if canTag && selected.length > 0}
	<form class="toolbar batch card" onsubmit={(ev) => (ev.preventDefault(), batch('set'))}>
		<strong>{selected.length} selected</strong>
		<TagFields bind:form={tagForm} entities={data.entities} />
		<button class="primary" disabled={busy}>Add tag</button>
		<button type="button" disabled={busy} onclick={() => batch('remove')} title="Take this tag off the selected entries">Take off</button>
		<span class="spacer"></span>
		<button type="button" class="link" onclick={() => toggleAll(false)}>Clear selection</button>
	</form>
{/if}
<ErrorNotice {error} />
{#if done}<div class="notice ok">{done}</div>{/if}

<div class="table-wrap">
	{#if data.entries.length === 0}
		<div class="empty">No journal entries match{data.filter.hide_reversed ? ' (reversed entries are hidden)' : ''}.</div>
	{:else}
		<table>
			<thead>
				<tr>{#if canTag}<th class="pick"><input type="checkbox" checked={allOnPage} indeterminate={selected.length > 0 && !allOnPage} onchange={(ev) => toggleAll(ev.currentTarget.checked)} aria-label="Select every entry on this page" /></th>{/if}<th>Date</th><th>#</th><th>Description</th><th>Reference</th><th>Accounts</th><th class="num">Amount</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.entries as e (e.id)}
					<tr class="clickable" class:selected={selected.includes(e.id)} onclick={(ev) => openRow(ev, `/journal/${e.id}`)}>
						{#if canTag}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (the checkbox inside is the control) -->
							<td class="pick" onclick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={selected.includes(e.id)} onchange={(ev) => toggle(e.id, ev.currentTarget.checked)} aria-label="Select entry {e.id}" /></td>
						{/if}
						<td class="mono">{e.entry_date}</td>
						<td><a class="quiet" href="/journal/{e.id}">{e.id}</a></td>
						<td>
							{e.description}
							{#if e.entity}<span class="muted small">· {e.entity.name}</span>{/if}
							{#each e.tags as t (tagKey(t))}
								<span class="badge tag {t.tag}" title={t.module_id ? `Set by ${t.module_id}` : 'Set by a person'}>{tagLabel(t)}</span>
							{/each}
							{#each e.links as l (l.module_id + ':' + l.ref)}
								{#if l.href}<a class="link-chip" href={l.href} title="Linked from {l.module_id}">{l.label}</a>{:else}<span class="link-chip" title="Linked from {l.module_id}">{l.label}</span>{/if}
							{/each}
						</td>
						<td>{e.reference}</td>
						<td class="small mono">{[...new Set(e.lines.map((l) => l.account_code))].join(', ')}</td>
						<td class="num"><EntryTotals totals={e.totals} /></td>
						<td>
							{#if e.reverses_id}<span class="badge">reversal of #{e.reverses_id}</span>{/if}
							{#if e.reversed_by_id}<span class="badge warn">reversed</span>{/if}
							{#if e.import_id}<span class="badge">imported</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<div class="toolbar" style="margin-top:1rem">
	{#if data.filter.offset > 0}
		<a class="button" href={href(Math.max(0, data.filter.offset - _PAGE_SIZE), data.filter)}>← Newer</a>
	{/if}
	<span class="spacer"></span>
	{#if data.entries.length === _PAGE_SIZE}
		<a class="button" href={href(data.filter.offset + _PAGE_SIZE, data.filter)}>Older →</a>
	{/if}
</div>

<style>
	.batch {
		position: sticky;
		top: 0;
		z-index: 3;
		align-items: center;
		margin-bottom: 0.75rem;
	}
	.pick {
		width: 2.2rem;
	}
	.pick input {
		margin: 0;
	}
	tr.selected {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
</style>
