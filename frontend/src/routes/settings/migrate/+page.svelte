<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { ACCOUNT_TYPES, CURRENCIES, api, unwrap, uploadMigration, type AccountType, type Currency, type MigrationPlan } from '#lib/api/client.ts';
	import { formatCents } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Kind = MigrationPlan['mapping']['kind'];
	const KINDS: { value: Kind; label: string; help: string }[] = [
		{ value: 'general_ledger', label: 'General ledger / transactions', help: 'Dated lines with accounts and debits/credits (or amounts). Becomes journal entries, plus any accounts they need.' },
		{ value: 'accounts', label: 'Chart of accounts', help: 'Account names, maybe numbers and types. Becomes accounts.' },
		{ value: 'trial_balance', label: 'Trial balance / opening balances', help: 'One balance per account. Becomes one opening entry on the date you choose.' },
		{ value: 'customers', label: 'Customers', help: 'A contact list. Ledger hands it to a module that keeps customers.' },
		{ value: 'vendors', label: 'Vendors / suppliers', help: 'A contact list. Ledger hands it to a module that keeps vendors.' }
	];
	const FIELD_LABELS: Record<string, string> = {
		date: 'Date',
		account: 'Account',
		debit: 'Debit',
		credit: 'Credit',
		amount: 'Amount (signed, instead of debit/credit)',
		entry_id: 'Transaction id (groups lines)',
		description: 'Description',
		reference: 'Reference',
		memo: 'Line memo',
		currency: 'Currency',
		code: 'Account number',
		name: 'Name',
		type: 'Account type',
		balance: 'Balance (signed)',
		email: 'Email',
		phone: 'Phone'
	};
	const FROM: Record<string, string> = { file: 'from the file', ledger: 'already in Ledger', ai: 'suggested by AI', guess: 'guessed from the name', you: 'your choice' };

	let file = $state<FileList | null>(null);
	let useAi = $state(true);
	let plan = $state<MigrationPlan | null>(null);
	let busy = $state(false);
	let error: unknown = $state(null);
	let done = $state('');
	let recipient = $state('');
	let dirty = $state(false);

	let errors = $derived(plan?.issues.filter((i) => i.level === 'error') ?? []);
	let warnings = $derived(plan?.issues.filter((i) => i.level === 'warning') ?? []);
	let newAccounts = $derived(plan?.accounts.filter((a) => a.action === 'create' && !a.exists) ?? []);

	async function act(fn: () => Promise<void>) {
		error = null;
		busy = true;
		try {
			await fn();
		} catch (e) {
			error = e;
		} finally {
			busy = false;
		}
	}

	const analyze = (e: SubmitEvent) => {
		e.preventDefault();
		const f = file?.[0];
		if (!f) return;
		return act(async () => {
			done = '';
			plan = await uploadMigration(f, useAi || !data.info.ai_available);
			recipient = plan.contacts.recipients[0]?.id ?? '';
			dirty = false;
		});
	};

	/** Sends the edited mapping back and shows the new preview. */
	const refresh = () =>
		act(async () => {
			if (!plan) return;
			plan = unwrap(await api().POST('/migrations/{uploadId}/preview', { params: { path: { uploadId: plan.id } }, body: { mapping: plan.mapping } }));
			if (!plan.contacts.recipients.some((r) => r.id === recipient)) recipient = plan.contacts.recipients[0]?.id ?? '';
			dirty = false;
		});

	function changeKind(k: Kind) {
		if (!plan) return;
		// Columns are matched again for the new kind.
		plan.mapping = { ...plan.mapping, kind: k, columns: {} };
		act(async () => {
			plan = unwrap(await api().POST('/migrations/{uploadId}/preview', { params: { path: { uploadId: plan!.id } }, body: { mapping: { kind: k, header_row: plan!.mapping.header_row } } }));
			dirty = false;
		});
	}

	function setColumn(field: string, header: string) {
		if (!plan) return;
		plan.mapping.columns = { ...plan.mapping.columns, [field]: header || null };
		dirty = true;
	}

	function setAccount(label: string, change: Record<string, unknown>) {
		if (!plan) return;
		const a = plan.accounts.find((x) => x.label === label)!;
		const cur = plan.mapping.accounts[label] ?? {};
		const next = { action: a.action, code: a.code, name: a.name, type: a.type, currency: a.currency, ...cur, ...change };
		if (change.action === 'create' && a.exists) next.code = '';
		plan.mapping.accounts = { ...plan.mapping.accounts, [label]: next as never };
		dirty = true;
	}

	const runImport = () =>
		act(async () => {
			if (!plan) return;
			const what =
				plan.mapping.kind === 'customers' || plan.mapping.kind === 'vendors'
					? `Send ${plan.contacts.count} ${plan.mapping.kind} to ${plan.contacts.recipients.find((r) => r.id === recipient)?.name}?`
					: `Create ${newAccounts.length} accounts${plan.entries.count ? ` and post ${plan.entries.count} journal entries` : ''}? It's all or nothing; entries can be undone later only by reversing them.`;
			if (!confirm(what)) return;
			const r = unwrap(await api().POST('/migrations/{uploadId}/import', { params: { path: { uploadId: plan.id } }, body: { mapping: plan.mapping, recipient: recipient || undefined } }));
			done = r.sent_to
				? `Sent the list to ${plan.contacts.recipients.find((x) => x.id === r.sent_to)?.name ?? r.sent_to}; it shows there for you to review.`
				: `Created ${r.accounts_created} accounts and ${r.entries_created} journal entries${r.import_id ? ` (import batch ${r.import_id})` : ''}.`;
			plan = null;
			file = null;
		});

	const money = (c: number | bigint) => (Number(c) === 0 ? '' : formatCents(Number(c)));
	const pct = (x: number) => `${Math.round(x * 100)}%`;
</script>

<p><a href="/settings/import-export">← Import &amp; export</a></p>
<h2 style="margin-top:0">Migrate from other software</h2>
<p class="muted">
	Bring your books over from QuickBooks, Xero, Wave, Sage, FreshBooks or a spreadsheet: export a report as CSV there, upload it
	here, check what Ledger understood, then import. Start with the chart of accounts, then opening balances (a trial balance) or
	the general ledger.
</p>

<ErrorNotice {error} />
{#if done}<div class="notice ok">{done} <a href="/journal">Open the journal</a> · <a href="/accounts">Accounts</a></div>{/if}

<form class="card toolbar" onsubmit={analyze}>
	<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" bind:files={file} aria-label="Export file" />
	{#if data.info.ai_available}
		<label class="inline small"><input type="checkbox" bind:checked={useAi} /> Let the AI work out what it is</label>
	{:else}
		<span class="muted small">Columns are matched by name. <a href="/settings/llm">Set up an LLM</a> to let AI read the file.</span>
	{/if}
	<button class="primary" disabled={busy || !file?.length}>{busy && !plan ? 'Reading…' : 'Read the file'}</button>
</form>

{#if plan}
	{@const p = plan}
	<section class="card">
		<h3>What this looks like</h3>
		<p>
			{#if p.detection.source === 'ai'}<span class="badge">AI · {pct(p.detection.confidence)} sure</span>{:else}<span class="badge">by column names</span>{/if}
			{p.detection.summary}
			{#if p.detection.software}<span class="muted small">(probably {p.detection.software})</span>{/if}
		</p>
		{#if p.detection.note}<p class="muted small">{p.detection.note}</p>{/if}
		<p class="muted small">{p.filename} · {p.row_count} rows. {p.detection.source === 'ai' ? 'Check the AI\'s reading below; nothing is imported until you press Import.' : 'Check the columns below; nothing is imported until you press Import.'}</p>

		<div class="row">
			<label>
				The file is a
				<select value={p.mapping.kind} onchange={(e) => changeKind(e.currentTarget.value as Kind)}>
					{#each KINDS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
				</select>
			</label>
			<label>
				Column names are on row
				<select value={p.mapping.header_row} onchange={(e) => ((p.mapping.header_row = Number(e.currentTarget.value)), (p.mapping.columns = {}), changeKind(p.mapping.kind))}>
					{#each p.sample.slice(0, 15) as r, i (i)}<option value={i}>{i + 1}: {r.filter((c) => c).slice(0, 4).join(' · ').slice(0, 60)}</option>{/each}
				</select>
			</label>
		</div>
		<p class="muted small">{KINDS.find((k) => k.value === p.mapping.kind)?.help}</p>

		<h4>Columns</h4>
		<div class="columns">
			{#each p.fields as f (f)}
				{#if !(f === 'account' && p.mapping.account_from_sections)}
					<label>
						<span>{FIELD_LABELS[f] ?? f}{#if p.required.includes(f)}<span class="muted"> *</span>{/if}</span>
						<select value={p.mapping.columns[f] ?? ''} onchange={(e) => setColumn(f, e.currentTarget.value)}>
							<option value="">— not in the file —</option>
							{#each p.headers as h (h)}<option value={h}>{h}</option>{/each}
						</select>
					</label>
				{/if}
			{/each}
		</div>
		<div class="row small">
			{#if p.mapping.kind === 'general_ledger'}
				<label class="inline"><input type="checkbox" bind:checked={p.mapping.account_from_sections} onchange={() => (dirty = true)} /> Accounts are heading rows (report grouped by account)</label>
				<label>
					Dates are written
					<select bind:value={p.mapping.date_format} onchange={() => (dirty = true)}>
						<option value="mdy">month/day/year</option><option value="dmy">day/month/year</option><option value="ymd">year-month-day</option>
					</select>
				</label>
			{/if}
			{#if p.mapping.kind === 'trial_balance'}
				<label>Opening balances as of <input type="date" bind:value={p.mapping.as_of} onchange={() => (dirty = true)} /></label>
			{/if}
			{#if p.mapping.kind !== 'customers' && p.mapping.kind !== 'vendors'}
				<label class="inline"><input type="checkbox" bind:checked={p.mapping.decimal_comma} onchange={() => (dirty = true)} /> Amounts use a decimal comma (1.234,56)</label>
				<label>
					Currency of new accounts
					<select bind:value={p.mapping.currency} onchange={() => (dirty = true)}>{#each CURRENCIES as c (c)}<option value={c}>{c}</option>{/each}</select>
				</label>
			{/if}
		</div>
		{#if dirty}<p><button onclick={refresh} disabled={busy}>Update the preview</button></p>{/if}

		<details>
			<summary class="small">The first rows of the file</summary>
			<div class="table-wrap">
				<table class="small sample">
					<tbody>
						{#each p.sample as r, i (i)}
							<tr class:header={i === p.mapping.header_row}><td class="muted">{i + 1}</td>{#each r as c, j (j)}<td>{c}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	</section>

	{#if p.accounts.length > 0}
		<section class="card">
			<h3>Accounts</h3>
			<p class="muted small">
				{newAccounts.length} new, {p.accounts.filter((a) => a.exists && a.action === 'map').length} already in Ledger. Change the type, number or name of new ones, or
				post to an account you already have.
			</p>
			<div class="table-wrap">
				<table class="accounts">
					<thead><tr><th>In the file</th><th>Do</th><th>Number</th><th>Name</th><th>Type</th><th>Currency</th></tr></thead>
					<tbody>
						{#each p.accounts as a (a.label)}
							<tr class:skip={a.action === 'skip'}>
								<td>{a.label}{#if a.rows > 1 && p.mapping.kind !== 'accounts'}<span class="muted small"> · {a.rows} lines</span>{/if}<div class="muted small">{FROM[a.from]}</div></td>
								<td>
									<select value={a.action} onchange={(e) => setAccount(a.label, { action: e.currentTarget.value })} aria-label="What to do with {a.label}">
										<option value="create">Create</option>
										<option value="map">Use existing</option>
										{#if p.mapping.kind === 'accounts'}<option value="skip">Skip</option>{/if}
									</select>
								</td>
								{#if a.action === 'map'}
									<td colspan="4">
										<select value={a.exists ? a.code : ''} onchange={(e) => setAccount(a.label, { action: 'map', code: e.currentTarget.value })} aria-label="Existing account for {a.label}">
											<option value="" disabled>Choose…</option>
											{#each data.accounts as x (x.code)}<option value={x.code}>{x.code} — {x.name} ({x.currency})</option>{/each}
										</select>
									</td>
								{:else if a.action === 'create'}
									<td><input class="mono" value={a.code} size="7" onchange={(e) => setAccount(a.label, { code: e.currentTarget.value })} aria-label="Number for {a.label}" /></td>
									<td><input value={a.name} onchange={(e) => setAccount(a.label, { name: e.currentTarget.value })} aria-label="Name for {a.label}" /></td>
									<td>
										<select value={a.type} onchange={(e) => setAccount(a.label, { type: e.currentTarget.value as AccountType })} aria-label="Type of {a.label}">
											{#each ACCOUNT_TYPES as t (t)}<option value={t}>{t}</option>{/each}
										</select>
									</td>
									<td>
										<select value={a.currency} onchange={(e) => setAccount(a.label, { currency: e.currentTarget.value as Currency })} aria-label="Currency of {a.label}">
											{#each CURRENCIES as c (c)}<option value={c}>{c}</option>{/each}
										</select>
									</td>
								{:else}
									<td colspan="4" class="muted small">Not imported</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if dirty}<p><button onclick={refresh} disabled={busy}>Update the preview</button></p>{/if}
		</section>
	{/if}

	{#if p.entries.count > 0}
		<section class="card">
			<h3>Journal entries</h3>
			<p>
				{p.entries.count} entries, {p.entries.lines} lines{#if p.entries.from}, {p.entries.from} to {p.entries.to}{/if}. The first ones:
			</p>
			{#each p.entries.preview as e, i (i)}
				<div class="entry">
					<div><span class="mono">{e.date}</span> {e.description}{#if e.reference}<span class="muted"> · {e.reference}</span>{/if}</div>
					<table class="small">
						<tbody>
							{#each e.lines as l, j (j)}
								<tr><td class="mono">{l.account_code}</td><td>{l.memo}</td><td class="num">{money(l.debit_cents)}</td><td class="num">{money(l.credit_cents)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/each}
		</section>
	{/if}

	{#if p.mapping.kind === 'customers' || p.mapping.kind === 'vendors'}
		<section class="card">
			<h3>{p.contacts.count} {p.mapping.kind}</h3>
			{#if p.contacts.recipients.length > 0}
				<label>
					Send the list to
					<select bind:value={recipient}>{#each p.contacts.recipients as r (r.id)}<option value={r.id}>{r.name}</option>{/each}</select>
				</label>
				<p class="muted small">The module receives the file and its column names, and decides how to add them.</p>
			{/if}
		</section>
	{/if}

	{#if errors.length || warnings.length}
		<section class="card">
			{#each errors as i, n (n)}<p class="neg">✗ {i.message}</p>{/each}
			{#each warnings as i, n (n)}<p class="warn-text">! {i.message}</p>{/each}
		</section>
	{/if}

	<p class="toolbar">
		<button class="primary" onclick={runImport} disabled={busy || dirty || errors.length > 0}>
			{p.mapping.kind === 'customers' || p.mapping.kind === 'vendors' ? 'Send' : 'Import'}
		</button>
		{#if dirty}<span class="muted small">Update the preview first.</span>{:else if errors.length}<span class="muted small">Fix the problems above first.</span>{/if}
		<button onclick={() => ((plan = null), (file = null))} disabled={busy}>Start over</button>
	</p>
{/if}

<style>
	h3 {
		margin-top: 0;
	}
	h4 {
		margin: 1rem 0 0.4rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.25rem;
		align-items: flex-end;
		margin: 0.5rem 0;
	}
	.columns {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.6rem 1rem;
	}
	select {
		width: auto;
		max-width: 100%;
	}
	.sample td {
		white-space: nowrap;
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sample tr.header td {
		font-weight: 700;
		background: var(--bg);
	}
	.accounts input {
		width: 100%;
		min-width: 6rem;
	}
	.accounts tr.skip td {
		color: var(--muted);
	}
	.entry {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.entry table {
		margin-top: 0.25rem;
		max-width: 40rem;
	}
	.neg {
		color: var(--danger);
		margin: 0.3rem 0;
	}
	.warn-text {
		color: var(--warn);
		margin: 0.3rem 0;
	}
</style>
