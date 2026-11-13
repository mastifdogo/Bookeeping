<script lang="ts">
	// "Import from CSV" for a module that offers one (ctx.imports): upload, check the
	// column matching and the module's own check, then import.
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, uploadModuleImport, type ModuleImportPlan, type Schemas } from '#lib/api/client.ts';
	import { formatCents } from '#lib/money.ts';

	let { moduleId, moduleName, info }: { moduleId: string; moduleName: string; info: Schemas['ModuleImportInfo'] } = $props();

	let file = $state<FileList | null>(null);
	let useAi = $state(true);
	let plan = $state<ModuleImportPlan | null>(null);
	let busy = $state(false);
	let dirty = $state(false);
	let error: unknown = $state(null);
	let done = $state('');

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

	const read = (e: SubmitEvent) => {
		e.preventDefault();
		const f = file?.[0];
		if (!f) return;
		return act(async () => {
			done = '';
			const p = await uploadModuleImport(moduleId, f, useAi || !info.ai_available);
			// Ask the module to check the rows right away.
			plan = unwrap(await api().POST('/modules/{moduleId}/import/{uploadId}/preview', { params: { path: { moduleId, uploadId: p.id } }, body: { mapping: p.mapping } }));
			dirty = false;
		});
	};

	const refresh = () =>
		act(async () => {
			if (!plan) return;
			plan = unwrap(await api().POST('/modules/{moduleId}/import/{uploadId}/preview', { params: { path: { moduleId, uploadId: plan.id } }, body: { mapping: plan.mapping } }));
			dirty = false;
		});

	const run = () =>
		act(async () => {
			if (!plan || !confirm(`Import ${plan.ready_rows} rows into ${moduleName}?`)) return;
			const r = unwrap(await api().POST('/modules/{moduleId}/import/{uploadId}/run', { params: { path: { moduleId, uploadId: plan.id } }, body: { mapping: plan.mapping } }));
			done = `${r.summary || `Imported ${r.imported} rows.`}${r.skipped ? ` ${r.skipped} rows were left out (values that couldn't be read).` : ''}`;
			plan = null;
			file = null;
		});

	function setColumn(key: string, header: string) {
		if (!plan) return;
		plan.mapping.columns = { ...plan.mapping.columns, [key]: header || null };
		dirty = true;
	}

	const show = (v: unknown, type: string) =>
		v === null || v === undefined ? '' : type === 'money' ? formatCents(Number(v)) : type === 'boolean' ? (v ? 'yes' : 'no') : String(v);
	let blocking = $derived(plan ? plan.missing.length > 0 || plan.ready_rows === 0 || (plan.check?.errors.length ?? 0) > 0 : true);
</script>

<section class="card import">
	<h2>Import {info.label.toLowerCase()} from CSV</h2>
	{#if info.description}<p class="muted small">{info.description}</p>{/if}
	<ErrorNotice {error} />
	{#if done}<div class="notice ok">{done}</div>{/if}

	{#if !plan}
		<form class="row" onsubmit={read}>
			<input type="file" accept=".csv,.tsv,.txt,text/csv" bind:files={file} aria-label="CSV file" />
			{#if info.ai_available}<label class="inline small"><input type="checkbox" bind:checked={useAi} /> Let the AI match the columns</label>{/if}
			<button class="primary" disabled={busy || !file?.length}>{busy ? 'Reading…' : 'Read the file'}</button>
		</form>
		<p class="muted small">
			Columns: {info.fields.map((f) => f.label + (f.required ? ' *' : '')).join(', ')}. Any names and order work; you'll check the
			matching before anything is imported.
		</p>
	{:else}
		<p class="small">
			{#if plan.detection.source === 'ai'}<span class="badge">matched by AI</span>{:else}<span class="badge">matched by column names</span>{/if}
			{plan.filename} · {plan.row_count} rows, {plan.ready_rows} ready.
			{#if plan.detection.note}<span class="muted">{plan.detection.note}</span>{/if}
		</p>
		<div class="fields">
			{#each info.fields as f (f.key)}
				<label>
					<span>{f.label}{#if f.required}<span class="muted"> *</span>{/if} <span class="muted small">({f.type})</span></span>
					<select value={plan.mapping.columns[f.key] ?? ''} onchange={(e) => setColumn(f.key, e.currentTarget.value)}>
						<option value="">— not in the file —</option>
						{#each plan.headers as h (h)}<option value={h}>{h}</option>{/each}
					</select>
				</label>
			{/each}
		</div>
		<div class="row small">
			{#if info.fields.some((f) => f.type === 'date')}
				<label>
					Dates are written
					<select bind:value={plan.mapping.date_format} onchange={() => (dirty = true)}>
						<option value="mdy">month/day/year</option><option value="dmy">day/month/year</option><option value="ymd">year-month-day</option>
					</select>
				</label>
			{/if}
			{#if info.fields.some((f) => f.type === 'money' || f.type === 'number')}
				<label class="inline"><input type="checkbox" bind:checked={plan.mapping.decimal_comma} onchange={() => (dirty = true)} /> Decimal comma (1.234,56)</label>
			{/if}
			{#if dirty}<button onclick={refresh} disabled={busy}>Update the preview</button>{/if}
		</div>

		{#if plan.preview.length}
			<div class="table-wrap">
				<table class="small">
					<thead><tr><th>Row</th>{#each info.fields as f (f.key)}<th>{f.label}</th>{/each}</tr></thead>
					<tbody>
						{#each plan.preview as r, i (i)}
							<tr><td class="muted">{r._row}</td>{#each info.fields as f (f.key)}<td>{show(r[f.key], f.type)}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if plan.ready_rows > plan.preview.length}<p class="muted small">…and {plan.ready_rows - plan.preview.length} more.</p>{/if}
		{/if}

		{#if plan.missing.length}<p class="neg">Choose a column for {plan.missing.join(', ')}.</p>{/if}
		{#each plan.problems.slice(0, 10) as p, i (i)}<p class="warn-text small">Row {p.row}: {p.message} (left out)</p>{/each}
		{#if plan.problems.length > 10}<p class="warn-text small">…and {plan.problems.length - 10} more problems.</p>{/if}
		{#if plan.check}
			{#if plan.check.summary}<p><strong>{moduleName}:</strong> {plan.check.summary}</p>{/if}
			{#each plan.check.errors.slice(0, 10) as p, i (i)}<p class="neg small">Row {p.row}: {p.message}</p>{/each}
		{/if}

		<p class="row">
			<button class="primary" onclick={run} disabled={busy || dirty || blocking}>Import {plan.ready_rows} rows</button>
			<button onclick={() => ((plan = null), (file = null))} disabled={busy}>Start over</button>
		</p>
	{/if}
</section>

<style>
	h2 {
		margin-top: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.6rem 1rem;
		margin: 0.5rem 0;
	}
	select {
		width: auto;
		max-width: 100%;
	}
	.neg {
		color: var(--danger);
		margin: 0.25rem 0;
	}
	.warn-text {
		color: var(--warn);
		margin: 0.2rem 0;
	}
</style>
