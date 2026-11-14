<script lang="ts">
	// Documents: PDFs of receipts, statements and invoices, imported here or
	// by a module, and PDFs made in Ledger. Filed in folders by kind and year
	// on the data share; modules read them through ctx.documents.
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

	function show(change: { kind?: Kind | null; year?: number | null; origin?: string | null; account?: string; q?: string }) {
		const f = { ...data.filter, ...change };
		const p = new URLSearchParams();
		if (f.kind) p.set('kind', f.kind);
		if (f.year) p.set('year', String(f.year));
		if (f.origin) p.set('origin', f.origin);
		if (f.account) p.set('account', f.account);
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

	const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const moduleName = (id: string) => page.data.modules?.find((m: { id: string }) => m.id === id)?.label ?? id;
	const from = (d: Document) => (d.source === 'user' ? (d.added_by ?? 'A user') : moduleName(d.source));
</script>

<div class="toolbar">
	<h1 style="margin:0">Documents</h1>
	<span class="spacer"></span>
	{#if canEdit}<button class="primary" onclick={startImport}>{importing ? 'Close' : '+ Import PDFs'}</button>{/if}
</div>
<p class="muted small">
	Receipts, statements and invoices you import, and PDFs made in Ledger, filed by kind and year. Modules can read them and add
	their own. The files are on the data share and in every backup.
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
			<input type="file" multiple accept="application/pdf,image/png,image/jpeg" onchange={(e) => pick(e.currentTarget.files)} />
			<span><strong>Choose files</strong> or drop them here. PDFs, or PNG and JPEG pictures, up to {Math.round(data.docs.max_bytes / 1024 / 1024)} MB each.</span>
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
									</td>
								</tr>
							{:else}
								<tr>
									<td>
										<a href={d.url} target="_blank" rel="noopener"><strong>{d.title}</strong></a>
										{#if d.origin === 'created'}<span class="badge ok">made in Ledger</span>{/if}
										<div class="muted small">
											{d.path}{#if d.note} · {d.note}{/if}
										</div>
										{#each d.marks as m (m.module)}
											<div class="muted small">{moduleName(m.module)}: {m.status}{m.note ? `, ${m.note}` : ''}</div>
										{/each}
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
