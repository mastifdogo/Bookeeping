<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import DashboardLayoutEditor from '#lib/components/DashboardLayoutEditor.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Wallpaper = { id: string; thumb: string; resolution: string; url: string };
	const SORTS = [
		{ value: 'toplist', label: 'Most liked' },
		{ value: 'relevance', label: 'Best match' },
		{ value: 'date_added', label: 'Newest' },
		{ value: 'views', label: 'Most viewed' },
		{ value: 'random', label: 'Random' }
	] as const;

	let current = $derived(page.data.background as { id: string; resolution: string; url: string; dim: number; version: number } | null);
	let q = $state('');
	let sorting = $state<(typeof SORTS)[number]['value']>('toplist');
	let results = $state<Wallpaper[]>([]);
	let pageNo = $state(1);
	let lastPage = $state(1);
	let searched = $state(false);
	let busy = $state('');
	let error: unknown = $state(null);
	let dim = $state(70);
	$effect.pre(() => {
		dim = current?.dim ?? 70;
	});

	async function run(what: string, fn: () => Promise<void>) {
		error = null;
		busy = what;
		try {
			await fn();
		} catch (e) {
			error = e;
		} finally {
			busy = '';
		}
	}

	const search = (to = 1) =>
		run('search', async () => {
			const r = unwrap(await api().GET('/wallhaven/search', { params: { query: { q: q.trim() || undefined, page: to, sorting } } }));
			results = r.data;
			pageNo = r.page;
			lastPage = r.last_page;
			searched = true;
		});
	const choose = (w: Wallpaper) =>
		run(w.id, async () => {
			unwrap(await api().PUT('/settings/background', { body: { id: w.id, dim } }));
			await invalidate('app:background');
		});
	const saveDim = () =>
		run('dim', async () => {
			unwrap(await api().PUT('/settings/background', { body: { dim } }));
			await invalidate('app:background');
		});
	const remove = () =>
		run('remove', async () => {
			const res = await api().DELETE('/settings/background');
			if (res.response.status !== 204) unwrap(res);
			await invalidate('app:background');
		});
</script>

<p class="muted" style="margin-top:0">How Ledger looks for you: the dashboard's tiles and a background picture. Both are yours alone.</p>

<DashboardLayoutEditor saved={data.layout} />

<h2>Background</h2>
<p class="muted" style="margin-top:0">
	A picture behind Ledger's pages, from <a href="https://wallhaven.cc" target="_blank" rel="noopener">Wallhaven</a>. It is yours alone: each person
	chooses their own. The server downloads the picture you choose and keeps it, so it loads from Ledger, not from Wallhaven. Only
	safe-for-work pictures are offered.
</p>
<ErrorNotice {error} />

{#if current}
	<section class="card">
		<h2 style="margin-top:0">Your background</h2>
		<div class="toolbar" style="margin:0; align-items:center">
			<img class="now" src="/api/v1/settings/background/image?v={current.version}" alt="Your background" />
			<div style="flex:1; min-width:14rem">
				<label>
					How much the page colour mutes it: {dim}%
					<input type="range" min="0" max="95" step="5" bind:value={dim} onchange={saveDim} style="width:100%" />
				</label>
				<p class="muted small" style="margin:0.3rem 0 0">
					The picture shows around the windows, which stay solid. Higher is calmer; lower shows more of the picture.
					{#if current.url}<a href={current.url} target="_blank" rel="noopener">The picture on Wallhaven</a>{/if}
					{#if current.resolution}({current.resolution}){/if}
				</p>
			</div>
			<button disabled={busy !== ''} onclick={remove}>Remove background</button>
		</div>
	</section>
{/if}

<form
	class="card toolbar"
	style="align-items:flex-end"
	onsubmit={(e) => {
		e.preventDefault();
		search(1);
	}}
>
	<label style="flex:1; min-width:14rem">Search <input bind:value={q} placeholder="mountains, forest, minimal, city at night…" maxlength="200" /></label>
	<label>
		Order
		<select bind:value={sorting} style="width:auto">{#each SORTS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}</select>
	</label>
	<button class="primary" disabled={busy !== ''}>{busy === 'search' ? 'Searching…' : q.trim() ? 'Search' : 'Show pictures'}</button>
</form>

{#if searched && results.length === 0}
	<div class="empty">No pictures found. Try other words.</div>
{/if}
<div class="grid">
	{#each results as w (w.id)}
		<button class="pick" class:on={current?.id === w.id} disabled={busy !== ''} onclick={() => choose(w)} title="Use this picture ({w.resolution})">
			<img src={w.thumb} alt="Wallhaven picture {w.id}" loading="lazy" referrerpolicy="no-referrer" />
			<span>{busy === w.id ? 'Downloading…' : current?.id === w.id ? 'In use' : w.resolution}</span>
		</button>
	{/each}
</div>
{#if searched && lastPage > 1}
	<div class="toolbar" style="justify-content:center">
		<button disabled={busy !== '' || pageNo <= 1} onclick={() => search(pageNo - 1)}>← Previous</button>
		<span class="muted small">Page {pageNo} of {lastPage}</span>
		<button disabled={busy !== '' || pageNo >= lastPage} onclick={() => search(pageNo + 1)}>Next →</button>
	</div>
{/if}

<style>
	.now {
		width: 12rem;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	.pick {
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		cursor: pointer;
	}
	.pick.on {
		outline: 3px solid var(--accent);
	}
	.pick img {
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		display: block;
	}
	.pick span {
		padding: 0.3rem 0.5rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
</style>
