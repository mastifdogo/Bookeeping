<script lang="ts">
	import { goto } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import StatementPicker from '#lib/components/StatementPicker.svelte';
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
	// --- The statement beside the lines -------------------------------------
	let pickId = $state<number | null>(null);
	let showDoc = $state(true);
	let reading = $state(false);
	const attach = (id: number | null) =>
		run(async () => unwrap(await api().PATCH('/reconciliations/{reconciliationId}', { ...path(), body: { document_id: id } })));
	function readStatement() {
		reading = true;
		run(async () => unwrap(await api().POST('/reconciliations/{reconciliationId}/pre-reconcile', path()))).finally(() => (reading = false));
	}
	let ai = $derived(d.reading);
	// Which statement line the AI paired with each journal line.
	let aiMatch = $derived(new Map((ai?.matched ?? []).map(([t, i]) => [t, ai!.lines[i]])));
	let notInBooks = $derived((ai?.unmatched ?? []).map((i) => ai!.lines[i]!).filter(Boolean));
	// The statement's own closing date and balance, when they aren't the ones this reconciliation uses.
	let differs = $derived(
		open && ai && ai.end_date !== null && ai.closing_balance_cents !== null && (ai.end_date !== rec.statement_date || ai.closing_balance_cents !== rec.statement_balance_cents)
			? { date: ai.end_date, cents: ai.closing_balance_cents }
			: null
	);
	const useStatementFigures = () =>
		run(async () =>
			unwrap(await api().PATCH('/reconciliations/{reconciliationId}', { ...path(), body: { statement_date: differs!.date, statement_balance_cents: differs!.cents } }))
		);

	// The divider between the statement and the lines: drag it, or use the arrow keys.
	const SPLIT_KEY = 'ledger:reconcile-split';
	let left = $state(45);
	let dragging = $state(false);
	let splitEl: HTMLDivElement | undefined = $state();
	$effect(() => {
		const saved = Number(localStorage.getItem(SPLIT_KEY));
		if (saved >= 15 && saved <= 80) left = saved;
	});
	const setLeft = (pct: number) => {
		left = Math.min(80, Math.max(15, Math.round(pct * 10) / 10));
		localStorage.setItem(SPLIT_KEY, String(left));
	};
	function dragStart(e: PointerEvent) {
		dragging = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function dragMove(e: PointerEvent) {
		if (!dragging || !splitEl) return;
		const box = splitEl.getBoundingClientRect();
		setLeft(((e.clientX - box.left) / box.width) * 100);
	}
	function dragKey(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') setLeft(left - 2);
		else if (e.key === 'ArrowRight') setLeft(left + 2);
		else return;
		e.preventDefault();
	}
	let split = $derived(rec.document_url !== null && showDoc);

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

<div class="split" class:on={split} class:dragging bind:this={splitEl} style="--left:{left}%">
	{#if split}
		<section class="doc" aria-label="Statement">
			<div class="docbar">
				<strong class="ellipsis">{rec.document_title}</strong>
				<span class="spacer"></span>
				<a href={rec.document_url} target="_blank" rel="noopener">Open in a new tab</a>
				{#if open}<button class="link" disabled={busy} onclick={() => attach(null)}>Take off</button>{/if}
				<button class="link" onclick={() => (showDoc = false)}>Hide</button>
			</div>
			{#if rec.document_type === 'application/pdf'}
				<iframe src="{rec.document_url}#view=FitH" title="Statement: {rec.document_title}"></iframe>
			{:else}
				<div class="picture"><img src={rec.document_url} alt="Statement: {rec.document_title}" /></div>
			{/if}
		</section>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="divider"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the statement"
			aria-valuenow={Math.round(left)}
			aria-valuemin="15"
			aria-valuemax="80"
			tabindex="0"
			title="Drag to resize"
			onpointerdown={dragStart}
			onpointermove={dragMove}
			onpointerup={() => (dragging = false)}
			onpointercancel={() => (dragging = false)}
			onkeydown={dragKey}
		></div>
	{/if}
	<section class="work">
<div class="toolbar">
	<h1 style="margin:0">
		{new Date(`${rec.statement_date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
		<span class="muted" aria-hidden="true">·</span>
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

{#if rec.document_url === null}
	{#if open}
		<div class="card attach">
			<span class="muted small">Statement</span>
			<StatementPicker bind:value={pickId} statements={data.statements} disabled={busy} onerror={(e) => (error = e)} />
			<button disabled={busy || pickId === null} onclick={() => attach(pickId)}>Show beside the transactions</button>
		</div>
	{/if}
{:else}
	<div class="card aibox">
		<div class="aihead">
			{#if !showDoc}<button onclick={() => (showDoc = true)}>Show the statement</button>{/if}
			{#if open}
				<button class={ai ? '' : 'primary'} disabled={busy} onclick={readStatement}>
					{reading ? 'Reading the statement…' : ai ? 'Read the statement again' : 'Read the statement with AI'}
				</button>
			{/if}
			{#if ai}
				<span class="small">
					The AI read <strong>{ai.lines.length}</strong> line{ai.lines.length === 1 ? '' : 's'} from the statement:
					<strong>{ai.matched.length}</strong> matched your books and {ai.matched.length === 1 ? 'is' : 'are'} ticked{#if notInBooks.length > 0}, <strong
							>{notInBooks.length}</strong
						> {notInBooks.length === 1 ? "isn't" : "aren't"} in your books{/if}. Check them against the statement before finishing.
				</span>
			{:else if open}
				<span class="muted small">It reads the lines on the statement and ticks the transactions that match. You check and finish.</span>
			{/if}
		</div>
		{#if ai && ai.adds_up === false}
			<p class="notice warn small">The lines the AI read don't add up to the statement's opening and closing balances: some may be missing or misread.</p>
		{/if}
		{#if differs}
			<p class="notice warn small">
				The statement closes on {differs.date} with a balance of <Amount cents={differs.cents} />; this reconciliation uses {rec.statement_date} and
				<Amount cents={rec.statement_balance_cents} />.
				<button class="link" disabled={busy} onclick={useStatementFigures}>Use the statement's</button>
			</p>
		{/if}
		{#if notInBooks.length > 0}
			<details open={notInBooks.length <= 8}>
				<summary>On the statement, not in your books ({notInBooks.length})</summary>
				<table class="mini">
					<tbody>
						{#each notInBooks as l, i (i)}
							<tr><td class="mono">{l.date}</td><td>{l.description}</td><td class="num"><Amount cents={l.amount_cents} /></td></tr>
						{/each}
					</tbody>
				</table>
				<p class="muted small" style="margin:0.4rem 0 0">
					Enter the missing ones under <a href="/journal/new" target="_blank" rel="noopener">New entry</a>, then read the statement again.
				</p>
			</details>
		{/if}
	</div>
{/if}

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
							{#if aiMatch.get(l.transaction_id)}
								{@const m = aiMatch.get(l.transaction_id)!}
								<div class="small aimatch" title="The statement line the AI matched this to">≈ {m.date} {m.description}</div>
							{/if}
						</td>
						<td class="num"><Amount cents={l.amount_cents > 0 ? l.amount_cents : 0} blankZero /></td>
						<td class="num"><Amount cents={l.amount_cents < 0 ? -l.amount_cents : 0} blankZero /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
	</section>
</div>

<style>
	/* With a statement attached the page uses the whole width: the statement on the left, the lines on the right. */
	:global(main:has(.split.on)) {
		max-width: none;
	}
	.split.on {
		display: grid;
		grid-template-columns: var(--left) 0.6rem minmax(0, 1fr);
		height: calc(100vh - 6.5rem);
		min-height: 24rem;
	}
	.split.on .work {
		overflow: auto;
		padding-left: 0.6rem;
	}
	.doc {
		display: flex;
		flex-direction: column;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		overflow: hidden;
	}
	.docbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid var(--border);
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.doc iframe {
		flex: 1;
		width: 100%;
		border: none;
		background: #fff;
	}
	.picture {
		flex: 1;
		overflow: auto;
	}
	.picture img {
		max-width: 100%;
		display: block;
	}
	.divider {
		cursor: col-resize;
		touch-action: none;
		position: relative;
	}
	.divider::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		width: 3px;
		transform: translateX(-50%);
		border-radius: 2px;
		background: var(--border);
	}
	.divider:hover::after,
	.divider:focus-visible::after,
	.dragging .divider::after {
		background: var(--accent);
	}
	.divider:focus-visible {
		outline: none;
	}
	/* While dragging, the frame mustn't swallow the pointer. */
	.dragging iframe {
		pointer-events: none;
	}
	.dragging {
		user-select: none;
	}
	@media (max-width: 900px) {
		.split.on {
			display: block;
			height: auto;
		}
		.split.on .work {
			overflow: visible;
			padding-left: 0;
		}
		.doc {
			height: 55vh;
			margin-bottom: 1rem;
		}
		.divider {
			display: none;
		}
	}
	.spacer {
		flex: 1;
	}
	.attach {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.aihead {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.aibox .notice {
		margin: 0.6rem 0 0;
	}
	.aibox .notice.warn {
		background: var(--warn-bg);
		color: var(--text);
	}
	.aibox details {
		margin-top: 0.6rem;
	}
	.aibox summary {
		cursor: pointer;
		font-weight: 600;
	}
	table.mini {
		margin-top: 0.4rem;
	}
	table.mini td {
		padding: 0.2rem 0.5rem;
	}
	.aimatch {
		color: var(--ok);
	}
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
