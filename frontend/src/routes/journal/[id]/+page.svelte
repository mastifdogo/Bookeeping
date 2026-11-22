<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, today, unwrap } from '#lib/api/client.ts';
	import { centsToInput, formatCents, parseAmount } from '#lib/money.ts';
	import TagFields from '#lib/components/TagFields.svelte';
	import EntryTotals from '#lib/components/EntryTotals.svelte';
	import { openRow } from '#lib/rows.ts';
	import { emptyTagForm, tagBody, tagLabel, tagKey } from '#lib/tags.ts';
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

	// Edit: every field of the entry opens at once: its date, description, reference and customer or vendor,
	// and each line's account, memo and amount. What changes is saved together and logged below.
	let editing = $state(false);
	let head = $state({ date: '', description: '', reference: '', entity: '' });
	let draft = $state<Record<number, { account: string; memo: string; debit: string; credit: string }>>({});
	let reason = $state('');
	// A reversed entry and its reversal mirror each other: their amounts and accounts stay.
	let paired = $derived(e.reverses_id != null || e.reversed_by_id != null);
	function startEdit() {
		error = null;
		reversing = false;
		moving = rootLine = null;
		head = { date: e.entry_date, description: e.description, reference: e.reference, entity: e.entity ? String(e.entity.id) : '' };
		draft = Object.fromEntries(
			e.lines.map((l) => [l.line_number, { account: l.account_code, memo: l.memo, debit: l.debit_cents ? centsToInput(l.debit_cents) : '', credit: l.credit_cents ? centsToInput(l.credit_cents) : '' }])
		);
		reason = '';
		editing = true;
	}
	const cents = (s: string) => (s.trim() === '' ? 0 : parseAmount(s));
	// The accounts a line can go to: active ones in its currency (and the one it is in).
	const accountsFor = (l: (typeof e.lines)[number]) =>
		data.accounts.filter((a) => a.code === l.account_code || (a.currency === l.currency && a.is_active && !(a.module_id === 'ledger' && a.module_key === 'unreconciled')));
	// The customers and vendors to choose from: active ones (and the one it has).
	let entityChoices = $derived(data.entities.filter((x) => x.is_active || x.id === e.entity?.id));
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
	// A customer's invoices are posted to accounts receivable and a vendor's bills and receipts to accounts
	// payable: with one chosen and no line in that account, the form says so and names the account.
	let steer = $derived.by(() => {
		const who = editing && !paired ? data.entities.find((x) => String(x.id) === head.entity) : undefined;
		if (!who) return null;
		const kinds: string[] = [...(who.is_customer ? ['receivable'] : []), ...(who.is_vendor ? ['payable'] : [])];
		// A customer's or vendor's own account counts as receivables or payables.
		const kindOf = (code: string) => {
			const a = data.accounts.find((x) => x.code === code);
			return a?.entity ? (a.entity.role === 'customer' ? 'receivable' : 'payable') : (a?.kind ?? '');
		};
		if (e.lines.some((l) => kinds.includes(kindOf(draft[l.line_number]?.account ?? l.account_code)))) return null;
		const targets = data.accounts.filter((a) => a.is_active && kinds.includes(a.kind ?? '') && e.lines.some((l) => l.currency === a.currency));
		return targets.length > 0 ? { who, targets } : null;
	});
	// Only what was changed is sent.
	let changedHead = $derived({
		...(head.date !== e.entry_date ? { entry_date: head.date } : {}),
		...(head.description.trim() !== e.description ? { description: head.description.trim() } : {}),
		...(head.reference.trim() !== e.reference ? { reference: head.reference.trim() } : {}),
		...(head.entity !== (e.entity ? String(e.entity.id) : '') ? { entity_id: head.entity ? Number(head.entity) : null } : {})
	});
	let changedLines = $derived(
		e.lines.flatMap((l) => {
			const d = draft[l.line_number];
			if (!d) return [];
			const debit = cents(d.debit);
			const credit = cents(d.credit);
			const amount = debit !== l.debit_cents || credit !== l.credit_cents;
			const line = {
				line_number: l.line_number,
				...(d.account !== l.account_code ? { account_code: d.account } : {}),
				...(d.memo.trim() !== l.memo ? { memo: d.memo.trim() } : {}),
				...(amount ? { debit_cents: debit ?? 0, credit_cents: credit ?? 0 } : {})
			};
			// An amount that isn't a number, or a line with both or neither side, can't be saved.
			const bad = amount && (debit === null || credit === null || debit > 0 === credit > 0);
			return Object.keys(line).length > 1 ? [{ line, bad }] : [];
		})
	);
	let canSave = $derived(
		editing &&
			(Object.keys(changedHead).length > 0 || changedLines.length > 0) &&
			head.date !== '' &&
			head.description.trim() !== '' &&
			draftTotals.every((t) => !t.bad && t.debit === t.credit) &&
			changedLines.every((x) => !x.bad)
	);
	async function saveEdit(ev: SubmitEvent) {
		ev.preventDefault();
		if (!canSave) return;
		busy = true;
		error = null;
		try {
			unwrap(
				await api().PATCH('/journal-entries/{entryId}', {
					params: { path: { entryId: e.id } },
					body: {
						...changedHead,
						...(changedLines.length > 0 ? { lines: changedLines.map((x) => x.line) } : {}),
						...(reason.trim() ? { reason: reason.trim() } : {})
					}
				})
			);
			editing = false;
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// A line in the Unreconciled clearing account moves on to where it belongs.
	let moving = $state<number | null>(null);
	let moveTo = $state('');
	let moveReason = $state('');
	let movingLine = $derived(e.lines.find((l) => l.line_number === moving));
	let moveTargets = $derived(movingLine ? data.accounts.filter((a) => a.currency === movingLine.currency && a.code !== movingLine.account_code && a.is_active && !(a.module_id === 'ledger' && a.module_key === 'unreconciled')) : []);
	async function saveMove(ev: SubmitEvent) {
		ev.preventDefault();
		if (moving === null || !moveTo) return;
		busy = true;
		error = null;
		try {
			unwrap(
				await api().PATCH('/journal-entries/{entryId}/lines/{lineNumber}/account', {
					params: { path: { entryId: e.id, lineNumber: moving } },
					body: { account_code: moveTo, ...(moveReason.trim() ? { reason: moveReason.trim() } : {}) }
				})
			);
			moving = null;
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// Root mode: delete the entry or a line, or change a line's account or amount. The entry may be left
	// unbalanced; leaving root mode checks the books. Everything is logged under Settings → Root log.
	let root = $derived(page.data.user?.root === true);
	let rootLine = $state<number | null>(null);
	let rootAccount = $state('');
	let rootDebit = $state('');
	let rootCredit = $state('');
	function startRootLine(l: (typeof e.lines)[number]) {
		error = null;
		editing = reversing = false;
		moving = null;
		rootLine = l.line_number;
		rootAccount = l.account_code;
		rootDebit = l.debit_cents ? centsToInput(l.debit_cents) : '';
		rootCredit = l.credit_cents ? centsToInput(l.credit_cents) : '';
	}
	async function rootAct(fn: () => Promise<unknown>, after?: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await fn();
			rootLine = null;
			await (after ? after() : invalidateAll());
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
	const rootSaveLine = (ev: SubmitEvent) => {
		ev.preventDefault();
		const l = e.lines.find((x) => x.line_number === rootLine);
		const d = cents(rootDebit);
		const c = cents(rootCredit);
		if (!l || d === null || c === null || d > 0 === c > 0) {
			error = new Error('Give a debit or a credit, not both and not neither.');
			return;
		}
		const body = { ...(rootAccount !== l.account_code ? { account_code: rootAccount } : {}), ...(d !== l.debit_cents || c !== l.credit_cents ? { debit_cents: d, credit_cents: c } : {}) };
		return rootAct(async () => unwrap(await api().PATCH('/journal-entries/{entryId}/lines/{lineNumber}/root', { params: { path: { entryId: e.id, lineNumber: l.line_number } }, body })));
	};
	const rootDeleteLine = (n: number) =>
		confirm(`ROOT: delete line ${n} of entry #${e.id}?\n\nThe entry may no longer balance; root mode can only be left once the books are intact. It can be reversed under Settings → Root log.`) &&
		rootAct(async () => unwrap(await api().DELETE('/journal-entries/{entryId}/lines/{lineNumber}/root', { params: { path: { entryId: e.id, lineNumber: n } } })));
	const rootDeleteEntry = () =>
		confirm(`ROOT: delete entry #${e.id} whole${e.reverses_id || e.reversed_by_id ? ', together with its reversal' : ''}?\n\nIt can be reversed under Settings → Root log.`) &&
		rootAct(
			async () => unwrap(await api().DELETE('/journal-entries/{entryId}/root', { params: { path: { entryId: e.id } } })),
			() => goto('/journal')
		);
	// What the entry is out by, per currency, and too few lines (only possible in root mode).
	let broken = $derived.by(() => {
		const sums = new Map<string, number>();
		for (const l of e.lines) sums.set(l.currency, (sums.get(l.currency) ?? 0) + l.debit_cents - l.credit_cents);
		const out = [...sums].filter(([, v]) => v !== 0).map(([c, v]) => `out by ${formatCents(Math.abs(v))} ${c}`);
		if (e.lines.length < 2) out.unshift(e.lines.length === 0 ? 'no lines' : 'only one line');
		return out;
	});

	// Tags: shared by Ledger and every module (paid, billed, overdue, customer, vendor, rate, or another word).
	let tagForm = $state(emptyTagForm());
	async function tagAct(fn: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await fn();
			tagForm = { ...emptyTagForm(), tag: tagForm.tag };
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
	const addTag = (ev: SubmitEvent) => {
		ev.preventDefault();
		const body = tagBody(tagForm);
		if (typeof body === 'string') {
			error = new Error(body);
			return;
		}
		return tagAct(async () => unwrap(await api().POST('/journal-entries/{entryId}/tags', { params: { path: { entryId: e.id } }, body })));
	};
	// "Change" on a rate item puts its values back in the form; saving changes that item.
	function editRate(t: (typeof e.tags)[number]) {
		tagForm = {
			...emptyTagForm(),
			tag: 'rate',
			id: String(t.id),
			description: t.description ?? '',
			quantity: t.quantity != null ? String(t.quantity) : '',
			unit: t.unit ?? '',
			rate: t.rate_cents != null ? centsToInput(t.rate_cents) : ''
		};
	}
	const dropTag = (t: (typeof e.tags)[number]) =>
		tagAct(async () =>
			unwrap(await api().DELETE('/journal-entries/{entryId}/tags/{tag}', { params: { path: { entryId: e.id, tag: t.tag }, query: { entity_id: t.entity?.id, id: t.tag === 'rate' ? t.id : undefined } } }))
		);

	// Linked entries: every entry linked to this one (the payment of an invoice, a transfer's other half).
	let related = $derived(e.related ?? []);
	let linkTo = $state('');
	let linkNote = $state('');
	const whyText = (w: (typeof related)[number]['why'][number]) =>
		w.kind === 'linked'
			? `Linked${w.note ? `: ${w.note}` : ''}${w.module_id ? ` (by ${moduleName(w.module_id)})` : w.set_by ? ` (by ${w.set_by})` : ''}`
			: w.kind === 'chain'
				? `Through #${w.through}`
				: w.kind === 'record'
					? `${w.label} (${moduleName(w.module_id ?? '')})`
					: w.kind === 'reverses'
						? 'Reversed by this entry'
						: 'Reverses this entry';
	async function linkAct(fn: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await fn();
			linkTo = '';
			linkNote = '';
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}
	const addLink = (ev: SubmitEvent) => {
		ev.preventDefault();
		const other = Number(linkTo.trim().replace(/^#/, ''));
		if (!Number.isSafeInteger(other) || other < 1) {
			error = new Error('Type the number of the entry to link, e.g. 412.');
			return;
		}
		return linkAct(async () => unwrap(await api().POST('/journal-entries/{entryId}/related', { params: { path: { entryId: e.id } }, body: { entry_id: other, note: linkNote.trim() } })));
	};
	const dropLink = (other: number) => linkAct(async () => unwrap(await api().DELETE('/journal-entries/{entryId}/related/{otherId}', { params: { path: { entryId: e.id, otherId: other } } })));

	// One log of what changed after posting: every field edited, and lines moved to another account.
	type LogRow = { key: string; at: string; by: string | null; what: string; was: string; now: string; why: string };
	const money = (c: number) => formatCents(c);
	let log = $derived(
		[
			...(e.changes ?? []).map(
				(c): LogRow => ({
					key: `a${c.id}`,
					at: String(c.changed_at),
					by: c.changed_by,
					what: `Amount, line ${c.line_number} (${c.account_code} ${c.account_name})`,
					was: `${money(c.old_debit_cents || c.old_credit_cents)} ${c.old_debit_cents ? 'Dr' : 'Cr'}`,
					now: `${money(c.new_debit_cents || c.new_credit_cents)} ${c.new_debit_cents ? 'Dr' : 'Cr'}`,
					why: c.reason
				})
			),
			...(e.date_changes ?? []).map((c): LogRow => ({ key: `d${c.id}`, at: String(c.changed_at), by: c.changed_by, what: 'Date', was: c.old_date, now: c.new_date, why: c.reason })),
			...(e.edits ?? []).map(
				(c): LogRow => ({
					key: `e${c.id}`,
					at: String(c.changed_at),
					by: c.changed_by,
					what: c.field === 'memo' ? `Memo, line ${c.line_number}` : c.field === 'entity' ? 'Customer / vendor' : c.field === 'reference' ? 'Reference' : 'Description',
					was: c.old_value || '—',
					now: c.new_value || '—',
					why: c.reason
				})
			),
			...(e.moves ?? []).map(
				(m): LogRow => ({
					key: `m${m.id}`,
					at: String(m.changed_at),
					by: m.changed_by,
					what: `Account, line ${m.line_number}`,
					was: `${m.from_code} ${m.from_name}`,
					now: `${m.to_code} ${m.to_name}`,
					why: m.reason || (m.reconciliation_id ? 'reconciliation' : '')
				})
			)
		].sort((a, b) => a.at.localeCompare(b.at))
	);

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
	{#if e.date_changes?.length}<span class="badge warn" title="Its date was changed after it was posted; see the changes below">date changed</span>{/if}
	{#if e.edits?.length}<span class="badge warn" title="Its description, reference, customer or vendor or a memo was changed after it was posted; see the changes below">edited</span>{/if}
	{#if e.lines.some((l) => l.unreconciled)}<span class="badge danger">unreconciled</span>{/if}
	{#if broken.length > 0}<span class="badge danger" title="Root mode can only be left once every entry balances and has at least two lines">not intact: {broken.join(', ')}</span>{/if}
	<span class="spacer"></span>
	{#if canEdit}<button onclick={() => (editing ? (editing = false) : startEdit())}>{editing ? 'Cancel' : 'Edit…'}</button>{/if}
	{#if !paired && canEdit}
		<button class="danger" onclick={() => ((editing = false), (reversing = !reversing))}>Reverse…</button>
	{/if}
	{#if root}<button class="danger" disabled={busy} onclick={rootDeleteEntry} title="Root: delete this entry whole">Delete entry…</button>{/if}
</div>

<ErrorNotice {error} />

{#if editing}
	<form id="entry-edit" class="card amend" onsubmit={saveEdit}>
		<p style="margin:0">
			Change anything below: the date, description, reference, customer or vendor, and each line's account, memo and amount. Debits and
			credits must still be equal. What it was and what it is now, who changed it and when are kept under <strong>Changes</strong>.
			{#if paired}<strong>This entry {e.reverses_id ? 'is a reversal' : 'was reversed'}: its amounts and accounts stay as they are.</strong>{/if}
			{#if e.links.length > 0}<strong>A module posted this entry; its own record does not change.</strong>{/if}
		</p>
		{#if steer}
			<p class="steer" style="margin:0.5rem 0 0">
				<strong>{steer.who.name}</strong> is a {steer.who.is_customer && steer.who.is_vendor ? 'customer and vendor' : steer.who.is_customer ? 'customer' : 'vendor'}:
				{steer.who.is_customer && steer.who.is_vendor ? 'invoices are posted to accounts receivable, bills and receipts to accounts payable' : steer.who.is_customer ? 'invoices are posted to accounts receivable' : 'bills and receipts are posted to accounts payable'}
				({steer.targets.map((a) => `${a.code} ${a.name}`).join(', ')}). None of this entry's lines is there; if it is one of those, or its
				payment, choose that account on a line below and it goes to {steer.who.name}'s own account.
			</p>
		{/if}
		<div class="toolbar" style="margin:0.6rem 0 0; align-items:flex-end">
			<label style="flex:1; min-width:14rem">Why (optional) <input bind:value={reason} maxlength="500" placeholder="e.g. receipt total was 45.00" /></label>
			{#each draftTotals as t (t.currency)}
				<span class="small" class:off={t.bad || t.debit !== t.credit}>
					{t.currency}: {#if t.bad}an amount isn't a number{:else if t.debit === t.credit}balanced{:else}out by <Amount cents={Math.abs(t.debit - t.credit)} />{/if}
				</span>
			{/each}
			<button class="primary" disabled={busy || !canSave}>Save changes</button>
			<button type="button" onclick={() => (editing = false)}>Cancel</button>
		</div>
	</form>
{/if}

{#if moving !== null && movingLine}
	<form class="card toolbar" onsubmit={saveMove}>
		<span>Move line {movingLine.line_number} out of <strong>{movingLine.account_name}</strong> to</span>
		<select bind:value={moveTo} required aria-label="Account to move the line to">
			<option value="" disabled>Choose the account…</option>
			{#each moveTargets as a (a.code)}<option value={a.code}>{a.code} — {a.name}{a.hidden ? ' (hidden)' : ''}</option>{/each}
		</select>
		<label style="flex:1; min-width:12rem">Why (optional) <input bind:value={moveReason} maxlength="500" placeholder="e.g. cleared on the October statement" /></label>
		<button class="primary" disabled={busy || !moveTo}>Move</button>
		<button type="button" onclick={() => (moving = null)}>Cancel</button>
	</form>
{/if}

{#if root && rootLine !== null}
	<form class="card toolbar root-tools" onsubmit={rootSaveLine}>
		<strong>Root: line {rootLine}</strong>
		<label>
			Account
			<select bind:value={rootAccount} aria-label="Account for the line">
				{#each data.accounts as a (a.code)}<option value={a.code}>{a.code} — {a.name} ({a.currency})</option>{/each}
			</select>
		</label>
		<label>Debit <input class="amt" inputmode="decimal" bind:value={rootDebit} oninput={() => rootDebit.trim() && (rootCredit = '')} /></label>
		<label>Credit <input class="amt" inputmode="decimal" bind:value={rootCredit} oninput={() => rootCredit.trim() && (rootDebit = '')} /></label>
		<button class="primary" disabled={busy}>Save line</button>
		<button type="button" onclick={() => (rootLine = null)}>Cancel</button>
		<span class="muted small" style="flex-basis:100%">The entry doesn't have to balance while you work; root mode can only be left once the books are intact.</span>
	</form>
{/if}

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
		{#if editing}
			<label><span class="muted small">Date</span> <input form="entry-edit" type="date" bind:value={head.date} required /></label>
			<label><span class="muted small">Description</span> <input form="entry-edit" bind:value={head.description} maxlength="500" required /></label>
			<label><span class="muted small">Reference</span> <input form="entry-edit" bind:value={head.reference} maxlength="100" /></label>
			<label>
				<span class="muted small">Customer / vendor</span>
				<select form="entry-edit" bind:value={head.entity}>
					<option value="">— none —</option>
					{#each entityChoices as x (x.id)}<option value={String(x.id)}>{x.name}</option>{/each}
				</select>
			</label>
		{:else}
			<div><div class="muted small">Date</div><div class="mono">{e.entry_date}</div></div>
			<div><div class="muted small">Description</div><div>{e.description}</div></div>
			<div><div class="muted small">Reference</div><div>{e.reference || '—'}</div></div>
			{#if e.entity}<div><div class="muted small">Customer / vendor</div><div><a href="/journal?entity_id={e.entity.id}">{e.entity.name}</a></div></div>{/if}
		{/if}
		<div>
			<div class="muted small">Posted</div>
			<div class="small">{new Date(e.posted_at).toLocaleString()}{#if e.created_by} by <strong>{e.created_by}</strong>{/if}</div>
		</div>
	</div>
</div>

<div class="card tags">
	<div class="muted small">Tags <span title="Tags are shared with every module: a tag set here, or by a module, is seen by all of them.">(shared with modules)</span></div>
	<div class="taglist">
		{#each e.tags as t (tagKey(t))}
			<span class="badge tag {t.tag}" title={t.account_code && t.id === 0 ? `Read from the entry's line in ${t.account_code}, this ${t.tag}'s own account. Taking it off moves the line back to accounts ${t.tag === 'customer' ? 'receivable' : 'payable'}.` : `${t.module_id ? `Set by ${moduleName(t.module_id)}` : `Set by ${t.set_by ?? 'a person'}`}, ${new Date(t.set_at).toLocaleString()}${t.note ? `: ${t.note}` : ''}`}>
				{tagLabel(t)}{#if canEdit && t.tag === 'rate'}<button type="button" class="x" disabled={busy} aria-label="Change this item" title="Change" onclick={() => editRate(t)}>✎</button>{/if}{#if canEdit}<button type="button" class="x" disabled={busy} aria-label="Take off the tag {t.tag}" onclick={() => dropTag(t)}>×</button>{/if}
			</span>
		{:else}
			<span class="muted small">None.</span>
		{/each}
	</div>
	{#if canEdit}
		<form class="toolbar" style="margin:0.5rem 0 0" onsubmit={addTag}>
			<TagFields bind:form={tagForm} entities={data.entities} />
			<button disabled={busy}>{tagForm.tag === 'rate' ? (tagForm.id ? 'Change item' : 'Add item') : 'Add tag'}</button>
			{#if tagForm.id}<button type="button" disabled={busy} onclick={() => (tagForm = { ...emptyTagForm(), tag: 'rate' })}>Cancel</button>{/if}
		</form>
	{/if}
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

{#if related.length > 0 || canEdit}
	<div class="card related">
		<div class="muted small">Linked entries <span title="Entries linked to this one here or by a module, entries of the same module record, and reversals.">({related.length})</span></div>
		{#if related.length > 0}
			<div class="table-wrap" style="margin-top:0.35rem">
				<table>
					<thead>
						<tr><th>Date</th><th>#</th><th>Description</th><th>Why</th><th class="num">Amount</th><th></th></tr>
					</thead>
					<tbody>
						{#each related as r (r.id)}
							<tr class="clickable" onclick={(ev) => openRow(ev, `/journal/${r.id}`)}>
								<td class="mono">{r.entry_date}</td>
								<td><a class="quiet" href="/journal/{r.id}">{r.id}</a></td>
								<td>
									{r.description}{#if r.reference}<span class="muted small"> · {r.reference}</span>{/if}
									{#each r.tags as t (tagKey(t))}<span class="badge tag {t.tag}">{tagLabel(t)}</span>{/each}
									{#if r.reversed}<span class="badge warn">reversed</span>{/if}
								</td>
								<td class="small">
									{#each r.why as w, i (i)}
										<div>{#if w.kind === 'record' && w.href}<a href={w.href}>{w.label}</a> <span class="muted">({moduleName(w.module_id ?? '')})</span>{:else}{whyText(w)}{/if}</div>
									{/each}
								</td>
								<td class="num"><EntryTotals totals={r.totals} /></td>
								<td>{#if canEdit && r.direct}<button type="button" class="link small" disabled={busy} title="Take off the link to entry {r.id}" aria-label="Take off the link to entry {r.id}" onclick={() => dropLink(r.id)}>Unlink</button>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if canEdit}
			<form class="toolbar" style="margin:0.5rem 0 0" onsubmit={addLink}>
				<label>Entry # <input bind:value={linkTo} inputmode="numeric" size="8" placeholder="412" required /></label>
				<label style="flex:1">Note <input bind:value={linkNote} maxlength="200" placeholder="e.g. payment of this invoice" /></label>
				<button disabled={busy}>Link entry</button>
			</form>
		{/if}
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
					<td>
						{#if editing && draft[l.line_number] && !paired}
							<select form="entry-edit" class="acct" aria-label="Account, line {l.line_number}" bind:value={draft[l.line_number]!.account}>
								{#each accountsFor(l) as a (a.code)}<option value={a.code}>{a.code} — {a.name}{a.hidden ? ' (hidden)' : ''}</option>{/each}
							</select>
						{:else}
							<a class="mono" href="/accounts/{encodeURIComponent(l.account_code)}">{l.account_code}</a>
							{l.account_name}
						{/if}
						{#if l.unreconciled && canEdit && !editing}
							<button type="button" class="link small" onclick={() => ((moving = l.line_number), (moveTo = ''), (moveReason = ''))}>Move…</button>
						{/if}
						{#if root && !editing}
							<button type="button" class="link small rootlink" disabled={busy} onclick={() => startRootLine(l)}>Change…</button>
							<button type="button" class="link small rootlink" disabled={busy} onclick={() => rootDeleteLine(l.line_number)}>Delete line</button>
						{/if}
					</td>
					<td>{#if editing && draft[l.line_number]}<input form="entry-edit" class="memo" maxlength="500" aria-label="Memo, line {l.line_number}" bind:value={draft[l.line_number]!.memo} />{:else}{l.memo}{/if}</td>
					<td>{l.currency}</td>
					{#if editing && draft[l.line_number] && !paired}
						<td class="num"><input form="entry-edit" class="amt" inputmode="decimal" aria-label="Debit, line {l.line_number}" bind:value={draft[l.line_number]!.debit} oninput={() => draft[l.line_number]!.debit.trim() && (draft[l.line_number]!.credit = '')} /></td>
						<td class="num"><input form="entry-edit" class="amt" inputmode="decimal" aria-label="Credit, line {l.line_number}" bind:value={draft[l.line_number]!.credit} oninput={() => draft[l.line_number]!.credit.trim() && (draft[l.line_number]!.debit = '')} /></td>
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

{#if log.length > 0}
	<h2>Changes</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr><th>When</th><th>By</th><th>What</th><th>Was</th><th>Now</th><th>Why</th></tr>
			</thead>
			<tbody>
				{#each log as c (c.key)}
					<tr>
						<td class="small">{new Date(c.at).toLocaleString()}</td>
						<td>{c.by ?? '—'}</td>
						<td>{c.what}</td>
						<td class="mono small">{c.was}</td>
						<td class="mono small">{c.now}</td>
						<td>{c.why}</td>
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
	input.memo {
		width: 100%;
		min-width: 8rem;
	}
	select.acct {
		max-width: 18rem;
	}
	.grid label input,
	.grid label select {
		display: block;
		width: 100%;
	}
	.amend .off {
		color: var(--danger);
	}
	.amend .steer {
		color: var(--warn, #92400e);
	}
	.root-tools {
		border-color: var(--danger);
	}
	button.rootlink {
		color: var(--danger);
	}
	button.link {
		background: none;
		border: none;
		padding: 0 0 0 0.4rem;
		color: var(--accent);
		cursor: pointer;
	}
	.taglist {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-top: 0.3rem;
	}
	.taglist .badge.tag {
		margin-left: 0;
	}
	.x {
		background: none;
		border: none;
		padding: 0 0 0 0.3rem;
		color: inherit;
		cursor: pointer;
		font-size: 1em;
		line-height: 1;
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
