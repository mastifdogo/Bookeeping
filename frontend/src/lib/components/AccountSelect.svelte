<script lang="ts">
	// An account dropdown with "+ New account…" at the end: it opens the new
	// account dialog over the page, then selects the account it created.
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { Account } from '#lib/api/client.ts';
	import { requestNewAccount, type NewAccountDefaults } from '#lib/new-account.svelte.ts';

	let {
		value = $bindable(''),
		accounts,
		placeholder = 'Choose account…',
		label,
		required = false,
		invalid = false,
		defaults = {},
		style = 'width:100%'
	}: {
		value?: string;
		accounts: (Pick<Account, 'code' | 'name' | 'currency'> & { kind?: Account['kind'] })[];
		placeholder?: string;
		label: string;
		required?: boolean;
		invalid?: boolean;
		defaults?: NewAccountDefaults;
		style?: string;
	} = $props();

	const NEW = '\u0000new';
	// Bank and credit card accounts come first in every list, then the rest in the order given.
	const isBank = (a: { kind?: Account['kind'] }) => a.kind === 'chequing' || a.kind === 'savings' || a.kind === 'credit_card';
	let listed = $derived([...accounts.filter(isBank), ...accounts.filter((a) => !isBank(a))]);
	// Viewers can't create accounts.
	let canCreate = $derived(page.data.user != null && page.data.user.role !== 'viewer');

	async function change(e: Event & { currentTarget: HTMLSelectElement }) {
		const sel = e.currentTarget;
		if (sel.value !== NEW) {
			value = sel.value;
			return;
		}
		sel.value = value; // keep the old choice until the account exists
		const created = await requestNewAccount(defaults);
		if (!created) return;
		await invalidateAll(); // the page's account list now has it
		value = created.code;
	}
</script>

<select {value} onchange={change} aria-label={label} {required} {style} aria-invalid={invalid ? 'true' : undefined}>
	<option value="" disabled={required}>{placeholder}</option>
	{#each listed as a (a.code)}<option value={a.code}>{a.code} — {a.name} ({a.currency})</option>{/each}
	{#if canCreate}<option value={NEW}>+ New account…</option>{/if}
</select>
