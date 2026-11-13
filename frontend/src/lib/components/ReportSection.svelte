<script lang="ts">
	import type { ReportLine } from '#lib/api/client.ts';
	import Amount from './Amount.svelte';

	// One titled block of a financial statement with a total row.
	let {
		title,
		lines,
		total,
		currency,
		extra
	}: { title: string; lines: ReportLine[]; total: number; currency: string; extra?: { label: string; cents: number } } =
		$props();

	// Lines arrive parent first, then sub-accounts. After the last line under a
	// parent comes that parent's total.
	type Row = { key: string; line: ReportLine; depth: number; total: boolean };
	let rows = $derived.by(() => {
		const out: Row[] = [];
		const open: ReportLine[] = [];
		const close = (toDepth: number) => {
			while (open.length && open.at(-1)!.depth >= toDepth) {
				const p = open.pop()!;
				out.push({ key: `total:${p.account_code}`, line: p, depth: p.depth, total: true });
			}
		};
		for (const l of lines) {
			close(l.depth);
			out.push({ key: l.account_code, line: l, depth: l.depth, total: false });
			if (l.has_children) open.push(l);
		}
		close(0);
		return out;
	});
</script>

<tbody>
	<tr class="heading"><th colspan="2">{title}</th></tr>
	{#each rows as r (r.key)}
		{#if r.total}
			<tr class="subtotal">
				<td style:padding-left="{0.6 + r.depth * 1.25}rem">Total {r.line.account_name}</td>
				<td class="num"><Amount cents={r.line.total_cents} /></td>
			</tr>
		{:else}
			<tr class:parent={r.line.has_children}>
				<td style:padding-left="{0.6 + r.depth * 1.25}rem"
					><a class="mono" href="/accounts/{encodeURIComponent(r.line.account_code)}">{r.line.account_code}</a> {r.line.account_name}</td
				>
				<!-- A parent with nothing posted to itself only heads its sub-accounts. -->
				<td class="num">{#if !(r.line.has_children && r.line.amount_cents === 0)}<Amount cents={r.line.amount_cents} />{/if}</td>
			</tr>
		{/if}
	{/each}
	{#if extra}
		<tr>
			<td><em>{extra.label}</em></td>
			<td class="num"><Amount cents={extra.cents} /></td>
		</tr>
	{/if}
	{#if lines.length === 0 && !extra}
		<tr><td colspan="2" class="muted">None</td></tr>
	{/if}
	<tr class="total">
		<td>Total {title.toLowerCase()}</td>
		<td class="num"><Amount cents={total} {currency} /></td>
	</tr>
</tbody>

<style>
	.heading th {
		background: none;
		font-size: 0.85rem;
		padding-top: 1rem;
		color: var(--text);
	}
	.parent td {
		font-weight: 600;
	}
	.subtotal td {
		font-style: italic;
		border-top: 1px solid var(--border);
	}
	.total td {
		font-weight: 600;
		border-top: 1px solid var(--border);
	}
</style>
