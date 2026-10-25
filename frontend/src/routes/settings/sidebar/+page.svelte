<script lang="ts">
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import { ICONS, arrangeNav, type NavItem } from '#lib/nav.ts';
	import { invalidate } from '$app/navigation';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// A working copy; every change is saved right away.
	let items = $state<NavItem[]>([]);
	$effect.pre(() => {
		items = arrangeNav(data.sidebar, data.modules);
	});
	let error: unknown = $state(null);
	let saving = $state(false);
	let dragIndex: number | null = $state(null);

	async function save(next: NavItem[] | null) {
		error = null;
		saving = true;
		const body = { items: (next ?? []).map((i) => ({ id: i.id, hidden: i.hidden })) };
		if (next) items = next;
		try {
			unwrap(await api().PUT('/settings/sidebar', { body }));
			await invalidate('app:sidebar');
		} catch (e) {
			error = e;
		} finally {
			saving = false;
		}
	}

	function move(from: number, to: number) {
		if (to < 0 || to >= items.length || from === to) return;
		const next = [...items];
		next.splice(to, 0, next.splice(from, 1)[0]!);
		save(next);
	}

	function toggle(i: number) {
		save(items.map((it, j) => (j === i ? { ...it, hidden: !it.hidden } : it)));
	}
</script>

{#snippet icon(d: string)}
	<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path {d} /></svg>
{/snippet}

<p class="muted" style="margin-top:0">
	Choose which pages and modules appear in the sidebar, and in what order: drag them or use the arrows. Hidden pages
	still work from links. Settings and Log out always stay at the bottom. Saved for your user on every device.
</p>

<ErrorNotice {error} />

<div class="card" style="max-width:560px; padding:0.5rem">
	<ul class="order">
		{#each items as item, i (item.id)}
			<li
				class:hidden={item.hidden}
				class:over={dragIndex !== null && dragIndex !== i}
				draggable="true"
				ondragstart={(e) => {
					e.dataTransfer?.setData('text/plain', item.id);
					dragIndex = i;
				}}
				ondragend={() => (dragIndex = null)}
				ondragover={(e) => dragIndex !== null && e.preventDefault()}
				ondrop={(e) => {
					e.preventDefault();
					if (dragIndex !== null) move(dragIndex, i);
					dragIndex = null;
				}}
			>
				<span class="grip" title="Drag to reorder">{@render icon(ICONS.grip)}</span>
				<label>
					<input type="checkbox" checked={!item.hidden} disabled={saving} onchange={() => toggle(i)} />
					{@render icon(item.icon)}
					<span>{item.label}</span>
				</label>
				<span class="badge">{item.kind === 'module' ? 'Module' : 'Bookkeeping'}</span>
				<button class="icon-button" title="Move up" aria-label="Move {item.label} up" disabled={saving || i === 0} onclick={() => move(i, i - 1)}
					>{@render icon(ICONS.up)}</button
				>
				<button
					class="icon-button"
					title="Move down"
					aria-label="Move {item.label} down"
					disabled={saving || i === items.length - 1}
					onclick={() => move(i, i + 1)}>{@render icon(ICONS.down)}</button
				>
			</li>
		{/each}
	</ul>
</div>

<p>
	<button class="button" disabled={saving} onclick={() => save(null)}>Reset to default</button>
	<span class="muted small">Modules you install later appear at the end. Manage modules under <a href="/settings/modules">Modules</a>.</span>
</p>

<style>
	.order {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.order li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.4rem;
		border-radius: var(--radius);
	}
	.order li + li {
		border-top: 1px solid var(--border);
	}
	.order li.over:hover {
		outline: 2px dashed var(--accent);
	}
	.order li.hidden label span {
		color: var(--muted);
		text-decoration: line-through;
	}
	label {
		display: flex;
		flex-direction: row;
		align-items: center;
		font-size: 1rem;
		color: var(--text);
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		cursor: pointer;
		margin: 0;
	}
	label input {
		width: auto;
		margin: 0;
	}
	.grip {
		color: var(--muted);
		cursor: grab;
		display: inline-flex;
	}
	svg {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.icon-button {
		display: inline-flex;
		padding: 0.25rem;
		border: none;
		background: none;
		color: var(--muted);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.icon-button:hover:not(:disabled) {
		color: var(--text);
		background: var(--row-hover);
	}
	.icon-button:disabled {
		opacity: 0.35;
		cursor: default;
	}
</style>
