<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { ACCOUNT_TYPES, CURRENCIES, api, unwrap, type Account, type AccountType, type Currency } from '#lib/api/client.ts';
	import { newAccount, suggestCode } from '#lib/new-account.svelte.ts';

	let dlg: HTMLDialogElement | undefined = $state();
	let code = $state('');
	let name = $state('');
	let type = $state<AccountType>('expense');
	let currency = $state<Currency>('CAD');
	let description = $state('');
	let existing = $state<Account[]>([]);
	let codeTouched = $state(false);
	let saving = $state(false);
	let error: unknown = $state(null);
	let nameInput: HTMLInputElement | undefined = $state();

	// Opens whenever someone asks for a new account.
	$effect(() => {
		const req = newAccount.req;
		if (!req || !dlg || dlg.open) return;
		const d = req.defaults;
		name = d.name ?? '';
		type = d.type ?? 'expense';
		currency = d.currency ?? 'CAD';
		description = d.description ?? '';
		code = d.code ?? '';
		codeTouched = d.code !== undefined;
		error = null;
		dlg.showModal();
		nameInput?.focus();
		api()
			.GET('/accounts', { params: { query: { include_inactive: true } } })
			.then((r) => {
				existing = r.data?.data ?? [];
				if (!codeTouched) code = suggestCode(existing, type);
			});
	});

	function changeType() {
		if (!codeTouched) code = suggestCode(existing, type);
	}

	function finish(a: Account | null) {
		const req = newAccount.req;
		newAccount.req = null;
		if (dlg?.open) dlg.close();
		req?.resolve(a);
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		e.stopPropagation(); // never submit a form on the page behind
		saving = true;
		error = null;
		try {
			finish(unwrap(await api().POST('/accounts', { body: { code, name, type, currency, description } })));
		} catch (err) {
			error = err;
		} finally {
			saving = false;
		}
	}
</script>

<dialog bind:this={dlg} class="new-account" aria-labelledby="new-account-title" oncancel={(e) => (e.preventDefault(), finish(null))}>
	<form onsubmit={save}>
		<h2 id="new-account-title">New account</h2>
		<ErrorNotice {error} />
		<label>Name <input bind:this={nameInput} bind:value={name} required maxlength="200" placeholder="e.g. Office supplies" /></label>
		<div class="row">
			<label>
				Type
				<select bind:value={type} onchange={changeType}>{#each ACCOUNT_TYPES as t (t)}<option value={t}>{t}</option>{/each}</select>
			</label>
			<label>
				Currency
				<select bind:value={currency}>{#each CURRENCIES as c (c)}<option value={c}>{c}</option>{/each}</select>
			</label>
			<label>
				Code
				<input bind:value={code} oninput={() => (codeTouched = true)} required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" class="mono" style="width:7rem" />
			</label>
		</div>
		<label>Description <input bind:value={description} maxlength="1000" placeholder="Optional" /></label>
		<div class="buttons">
			<button type="button" onclick={() => finish(null)} disabled={saving}>Cancel</button>
			<button class="primary" disabled={saving}>{saving ? 'Creating…' : 'Create account'}</button>
		</div>
	</form>
</dialog>

<style>
	dialog.new-account {
		width: min(30rem, calc(100vw - 2rem));
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.25rem;
		background: var(--surface, var(--bg));
		color: var(--text);
	}
	dialog.new-account::backdrop {
		background: rgb(0 0 0 / 0.35);
	}
	h2 {
		margin: 0 0 0.75rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.row select {
		width: auto;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
