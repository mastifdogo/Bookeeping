<script lang="ts">
	// The search bar: a button in the sidebar that opens a search box over the
	// page (also with "/" or Ctrl/Cmd+K). Pages and settings match instantly in
	// the browser; accounts, entries and module results come from /search.
	import { goto } from '$app/navigation';
	import { api } from '#lib/api/client.ts';
	import { ICONS, type NavItem } from '#lib/nav.ts';
	import { tick } from 'svelte';

	let { nav, isAdmin, collapsed = false }: { nav: NavItem[]; isAdmin: boolean; collapsed?: boolean } = $props();

	type Hit = { title: string; subtitle: string; href: string };
	type Group = { label: string; results: Hit[] };

	let open = $state(false);
	let q = $state('');
	let groups = $state<Group[]>([]);
	let loading = $state(false);
	let active = $state(0);
	let input: HTMLInputElement | undefined = $state();

	const PAGES: Hit[] = [
		{ title: 'Balance sheet', subtitle: 'Report', href: '/reports/balance-sheet' },
		{ title: 'Income statement', subtitle: 'Report', href: '/reports/income-statement' },
		{ title: 'Trial balance', subtitle: 'Report', href: '/reports/trial-balance' },
		{ title: 'Account settings, password', subtitle: 'Settings', href: '/settings/account' },
		{ title: 'Sidebar', subtitle: 'Settings', href: '/settings/sidebar' },
		{ title: 'Import & export CSV', subtitle: 'Settings', href: '/settings/import-export' }
	];
	const ADMIN_PAGES: Hit[] = [
		{ title: 'Users and roles', subtitle: 'Settings', href: '/settings/users' },
		{ title: 'AI provider', subtitle: 'Settings', href: '/settings/ai' },
		{ title: 'Gmail', subtitle: 'Settings', href: '/settings/gmail' },
		{ title: 'Backups', subtitle: 'Settings', href: '/settings/backups' },
		{ title: 'Modules', subtitle: 'Settings', href: '/settings/modules' },
		{ title: 'Updates', subtitle: 'Settings', href: '/settings/updates' }
	];

	function pageHits(s: string): Hit[] {
		const n = s.trim().toLowerCase();
		if (!n) return [];
		const all = [...nav.map((i) => ({ title: i.label, subtitle: i.kind === 'module' ? 'Module' : 'Page', href: i.href })), ...PAGES, ...(isAdmin ? ADMIN_PAGES : [])];
		return all.filter((h) => h.title.toLowerCase().includes(n)).slice(0, 6);
	}

	let flat = $derived(groups.flatMap((g) => g.results));

	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;
	function onInput() {
		clearTimeout(timer);
		const s = q;
		const pages = pageHits(s);
		groups = pages.length ? [{ label: 'Pages', results: pages }] : [];
		active = 0;
		if (!s.trim()) {
			loading = false;
			return;
		}
		loading = true;
		const mine = ++seq;
		timer = setTimeout(async () => {
			const res = await api().GET('/search', { params: { query: { q: s } } });
			if (mine !== seq) return; // a newer search is on its way
			loading = false;
			if (!res.data) return;
			groups = [...(pages.length ? [{ label: 'Pages', results: pages }] : []), ...res.data.groups];
		}, 180);
	}

	async function show() {
		open = true;
		await tick();
		input?.focus();
		input?.select();
	}
	function close() {
		open = false;
	}
	function pick(h: Hit | undefined) {
		if (!h) return;
		close();
		q = '';
		groups = [];
		goto(h.href);
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, flat.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(flat[active]);
		} else if (e.key === 'Escape') {
			close();
		}
	}
	// "/" or Ctrl/Cmd+K opens it from anywhere (but "/" not while typing elsewhere).
	function globalKey(e: KeyboardEvent) {
		const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
		if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
			e.preventDefault();
			show();
		}
	}
	const indexOf = (h: Hit) => flat.indexOf(h);
</script>

<svelte:window onkeydown={globalKey} />

<button class="trigger" class:collapsed onclick={show} title="Search (/ or Ctrl+K)" aria-haspopup="dialog">
	<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={ICONS.search} /></svg>
	<span class="label grow">Search</span>
	<kbd class="label">/</kbd>
</button>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Escape closes it; the backdrop click is a convenience) -->
	<div class="backdrop" onclick={close}>
		<div class="palette" role="dialog" aria-modal="true" aria-label="Search" tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<div class="box">
				<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d={ICONS.search} /></svg>
				<input
					bind:this={input}
					bind:value={q}
					oninput={onInput}
					onkeydown={keydown}
					placeholder="Search accounts, entries (text, #number or amount), pages…"
					aria-label="Search"
					aria-controls="search-results"
					aria-activedescendant={flat.length ? `search-hit-${active}` : undefined}
					autocomplete="off"
					spellcheck="false"
				/>
				{#if loading}<span class="muted small">…</span>{/if}
			</div>
			<div class="results" id="search-results" role="listbox">
				{#each groups as g (g.label)}
					<div class="group">{g.label}</div>
					{#each g.results as h (h.href + h.title)}
						{@const i = indexOf(h)}
						<a
							id="search-hit-{i}"
							role="option"
							aria-selected={i === active}
							class:active={i === active}
							href={h.href}
							onclick={(e) => {
								e.preventDefault();
								pick(h);
							}}
							onmousemove={() => (active = i)}
						>
							<span class="title">{h.title}</span>
							{#if h.subtitle}<span class="sub">{h.subtitle}</span>{/if}
						</a>
					{/each}
				{:else}
					{#if q.trim() && !loading}<div class="empty small">Nothing found for “{q.trim()}”.</div>{/if}
					{#if !q.trim()}<div class="empty small">Type to search. Tip: <kbd>#12</kbd> finds entry 12, <kbd>45.00</kbd> finds that amount.</div>{/if}
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.trigger {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.4rem 0.6rem;
		margin-bottom: 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--muted);
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	.trigger:hover {
		color: var(--text);
	}
	.trigger .grow {
		flex: 1;
	}
	.trigger.collapsed {
		justify-content: center;
		border-color: transparent;
		background: none;
	}
	.trigger.collapsed .label {
		display: none;
	}
	svg {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	kbd {
		font: 0.75rem ui-monospace, monospace;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0 0.35rem;
		color: var(--muted);
	}
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgb(0 0 0 / 0.35);
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: 10vh 16px 0;
	}
	.palette {
		width: min(640px, 100%);
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
		overflow: hidden;
	}
	.box {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.9rem;
		border-bottom: 1px solid var(--border);
		color: var(--muted);
	}
	.box input {
		flex: 1;
		border: none;
		outline: none;
		background: transparent;
		font-size: 1.05rem;
		color: var(--text);
		padding: 0.2rem 0;
	}
	.results {
		overflow-y: auto;
		padding: 0.3rem;
	}
	.group {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		padding: 0.6rem 0.6rem 0.25rem;
	}
	.results a {
		display: flex;
		flex-direction: column;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
	}
	.results a.active {
		background: var(--row-hover);
		box-shadow: inset 3px 0 var(--accent);
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 0.8rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		padding: 0.9rem;
		color: var(--muted);
	}
</style>
