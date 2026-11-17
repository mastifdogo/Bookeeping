<script lang="ts">
	// The fields to choose a tag: a standard one or another word, which customer
	// or vendor, and for "rate" the quantity, unit and price. Used on an entry's
	// page and for tagging many entries at once.
	import { STANDARD_TAGS, type TagForm } from '#lib/tags.ts';

	let { form = $bindable(), entities, mode = 'set' }: { form: TagForm; entities: { id: number; name: string; is_active: boolean; is_customer: boolean; is_vendor: boolean }[]; mode?: 'set' | 'remove' } = $props();

	let who = $derived(form.tag === 'customer' || form.tag === 'vendor' ? form.tag : null);
	let list = $derived(entities.filter((x) => x.is_active && (who === 'customer' ? x.is_customer : x.is_vendor)));
</script>

<select bind:value={form.tag} aria-label="Tag" style="width:auto">
	{#each STANDARD_TAGS as s (s)}<option value={s}>{s}</option>{/each}
	<option value="">another…</option>
</select>
{#if form.tag === ''}<input bind:value={form.custom} placeholder="a word, e.g. disputed" maxlength="40" pattern="[A-Za-z][A-Za-z0-9_\-]*" required style="width:12rem" aria-label="Tag word" />{/if}
{#if who}
	<select bind:value={form.entity} aria-label="Which {who}" required={mode === 'set'} style="width:auto">
		<option value="" disabled={mode === 'set'}>{mode === 'set' ? `Which ${who}…` : `Any ${who}`}</option>
		{#each list as x (x.id)}<option value={String(x.id)}>{x.name}</option>{/each}
	</select>
{/if}
{#if form.tag === 'rate' && mode === 'set'}
	<input bind:value={form.quantity} inputmode="decimal" placeholder="Quantity, e.g. 7.5" aria-label="Quantity" style="width:9rem" />
	<input bind:value={form.unit} placeholder="Unit, e.g. hours" maxlength="20" aria-label="Unit" style="width:8rem" />
	<input bind:value={form.rate} inputmode="decimal" class="amount" placeholder="Rate per unit" aria-label="Rate per unit" style="width:8rem" />
{/if}
