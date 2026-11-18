<script lang="ts">
	// Documents: the one file store. Receipts, statements, invoices and any
	// other file, imported here or by a module, and files made in Ledger.
	// Filed in folders by kind and year on the data share; modules keep their
	// files here too (ctx.documents). Each file has tags, shared with every
	// module, and once its data has been read out, that data.
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap, type Document } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let canEdit = $derived(page.data.user != null && page.data.user.role !== 'viewer');

	type Kind = Document['kind'];
	const KINDS: { id: Kind; one: string; many: string }[] = [
		{ id: 'receipt', one: 'Receipt', many: 'Receipts' },
		{ id: 'statement', one: 'Statement', many: 'Statements' },
		{ id: 'invoice', one: 'Invoice', many: 'Invoices' },
		{ id: 'other', one: 'Other', many: 'Other' }
	];
	const kindName = (k: Kind) => KINDS.find((x) => x.id === k)?.one ?? k;

	// The folders: each kind, then the years it has documents for.
	let tree = $derived(
		KINDS.map((k) => {
			const years = data.docs.folders.filter((f) => f.kind === k.id);
			return { ...k, years, count: years.reduce((n, y) => n + y.count, 0) };
		})
	);
	let all = $derived(data.docs.folders.reduce((n, f) => n + f.count, 0));

	function show(change: { kind?: Kind | null; year?: number | null; origin?: string | null; account?: string; tag?: string; q?: string }) {
		const f = { ...data.filter, ...change };
		const p = new URLSearchParams();
		if (f.kind) p.set('kind', f.kind);
		if (f.year) p.set('year', String(f.year));
		if (f.origin) p.set('origin', f.origin);
		if (f.account) p.set('account', f.account);
		if (f.tag) p.set('tag', f.tag);
		if (f.q) p.set('q', f.q);
		goto(`?${p}`, { reset: false });
	}
	let q = $state('');
	$effect.pre(() => {
		q = data.filter.q;
	});

	let busy = $state(false);
	let error = $state<unknown>(null);
	let notice = $state('');
	async function act(fn: () => Promise<string>) {
		busy = true;
		error = null;
		notice = '';
		try {
			notice = await fn();
			await invalidateAll();
		} catch (err) {
			error = err;
		} finally {
			busy = false;
		}
	}

	// Importing: several files at once, with the same kind, date and entity.
	let importing = $state(false);
	let files = $state<File[]>([]);
	let up = $state({ kind: 'receipt' as Kind, doc_date: '', entity_id: '', account_code: '', note: '' });
	let over = $state(false);
	let failed = $state<{ name: string; why: string }[]>([]);
	function pick(list: FileList | null | undefined) {
		files = [...files, ...[...(list ?? [])].filter((f) => !files.some((x) => x.name === f.name && x.size === f.size))];
	}
	function startImport() {
		importing = !importing;
		files = [];
		failed = [];
		up = { kind: data.filter.kind ?? 'receipt', doc_date: '', entity_id: '', account_code: data.filter.account === 'none' ? '' : data.filter.account, note: '' };
	}
	const doImport = (ev: SubmitEvent) => {
		ev.preventDefault();
		return act(async () => {
			failed = [];
			let done = 0;
			for (const file of files) {
				const body = { file, kind: up.kind, doc_date: up.doc_date, entity_id: up.entity_id, account_code: up.account_code, note: up.note };
				const res = await api().POST('/documents', {
					// The generated type wants a string for the file; the form sends the file itself.
					body: body as never,
					bodySerializer: (b: Record<string, unknown>) => {
						const fd = new FormData();
						for (const [k, v] of Object.entries(b)) if (v !== '' && v != null) fd.append(k, v as string | Blob);
						return fd;
					}
				});
				try {
					unwrap(res);
					done++;
				} catch (e) {
					failed.push({ name: file.name, why: e instanceof Error ? e.message : String(e) });
				}
			}
			files = [];
			if (failed.length === 0) importing = false;
			return done === 0 ? '' : `Imported ${done} document${done === 1 ? '' : 's'}.`;
		});
	};

	type Edit = { kind: Kind; title: string; doc_date: string; entity_id: string; account_code: string; note: string };
	let editing = $state<number | null>(null);
	let form = $state<Edit>({ kind: 'receipt', title: '', doc_date: '', entity_id: '', account_code: '', note: '' });
	function edit(d: Document) {
		error = null;
		editing = d.id;
		form = { kind: d.kind, title: d.title, doc_date: d.doc_date ?? '', entity_id: d.entity_id === null ? '' : String(d.entity_id), account_code: d.account_code ?? '', note: d.note };
	}
	const save = (ev: SubmitEvent) => {
		ev.preventDefault();
		return act(async () => {
			const body = { kind: form.kind, title: form.title, doc_date: form.doc_date || null, entity_id: form.entity_id ? Number(form.entity_id) : null, account_code: form.account_code || null, note: form.note };
			const d = unwrap(await api().PATCH('/documents/{documentId}', { params: { path: { documentId: editing! } }, body }));
			editing = null;
			return `Saved ${d.title}.`;
		});
	};
	const remove = (d: Document) =>
		act(async () => {
			if (!confirm(`Delete "${d.title}"? The file is removed from the data share. Backups made before now still have it.`)) return '';
			unwrap(await api().DELETE('/documents/{documentId}', { params: { path: { documentId: d.id } } }));
			return `Deleted ${d.title}.`;
		});

	// Tags, shared with every module. "extracted" is Ledger's own: it is there while the file's data is.
	const TAGS = ['posted', 'paid', 'billed', 'overdue'];
	let tagging = $state({ tag: 'posted', custom: '', note: '' });
	const addTag = (d: Document, ev: SubmitEvent) => {
		ev.preventDefault();
		return act(async () => {
			const tag = (tagging.tag || tagging.custom).trim().toLowerCase();
			unwrap(await api().POST('/documents/{documentId}/tags', { params: { path: { documentId: d.id } }, body: { tag, note: tagging.note.trim() } }));
			tagging = { tag: 'posted', custom: '', note: '' };
			return `Tagged ${d.title} "${tag}".`;
		});
	};
	const removeTag = (d: Document, tag: string) =>
		act(async () => {
			if (tag === 'extracted' && !confirm(`Forget the data read from "${d.title}"? A module that needs it will read the file again.`)) return '';
			unwrap(await api().DELETE('/documents/{documentId}/tags/{tag}', { params: { path: { documentId: d.id, tag } } }));
			if (tag === 'extracted' && shown === d.id) shown = null;
			return tag === 'extracted' ? `Forgot the data read from ${d.title}.` : `Took "${tag}" off ${d.title}.`;
		});

	// What was read out of a file: shown on request.
	let shown = $state<number | null>(null);
	let extraction = $state<{ data: Record<string, unknown>; text: string | null } | null>(null);
	async function showData(d: Document) {
		if (shown === d.id) {
			shown = null;
			return;
		}
		error = null;
		try {
			extraction = unwrap(await api().GET('/documents/{documentId}/extracted', { params: { path: { documentId: d.id } } }));
			shown = d.id;
		} catch (err) {
			error = err;
		}
	}
	const short = (v: unknown): string => {
		if (v === null || v === undefined) return '';
		if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'row' : 'rows'}`;
		if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' && x !== null ? '…' : x}`).join(', ');
		return String(v);
	};
	const label = (k: string) => k.replace(/_cents$/, '').replaceAll('_', ' ');
	const value = (k: string, v: unknown) => (k.endsWith('_cents') && typeof v === 'number' ? (v / 100).toLocaleString(undefined, { minimumFractionDigits: 2 }) : short(v));
	const columns = (rows: unknown[]) => [...new Set(rows.slice(0, 50).flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))].slice(0, 8);
	// A list of records is shown as a table; anything else (numbers, words, a mix) as a count.
	const isTable = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
	const tables = (data: Record<string, unknown>) => Object.entries(data).filter(([, v]) => isTable(v)) as [string, Record<string, unknown>[]][];

	const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const moduleName = (id: string) => page.data.modules?.find((m: { id: string }) => m.id === id)?.label ?? id;
	const from = (d: Document) => (d.source === 'user' ? (d.added_by ?? 'A user') : moduleName(d.source));
</script>

<div class="toolbar">
	<h1 style="margin:0">Documents</h1>
	<span class="spacer"></span>
	{#if canEdit}<button class="primary" onclick={startImport}>{importing ? 'Close' : '+ Import files'}</button>{/if}
</div>
<p class="muted small">
	Every file kept in Ledger: receipts, statements and invoices you import, files made in Ledger, and the files modules work with,
	filed by kind and year. Tags are shared with every module, and data read out of a file is kept with it so it is read once. The
	files are on the data share and in every backup.
</p>

{#if notice}<div class="notice ok">{notice}</div>{/if}
<ErrorNotice {error} />

{#if importing}
	<form class="card" onsubmit={doImport}>
		<label
			class="drop"
			class:over
			ondragover={(e) => {
				e.preventDefault();
				over = true;
			}}
			ondragleave={() => (over = false)}
			ondrop={(e) => {
				e.preventDefault();
				over = false;
				pick(e.dataTransfer?.files);
			}}
		>
			<input type="file" multiple onchange={(e) => pick(e.currentTarget.files)} />
			<span><strong>Choose files</strong> or drop them here. Any kind of file (PDFs, pictures, CSV or OFX statements, spreadsheets, emails), up to {Math.round(data.docs.max_bytes / 1024 / 1024)} MB each.</span>
		</label>
		{#if files.length > 0}
			<ul class="picked small">
				{#each files as f, i (f.name + f.size)}
					<li>{f.name} <span class="muted">({size(f.size)})</span> <button type="button" class="link" onclick={() => files.splice(i, 1)}>remove</button></li>
				{/each}
			</ul>
		{/if}
		{#if failed.length > 0}
			<div class="notice error small">
				Not imported:
				<ul style="margin:0.25rem 0 0">{#each failed as f (f.name)}<li>{f.name}: {f.why}</li>{/each}</ul>
			</div>
		{/if}
		<div class="row">
			<label>These are <select bind:value={up.kind}>{#each KINDS as k (k.id)}<option value={k.id}>{k.many}</option>{/each}</select></label>
			<label>Date on them <input type="date" bind:value={up.doc_date} /></label>
			<label style="flex:1; min-width:12rem">
				From or for
				<select bind:value={up.entity_id}>
					<option value="">(nobody in particular)</option>
					{#each data.entities as e (e.id)}<option value={String(e.id)}>{e.name}</option>{/each}
				</select>
			</label>
			<label style="flex:1; min-width:12rem">
				Account {up.kind === 'statement' ? '' : '(for statements)'}
				<select bind:value={up.account_code}>
					<option value="">(none)</option>
					{#each data.accounts as a (a.code)}<option value={a.code}>{a.code} {a.name}</option>{/each}
				</select>
			</label>
			<label style="flex:2; min-width:12rem">Note <input bind:value={up.note} maxlength="2000" /></label>
		</div>
		<p class="muted small" style="margin:0">Date, entity, account and note are optional and apply to every file chosen; change them per document afterwards.</p>
		<p style="margin-bottom:0"><button class="primary" disabled={busy || files.length === 0}>Import {files.length || ''}</button></p>
	</form>
{/if}

<div class="layout">
	<nav class="folders" aria-label="Folders">
		<button class:on={!data.filter.kind} onclick={() => show({ kind: null, year: null })}>All documents <span class="muted">{all}</span></button>
		{#each tree as k (k.id)}
			<button class:on={data.filter.kind === k.id && !data.filter.year} onclick={() => show({ kind: k.id, year: null })}>{k.many} <span class="muted">{k.count}</span></button>
			{#each k.years as y (y.year)}
				<button class="year" class:on={data.filter.kind === k.id && data.filter.year === y.year} onclick={() => show({ kind: k.id, year: y.year })}>
					{y.year} <span class="muted">{y.count}</span>
				</button>
			{/each}
		{/each}
	</nav>

	<div class="main">
		<div class="toolbar">
			<div class="segmented" role="radiogroup" aria-label="Where from">
				{#each [['', 'All'], ['imported', 'Imported'], ['created', 'Made in Ledger']] as [v, label] (v)}
					<label class:on={(data.filter.origin ?? '') === v}>
						<input type="radio" name="origin" value={v} checked={(data.filter.origin ?? '') === v} onchange={() => show({ origin: v || null })} />
						{label}
					</label>
				{/each}
			</div>
			<select aria-label="Account" value={data.filter.account} onchange={(e) => show({ account: e.currentTarget.value })}>
				<option value="">All accounts</option>
				{#each data.accounts as a (a.code)}<option value={a.code}>{a.code} {a.name}</option>{/each}
				<option value="none">No account</option>
			</select>
			<select aria-label="Tag" value={data.filter.tag} onchange={(e) => show({ tag: e.currentTarget.value })}>
				<option value="">All tags</option>
				{#each data.tags.filter((t) => t.documents > 0 || t.tag === data.filter.tag) as t (t.tag)}<option value={t.tag}>{t.tag} ({t.documents})</option>{/each}
			</select>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					show({ q: q.trim() });
				}}
				style="display:flex; gap:0.4rem; flex:1; max-width:22rem"
			>
				<input type="search" bind:value={q} placeholder="Find by title, name or note" aria-label="Find" />
				<button>Find</button>
			</form>
		</div>

		<div class="table-wrap">
			{#if data.docs.data.length === 0}
				<div class="empty">{all === 0 ? 'No documents yet.' : 'None match.'}</div>
			{:else}
				<table>
					<thead><tr><th>Document</th><th>Kind</th><th>Date</th><th>Account</th><th>From or for</th><th>Added by</th><th class="num">Size</th><th></th></tr></thead>
					<tbody>
						{#each data.docs.data as d (d.id)}
							{#if editing === d.id}
								<tr>
									<td colspan="8">
										<form onsubmit={save}>
											<div class="row">
												<label style="flex:2; min-width:12rem">Title <input bind:value={form.title} required maxlength="200" /></label>
												<label>Kind <select bind:value={form.kind}>{#each KINDS as k (k.id)}<option value={k.id}>{k.one}</option>{/each}</select></label>
												<label>Date on it <input type="date" bind:value={form.doc_date} /></label>
											</div>
											<div class="row">
												<label style="flex:1; min-width:12rem">
													From or for
													<select bind:value={form.entity_id}>
														<option value="">(nobody in particular)</option>
														{#each data.entities as e (e.id)}<option value={String(e.id)}>{e.name}</option>{/each}
													</select>
												</label>
												<label style="flex:1; min-width:12rem">
													Account
													<select bind:value={form.account_code}>
														<option value="">(none)</option>
														{#each data.accounts as a (a.code)}<option value={a.code}>{a.code} {a.name}</option>{/each}
													</select>
												</label>
												<label style="flex:2; min-width:12rem">Note <input bind:value={form.note} maxlength="2000" /></label>
											</div>
											<p style="margin:0">
												<button class="primary" disabled={busy}>Save</button>
												<button type="button" onclick={() => (editing = null)}>Cancel</button>
											</p>
										</form>
										<form class="row tagform" onsubmit={(e) => addTag(d, e)}>
											<span class="muted small">Tags (every module sees them)</span>
											{#each d.tags as t (t.tag)}
												<span class="badge tag {t.tag}">{t.tag}{t.note ? `: ${t.note}` : ''} <button type="button" class="link x" title="Take this tag off" disabled={busy} onclick={() => removeTag(d, t.tag)}>×</button></span>
											{/each}
											<select bind:value={tagging.tag} aria-label="Tag" style="width:auto">
												{#each TAGS as s (s)}<option value={s}>{s}</option>{/each}
												<option value="">another…</option>
											</select>
											{#if tagging.tag === ''}<input bind:value={tagging.custom} placeholder="a word, e.g. disputed" maxlength="40" pattern="[A-Za-z][A-Za-z0-9_\-]*" required style="width:11rem" aria-label="Tag word" />{/if}
											<input bind:value={tagging.note} placeholder="Note (optional)" maxlength="200" style="width:12rem" aria-label="Note" />
											<button disabled={busy}>Add tag</button>
										</form>
									</td>
								</tr>
							{:else}
								<tr>
									<td>
										<a href={d.url} target="_blank" rel="noopener"><strong>{d.title}</strong></a>
										{#if d.origin === 'created'}<span class="badge ok">made in Ledger</span>{/if}
										{#if d.reconciled}<span class="badge ok" title="An account has been reconciled against this statement">reconciled</span>{/if}
										{#each d.tags as t (t.tag)}
											<span class="badge tag {t.tag}" title="{t.note ? t.note + ' · ' : ''}set by {t.module_id ? moduleName(t.module_id) : (t.set_by ?? 'Ledger')}">{t.tag === 'extracted' ? 'data extracted' : t.tag}</span>
										{/each}
										<div class="muted small">
											{d.path}{#if d.note} · {d.note}{/if}
										</div>
										{#each d.marks as m (m.module)}
											<div class="muted small">{moduleName(m.module)}: {m.status}{m.note ? `, ${m.note}` : ''}</div>
										{/each}
										{#if d.extracted}
											<div class="muted small">
												Data read out{d.extracted.module_id ? ` by ${moduleName(d.extracted.module_id)}` : ''}
												<button class="link" onclick={() => showData(d)}>{shown === d.id ? 'hide' : 'show'}</button>
											</div>
										{/if}
									</td>
									<td>{kindName(d.kind)}</td>
									<td>{d.doc_date ?? ''}</td>
									<td>{#if d.account_code}<span class="mono">{d.account_code}</span> {d.account_name}{/if}</td>
									<td>{d.entity_name ?? ''}</td>
									<td>{from(d)}</td>
									<td class="num">{size(d.size_bytes)}</td>
									<td class="num actions">
										<a href="{d.url}?download=1">Download</a>
										{#if canEdit}
											<button class="link" onclick={() => edit(d)}>Edit</button>
											<button class="link" disabled={busy} onclick={() => remove(d)}>Delete</button>
										{/if}
									</td>
								</tr>
								{#if shown === d.id && extraction}
									<tr>
										<td colspan="8" class="extracted">
											<dl>
												{#each Object.entries(extraction.data).filter(([, v]) => !isTable(v)) as [k, v] (k)}
													<div><dt>{label(k)}</dt><dd>{value(k, v)}</dd></div>
												{/each}
											</dl>
											{#each tables(extraction.data) as [k, rows] (k)}
												<p class="small" style="margin:0.5rem 0 0.2rem"><strong>{label(k)}</strong> <span class="muted">({rows.length})</span></p>
												<div class="table-wrap inner">
													<table>
														<thead><tr>{#each columns(rows) as c (c)}<th class:num={c.endsWith('_cents')}>{label(c)}</th>{/each}</tr></thead>
														<tbody>
															{#each rows.slice(0, 200) as r, i (i)}
																<tr>{#each columns(rows) as c (c)}<td class:num={c.endsWith('_cents')}>{value(c, r[c])}</td>{/each}</tr>
															{/each}
														</tbody>
													</table>
												</div>
												{#if rows.length > 200}<p class="muted small">The first 200 of {rows.length}.</p>{/if}
											{/each}
											{#if extraction.text}
												<details><summary class="small">The file's text</summary><pre class="small">{extraction.text.slice(0, 20000)}{extraction.text.length > 20000 ? '\n…' : ''}</pre></details>
											{/if}
											{#if canEdit}
												<p class="small" style="margin:0.5rem 0 0">
													<button class="link" disabled={busy} onclick={() => removeTag(d, 'extracted')}>Forget this data</button>
													<span class="muted">(a module that needs it reads the file again)</span>
												</p>
											{/if}
										</td>
									</tr>
								{/if}
							{/if}
						{/each}
					</tbody>
				</table>
				{#if data.docs.total > data.docs.data.length}
					<p class="muted small">Showing the newest {data.docs.data.length} of {data.docs.total}. Open a folder or search to narrow it down.</p>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.spacer {
		flex: 1;
	}
	.layout {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		margin-top: 0.75rem;
	}
	.main {
		flex: 1;
		min-width: 0;
	}
	.folders {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		width: 11rem;
		flex-shrink: 0;
	}
	.folders button {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		border: none;
		background: none;
		text-align: left;
		padding: 0.35rem 0.6rem;
	}
	.folders button.year {
		padding-left: 1.5rem;
	}
	.folders button:hover {
		background: var(--row-hover);
	}
	.folders button.on {
		background: var(--row-hover);
		font-weight: 600;
	}
	@media (max-width: 720px) {
		.layout {
			flex-direction: column;
			/* Stacked, each part is as wide as the window; the table scrolls inside its own box. */
			align-items: stretch;
		}
		.folders {
			flex-direction: row;
			flex-wrap: wrap;
			width: auto;
		}
		.folders button.year {
			padding-left: 0.6rem;
		}
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.6rem 0;
		align-items: flex-end;
	}
	.drop {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		border: 2px dashed var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		cursor: pointer;
	}
	.drop.over {
		border-color: var(--accent);
		background: var(--row-hover);
	}
	.picked {
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
	.actions {
		white-space: nowrap;
	}
	.actions > * {
		margin-left: 0.5rem;
	}
	.tagform {
		margin: 0.6rem 0 0;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
		align-items: center;
	}
	.tagform input {
		width: auto;
	}
	button.link.x {
		color: inherit;
		font-weight: 700;
	}
	.extracted dl {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.25rem 1rem;
		margin: 0;
	}
	.extracted dt {
		font-size: 0.8rem;
		color: var(--muted);
		text-transform: capitalize;
	}
	.extracted dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.extracted th {
		text-transform: capitalize;
	}
	.extracted pre {
		white-space: pre-wrap;
		max-height: 20rem;
		overflow: auto;
	}
	.table-wrap.inner {
		max-height: 22rem;
		overflow: auto;
	}
	button.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
	}
	select {
		width: auto;
	}
	td:nth-child(3) {
		white-space: nowrap;
	}
	.segmented {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.segmented label {
		display: flex;
		flex-direction: row;
		align-items: center;
		padding: 0.35rem 0.8rem;
		cursor: pointer;
		color: var(--text);
		border-right: 1px solid var(--border);
	}
	.segmented label:last-child {
		border-right: none;
	}
	.segmented label.on {
		background: var(--accent);
		color: var(--accent-text);
	}
	.segmented input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.segmented label:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
</style>
