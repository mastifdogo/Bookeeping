<script lang="ts">
	// Settings → UI: where each dashboard tile goes and how big it is. Drag a
	// tile to move it, drag its corner to resize it; the numbers do the same
	// from the keyboard. Saved for this user only.
	import { invalidate } from '$app/navigation';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import { COLUMNS, TILE_LABELS, clamp, completeLayout, standardLayout, type Tile } from '#lib/dashboard-layout.ts';

	let { saved }: { saved: Tile[] } = $props();

	let tiles = $state<Tile[]>([]);
	let custom = $state(false);
	$effect.pre(() => {
		tiles = completeLayout(saved);
		custom = saved.length > 0;
	});
	let dirty = $state(false);
	let busy = $state(false);
	let done = $state('');
	let error: unknown = $state(null);
	let grid: HTMLDivElement | undefined = $state();

	let rows = $derived(Math.max(12, ...tiles.map((t) => t.y + t.h)) + 2);

	function set(i: number, patch: Partial<Tile>) {
		tiles[i] = clamp({ ...tiles[i]!, ...patch });
		dirty = true;
		done = '';
	}

	// Dragging: the pointer's movement in whole grid cells.
	function drag(e: PointerEvent, i: number, mode: 'move' | 'size') {
		if (!grid || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const box = grid.getBoundingClientRect();
		const cw = box.width / COLUMNS;
		const rh = box.height / rows;
		const start = { ...tiles[i]! };
		const x0 = e.clientX;
		const y0 = e.clientY;
		const move = (ev: PointerEvent) => {
			const dx = Math.round((ev.clientX - x0) / cw);
			const dy = Math.round((ev.clientY - y0) / rh);
			set(i, mode === 'move' ? { x: start.x + dx, y: start.y + dy } : { w: start.w + dx, h: start.h + dy });
		};
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	async function save(list: Tile[]) {
		error = null;
		busy = true;
		try {
			unwrap(await api().PUT('/settings/dashboard-layout', { body: { tiles: list } }));
			await invalidate('app:dashboard-layout');
			dirty = false;
			custom = list.length > 0;
			done = list.length ? 'Saved. The dashboard uses this layout now.' : 'Back to the standard layout.';
		} catch (e) {
			error = e;
		} finally {
			busy = false;
		}
	}

	function reset() {
		tiles = standardLayout();
		save([]);
	}

	const overlaps = (a: Tile, b: Tile) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	let clashes = $derived(
		tiles.filter((a, i) => !a.hidden && tiles.some((b, j) => j !== i && !b.hidden && overlaps(a, b))).map((t) => t.id)
	);
</script>

<section class="card">
	<h2 style="margin-top:0">Dashboard tiles</h2>
	<p class="muted small" style="margin-top:0">
		Drag a tile to move it, or its corner to resize it. The dashboard is {COLUMNS} columns wide; a tile taller than its content
		leaves space, a shorter one scrolls. In a narrow window the tiles stack, top to bottom. A currency's summary only shows when
		there is an account in it.
	</p>
	<ErrorNotice {error} />
	{#if done}<div class="notice ok">{done}</div>{/if}

	<div class="grid-edit" bind:this={grid} style="--rows:{rows}">
		{#each tiles as t, i (t.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions (the numbers below do the same from the keyboard) -->
			<div
				class="tile"
				class:hidden={t.hidden}
				class:clash={clashes.includes(t.id)}
				style="grid-column:{t.x} / span {t.w};grid-row:{t.y} / span {t.h}"
				onpointerdown={(e) => drag(e, i, 'move')}
				title="Drag to move"
			>
				<span class="name">{TILE_LABELS[t.id]}</span>
				<span class="dims">{t.w}×{t.h}{t.hidden ? ' · hidden' : ''}</span>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span class="corner" title="Drag to resize" onpointerdown={(e) => drag(e, i, 'size')}></span>
			</div>
		{/each}
	</div>
	{#if clashes.length}<p class="small warn-text">Some tiles overlap; the later one is drawn on top. Move them apart before saving.</p>{/if}

	<div class="table-wrap" style="margin-top:0.75rem">
		<table>
			<thead><tr><th>Tile</th><th class="num">Column</th><th class="num">Row</th><th class="num">Width</th><th class="num">Height</th><th>Show</th></tr></thead>
			<tbody>
				{#each tiles as t, i (t.id)}
					<tr>
						<td>{TILE_LABELS[t.id]}</td>
						<td class="num"><input type="number" min="1" max={COLUMNS - t.w + 1} value={t.x} onchange={(e) => set(i, { x: +e.currentTarget.value })} aria-label="{TILE_LABELS[t.id]} column" /></td>
						<td class="num"><input type="number" min="1" max="60" value={t.y} onchange={(e) => set(i, { y: +e.currentTarget.value })} aria-label="{TILE_LABELS[t.id]} row" /></td>
						<td class="num"><input type="number" min="1" max={COLUMNS} value={t.w} onchange={(e) => set(i, { w: +e.currentTarget.value })} aria-label="{TILE_LABELS[t.id]} width" /></td>
						<td class="num"><input type="number" min="1" max="30" value={t.h} onchange={(e) => set(i, { h: +e.currentTarget.value })} aria-label="{TILE_LABELS[t.id]} height" /></td>
						<td><input type="checkbox" checked={!t.hidden} onchange={(e) => set(i, { hidden: !e.currentTarget.checked })} aria-label="Show {TILE_LABELS[t.id]}" /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="toolbar" style="margin:0.75rem 0 0">
		<button class="primary" disabled={busy || !dirty || clashes.length > 0} onclick={() => save(tiles.map((t) => ({ ...t })))}>Save layout</button>
		<button disabled={busy || (!custom && !dirty)} onclick={reset}>Standard layout</button>
		{#if dirty}<span class="muted small">Not saved yet.</span>{/if}
	</div>
</section>

<style>
	.grid-edit {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		grid-template-rows: repeat(var(--rows), 1.6rem);
		gap: 3px;
		padding: 3px;
		border-radius: var(--win-radius);
		background:
			repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px calc((100% - 6px) / 12)),
			var(--bg);
		border: 1px solid var(--border);
		user-select: none;
		touch-action: none;
	}
	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: 0.1rem;
		min-width: 0;
		overflow: hidden;
		background: var(--surface);
		border: 1px solid var(--accent);
		border-radius: var(--win-radius);
		cursor: grab;
		text-align: center;
		padding: 0.2rem;
	}
	.tile.hidden {
		opacity: 0.45;
		border-style: dashed;
	}
	.tile.clash {
		border-color: var(--danger);
		background: var(--danger-bg);
	}
	.name {
		font-weight: 600;
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.dims {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.corner {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
		background: linear-gradient(135deg, transparent 50%, var(--accent) 50%);
		border-bottom-right-radius: var(--win-radius);
	}
	td input[type='number'] {
		width: 4.5rem;
		text-align: right;
	}
	.warn-text {
		color: var(--warn);
	}
</style>
