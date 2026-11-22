<script lang="ts">
	import { goto } from '$app/navigation';
	import Amount from '#lib/components/Amount.svelte';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import StatementPicker from '#lib/components/StatementPicker.svelte';
	import { api, unwrap, type ReconciliationDetail } from '#lib/api/client.ts';
	import { centsToInput, formatCents, parseSignedAmount } from '#lib/money.ts';
	import { tagLabel, tagKey } from '#lib/tags.ts';
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

	// Finishing closes this window: back to the Reconcile page, which says what was finished.
	// With a difference left, it is posted to the Unreconciled clearing account first.
	const finish = () => {
		const off = d.difference_cents !== 0;
		const unticked = d.lines.filter((l) => !l.cleared).length;
		const parts: string[] = [];
		if (off)
			parts.push(
				`The difference of ${formatCents(d.difference_cents)} ${rec.currency} is posted between ${rec.account_code} and the Unreconciled clearing account` +
					(postsLines ? `, one entry for each of the ${notInBooks.length} statement lines not in your books` : '') +
					', and ticked, so the account matches the statement.'
			);
		if (unticked > 0 && rec.entity_role)
			parts.push(`${unticked} transaction${unticked === 1 ? '' : 's'} not ticked stay${unticked === 1 ? 's' : ''} in ${rec.account_code} ${rec.account_name}: not on this statement, so still to be checked against the next one.`);
		else if (unticked > 0)
			parts.push(
				`${unticked} transaction${unticked === 1 ? '' : 's'} not ticked move${unticked === 1 ? 's' : ''} from ${rec.account_code} to the Unreconciled clearing account, each with a to-do, until you move ${unticked === 1 ? 'it' : 'them'} to the right account.`
			);
		if (parts.length > 0 && !confirm(`Finish this reconciliation?\n\n${parts.join('\n\n')}`)) return;
		return run(async () => {
			const done = unwrap(await api().POST('/reconciliations/{reconciliationId}/finish', { ...path(), body: { post_difference: off } }));
			await goto(`/reconcile?finished=${done.reconciliation.id}`);
		});
	};
	const undo = () => run(async () => unwrap(await api().POST('/reconciliations/{reconciliationId}/undo', path())));
	// --- The statement beside the lines -------------------------------------
	let pickId = $state<number | null>(null);
	let showDoc = $state(true);
	// Full height: the statement takes the whole window, top to bottom, with nothing above it. Remembered in this browser.
	const TALL_STORAGE = 'ledger.reconcile.tall';
	let tall = $state(false);
	try {
		tall = localStorage.getItem(TALL_STORAGE) === '1';
	} catch {
		// storage blocked: for this page only
	}
	// The browser's own PDF toolbar (page, zoom, print) can be left out, so only the page shows. Remembered in this browser.
	const BAR_STORAGE = 'ledger.reconcile.pdfbar';
	let pdfBar = $state(true);
	try {
		pdfBar = localStorage.getItem(BAR_STORAGE) !== '0';
	} catch {
		// storage blocked: for this page only
	}
	function setPdfBar(on: boolean) {
		pdfBar = on;
		try {
			localStorage.setItem(BAR_STORAGE, on ? '1' : '0');
		} catch {
			// storage blocked
		}
	}
	// Which side the statement is on: the left (as it comes) or, swapped, the right. Remembered in this browser.
	const SIDE_STORAGE = 'ledger.reconcile.side';
	let flip = $state(false);
	try {
		flip = localStorage.getItem(SIDE_STORAGE) === 'right';
	} catch {
		// storage blocked: for this page only
	}
	function setFlip(on: boolean) {
		flip = on;
		try {
			localStorage.setItem(SIDE_STORAGE, on ? 'right' : 'left');
		} catch {
			// storage blocked
		}
	}
	function setTall(on: boolean) {
		tall = on;
		try {
			localStorage.setItem(TALL_STORAGE, on ? '1' : '0');
		} catch {
			// storage blocked
		}
	}
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
	// Finishing posts these one by one when they make up exactly the difference.
	let postsLines = $derived(notInBooks.length > 0 && notInBooks.reduce((t, l) => t + l.amount_cents, 0) === d.difference_cents);
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
		// `left` is the statement's share of the width, whichever side it is on.
		setLeft(((flip ? box.right - e.clientX : e.clientX - box.left) / box.width) * 100);
	}
	function dragKey(e: KeyboardEvent) {
		const wider = flip ? 'ArrowLeft' : 'ArrowRight';
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setLeft(left + (e.key === wider ? 2 : -2));
		else return;
		e.preventDefault();
	}
	let split = $derived(rec.document_url !== null && showDoc);

	function discard() {
		if (!confirm('Discard this reconciliation? Ticked lines go back to uncleared.')) return;
		run(async () => {
			const res = await api().DELETE('/reconciliations/{reconciliationId}', path());
			if (res.response.status !== 204) unwrap(res);
			await goto('/reconcile?list');
		});
	}
</script>

{#if !(split && tall)}<p class="small back"><a href="/reconcile?list">← All reconciliations</a></p>{/if}

<div class="split" class:on={split} class:tall={split && tall} class:flip={split && flip} class:dragging bind:this={splitEl} style="--left:{left}%">
	{#if split}
		<section class="doc" aria-label="Statement">
			<div class="docbar">
				<strong class="ellipsis">{rec.document_title}</strong>
				<span class="spacer"></span>
				<a href={rec.document_url} target="_blank" rel="noopener">Open in a new tab</a>
				{#if open}<button class="link" disabled={busy} onclick={() => attach(null)}>Take off</button>{/if}
				{#if rec.document_type === 'application/pdf'}
					<button class="link" aria-pressed={!pdfBar} title={pdfBar ? "Hide the PDF viewer's toolbar (page, zoom, print), so only the page shows" : "Show the PDF viewer's toolbar again"} onclick={() => setPdfBar(!pdfBar)}>{pdfBar ? 'Hide toolbar' : 'Show toolbar'}</button>
				{/if}
				<button class="link" title="Put the statement on the {flip ? 'left' : 'right'} and the transactions on the {flip ? 'right' : 'left'}" onclick={() => setFlip(!flip)}>{flip ? 'Move left' : 'Move right'}</button>
				<button class="link" aria-pressed={tall} title={tall ? 'Back to the statement under the page heading' : 'The statement fills the window from top to bottom'} onclick={() => setTall(!tall)}>{tall ? 'Normal height' : 'Full height'}</button>
				<button class="link" onclick={() => (showDoc = false)}>Hide</button>
			</div>
			{#if rec.document_type === 'application/pdf'}
				<!-- The viewer reads its options when the file loads, so the frame is made again when they change. -->
				{#key pdfBar}
					<iframe src="{rec.document_url}#{pdfBar ? '' : 'toolbar=0&navpanes=0&'}view=FitH" title="Statement: {rec.document_title}"></iframe>
				{/key}
			{:else if rec.document_type?.startsWith('image/')}
				<div class="picture"><img src={rec.document_url} alt="Statement: {rec.document_title}" /></div>
			{:else if rec.document_type === 'text/csv' || rec.document_type === 'text/plain'}
				<!-- A statement kept as text (a CSV): shown as it is, sandboxed by the server. -->
				<iframe src={rec.document_url} title="Statement: {rec.document_title}"></iframe>
			{:else}
				<p class="muted" style="padding:0.75rem">
					This statement is a file the browser can't show beside the lines (an OFX or QFX file, say).
					<a href="{rec.document_url}?download=1">Download it</a> to look at it.
				</p>
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
{#if split && tall}<p class="small back"><a href="/reconcile?list">← All reconciliations</a></p>{/if}
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
		<button
			class="primary"
			onclick={finish}
			disabled={busy}
			title={d.difference_cents === 0 ? 'Finish the reconciliation' : 'Post the difference to the Unreconciled clearing account and finish'}
			>{d.difference_cents === 0 ? 'Finish' : 'Finish, difference to Unreconciled'}</button
		>
	{:else}
		<button onclick={undo} disabled={busy} title="Reopen for changes (most recent reconciliation only)">Undo</button>
	{/if}
</div>

<ErrorNotice {error} />

{#if d.gap_warning && open}
	<div class="notice warn" role="alert">
		<strong>Gap since the last reconciliation.</strong> This account was last reconciled to {d.previous_statement_date}, {d.gap_days} days before this
		statement ({rec.statement_date}). A statement in between may have been skipped; reconcile it first, or carry on if this one covers the whole time.
	</div>
{/if}

{#if rec.document_url === null}
	{#if open}
		<div class="card attach">
			<span class="muted small">Statement</span>
			<StatementPicker bind:value={pickId} statements={data.statements} accountCode={rec.account_code} disabled={busy} onerror={(e) => (error = e)} />
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
					{ai.model ? 'The AI read' : 'Read from the statement:'} <strong>{ai.lines.length}</strong> line{ai.lines.length === 1 ? '' : 's'} from the statement:
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
				lines until this is 0.00, or finish and the difference is posted against Unreconciled{rec.entity_role ? ` (statement lines your books don't have, for you to move to the right account)` : ''}.{/if}
			{#if open && d.totals.uncleared.debit_count + d.totals.uncleared.credit_count > 0}<br /><span class="muted"
					>{rec.entity_role ? `On finishing, lines not ticked stay in this ${rec.entity_role}'s account.` : 'On finishing, lines not ticked move to Unreconciled.'}</span
				>{/if}
		</span>
	</div>
</div>

<div class="card totals">
	<table class="mini">
		<thead>
			<tr><th></th><th class="num">{debitNormal ? 'Deposits' : 'Payments'} (debits)</th><th class="num">{debitNormal ? 'Withdrawals' : 'Charges'} (credits)</th></tr>
		</thead>
		<tbody>
			<tr>
				<th scope="row">Ticked</th>
				<td class="num"><Amount cents={d.totals.cleared.debit_cents} /> <span class="muted small">({d.totals.cleared.debit_count})</span></td>
				<td class="num"><Amount cents={d.totals.cleared.credit_cents} /> <span class="muted small">({d.totals.cleared.credit_count})</span></td>
			</tr>
			<tr>
				<th scope="row">Not ticked</th>
				<td class="num"><Amount cents={d.totals.uncleared.debit_cents} /> <span class="muted small">({d.totals.uncleared.debit_count})</span></td>
				<td class="num"><Amount cents={d.totals.uncleared.credit_cents} /> <span class="muted small">({d.totals.uncleared.credit_count})</span></td>
			</tr>
		</tbody>
	</table>
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
							{#each l.tags as t (tagKey(t))}
								<span class="badge tag {t.tag}" title={t.module_id ? `Set by ${t.module_id}` : 'Set by a person'}>{tagLabel(t)}</span>
							{/each}
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
	/* The page fills its window exactly: the statement and the lines share what is left under the link, each scrolling on its own. */
	:global(main:has(.split.on)) {
		max-width: none;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		padding-top: 0.5rem;
		padding-bottom: 0.5rem;
	}
	/* Full height: nothing above or around the statement. */
	:global(main:has(.split.tall)) {
		padding: 0;
	}
	.split.tall .doc {
		border-radius: 0;
		border-width: 0 1px 0 0;
	}
	.split.tall .work {
		padding-top: 0.5rem;
		padding-right: 0.75rem;
	}
	.back {
		margin: 0 0 0.4rem;
	}
	.split.on {
		display: grid;
		grid-template-columns: var(--left) 0.6rem minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.split.on .work {
		overflow: auto;
		padding-left: 0.6rem;
	}
	/* Swapped: the transactions on the left, the statement on the right. */
	.split.on.flip {
		grid-template-columns: minmax(0, 1fr) 0.6rem var(--left);
	}
	.split.on.flip .work {
		order: 1;
		padding-left: 0;
		padding-right: 0.6rem;
	}
	.split.on.flip .divider {
		order: 2;
	}
	.split.on.flip .doc {
		order: 3;
	}
	.split.tall.flip .doc {
		border-width: 0 0 0 1px;
	}
	.split.tall.flip .work {
		padding-left: 0.75rem;
		padding-right: 0.6rem;
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
		/* A narrow statement: its links go on a second line instead of being cut off. */
		flex-wrap: wrap;
		row-gap: 0.2rem;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1 1 8rem;
		min-width: 0;
	}
	.docbar .spacer {
		display: none;
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
		:global(main:has(.split.on)) {
			height: auto;
			display: block;
		}
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
	.totals {
		margin-bottom: 1rem;
		padding: 0.5rem 0.75rem;
	}
	.totals table {
		margin: 0;
		width: auto;
	}
	.totals th,
	.totals td {
		padding: 0.2rem 0.75rem;
	}
	.totals th[scope='row'] {
		background: none;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.85rem;
		color: var(--muted);
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
