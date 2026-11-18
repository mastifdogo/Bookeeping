<script lang="ts">
	// Chooses the statement a reconciliation is checked against: one already
	// under Documents, or a file (PDF, picture, CSV, OFX) imported on the spot (filed as a statement).
	import { api, unwrap, type Document } from '#lib/api/client.ts';

	// accountCode: only that account's statements are offered, plus those not yet given an account.
	// Statements already reconciled against are left out: each is reconciled once.
	let {
		value = $bindable(null),
		statements,
		accountCode = '',
		disabled = false,
		onerror
	}: { value: number | null; statements: Document[]; accountCode?: string; disabled?: boolean; onerror?: (e: unknown) => void } = $props();

	let added = $state<Document[]>([]);
	let all = $derived(
		[...added, ...statements.filter((s) => !added.some((a) => a.id === s.id))].filter((s) => !s.reconciled && (!accountCode || s.account_code === null || s.account_code === accountCode))
	);
	// A statement of another account doesn't stay chosen when the account changes.
	$effect(() => {
		if (value !== null && !all.some((s) => s.id === value)) value = null;
	});
	let uploading = $state(false);

	async function upload(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		uploading = true;
		try {
			const res = await api().POST('/documents', {
				// The generated type wants a string for the file; the form sends the file itself.
				body: { file, kind: 'statement', ...(accountCode ? { account_code: accountCode } : {}) } as never,
				bodySerializer: (b: Record<string, unknown>) => {
					const fd = new FormData();
					for (const [k, v] of Object.entries(b)) fd.append(k, v as string | Blob);
					return fd;
				}
			});
			const doc = unwrap(res);
			added = [doc, ...added];
			value = doc.id;
		} catch (err) {
			// The same file is already under Documents: choose that one.
			const m = /\(document (\d+)\)/.exec(err instanceof Error ? err.message : '');
			const known = m && all.find((d) => d.id === Number(m[1]));
			if (known) value = known.id;
			else onerror?.(err);
		} finally {
			uploading = false;
		}
	}
</script>

<span class="picker">
	<select bind:value disabled={disabled || uploading} aria-label="Statement">
		<option value={null}>(no statement)</option>
		{#each all as s (s.id)}<option value={s.id}>{s.title}{s.doc_date ? ` · ${s.doc_date}` : ''}{s.account_code ? '' : ' · no account yet'}</option>{/each}
	</select>
	<label class="button" class:busy={uploading}>
		{uploading ? 'Importing…' : 'Import a statement…'}
		<input type="file" accept="application/pdf,image/png,image/jpeg,.csv,.ofx,.qfx,text/csv" onchange={upload} disabled={disabled || uploading} />
	</label>
</span>

<style>
	.picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	select {
		width: auto;
		max-width: 22rem;
		flex: 1;
		min-width: 10rem;
	}
	.button {
		display: inline-flex;
		flex-direction: row;
		align-items: center;
		font-size: inherit;
		cursor: pointer;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.4rem 0.75rem;
		background: var(--surface);
		color: var(--text);
		font-weight: 400;
		white-space: nowrap;
	}
	.button.busy {
		opacity: 0.6;
	}
	.button input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}
</style>
