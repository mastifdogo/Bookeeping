<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { api } from '#lib/api/client.ts';
	import { ICONS, arrangeNav, pageTitle } from '#lib/nav.ts';
	import NavIcon from '#lib/components/NavIcon.svelte';
	import { MAIN_ID, MIN_PANE_PX, panes, type Pane } from '#lib/panes.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	async function logout() {
		await api().POST('/auth/logout');
		await invalidateAll();
		await goto('/login');
	}

	// Ledger's pages and running modules, in the order set under Settings → Sidebar.
	let nav = $derived(arrangeNav(data.sidebar, data.modules));
	let visible = $derived(nav.filter((i) => !i.hidden));

	function active(href: string, exact: boolean): boolean {
		const p = page.url.pathname;
		if (exact) return p === href || (href === '/journal' && /^\/journal\/\d+$/.test(p));
		return p === href || p.startsWith(href + '/');
	}

	// Inside a pane (an iframe of Ledger itself): only the page, and tell the
	// window around it where we are so the pane is restored there.
	const embedded = window.self !== window.top && window.parent.location.origin === location.origin;
	afterNavigate(() => {
		if (embedded) window.parent.postMessage({ type: 'ledger-pane', path: location.pathname + location.search }, location.origin);
	});

	// Desktop: the sidebar collapses to an icon rail; the choice is remembered
	// in this browser. Phones: the menu opens from a button in the top bar.
	const STORAGE_KEY = 'ledger.sidebar.collapsed';
	function readCollapsed(): boolean {
		try {
			return localStorage.getItem(STORAGE_KEY) === '1';
		} catch {
			return false;
		}
	}
	let collapsed = $state(readCollapsed());
	let menuOpen = $state(false);

	function toggleCollapsed() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
		} catch {
			// private window or storage blocked: keep it for this page only
		}
	}

	afterNavigate(() => (menuOpen = false));

	// Panes: only on screens wide enough for two.
	const wideQuery = window.matchMedia(`(min-width: ${2 * MIN_PANE_PX + 260}px)`);
	let wide = $state(wideQuery.matches);
	wideQuery.addEventListener('change', (e) => (wide = e.matches));
	let showPanes = $derived(wide && panes.split && !embedded);
	const MAIN_PANE: Pane = { id: MAIN_ID, path: null, weight: 1, order: 0 };
	let shown = $derived(showPanes ? panes.list : [MAIN_PANE]);
	let lastOrder = $derived(Math.max(...shown.map((p) => p.order)));

	let container: HTMLElement | undefined = $state();
	const frames: Record<string, HTMLIFrameElement> = {};
	// An iframe keeps the address it was created with; later navigation inside
	// it is reported by message and saved, without reloading it.
	const firstSrc = new Map<string, string>();
	function srcOf(p: Pane): string {
		if (!firstSrc.has(p.id)) firstSrc.set(p.id, p.path ?? '/');
		return firstSrc.get(p.id)!;
	}

	function onMessage(e: MessageEvent) {
		if (e.origin !== location.origin || e.data?.type !== 'ledger-pane' || typeof e.data.path !== 'string') return;
		const id = Object.keys(frames).find((k) => frames[k]?.contentWindow === e.source);
		if (id) panes.navigated(id, e.data.path);
	}

	// Moving: drag a pane's header onto another pane. While dragging or
	// resizing, iframes ignore the pointer so they don't swallow the events.
	let dragId: string | null = $state(null);
	let busyPointer = $state(false);
	function dragStart(e: DragEvent, id: string) {
		e.dataTransfer?.setData('text/plain', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		setTimeout(() => (dragId = id));
	}
	function drop(e: DragEvent, target: string) {
		if (!dragId) return;
		e.preventDefault();
		panes.move(dragId, target);
		dragId = null;
	}

	// Resizing: drag the edge to the right of a pane.
	function resizeStart(e: PointerEvent, id: string) {
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		busyPointer = true;
		let x = e.clientX;
		const move = (ev: PointerEvent) => {
			panes.resize(id, ev.clientX - x, container?.clientWidth ?? 0);
			x = ev.clientX;
		};
		const up = () => {
			busyPointer = false;
			panes.save();
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}
	function resizeKey(e: KeyboardEvent, id: string) {
		const step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
		if (!step) return;
		e.preventDefault();
		panes.resize(id, step, container?.clientWidth ?? 0);
		panes.save();
	}

	function openHere(p: Pane) {
		const path = p.path ?? '/';
		panes.close(p.id);
		goto(path);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Ledger</title>
</svelte:head>

<svelte:window onmessage={onMessage} />

{#snippet icon(d: string)}
	<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path {d} /></svg>
{/snippet}

{#if embedded}
	<main class="embedded">
		{@render children()}
	</main>
{:else if data.user}
	<div class="shell" class:collapsed class:menu-open={menuOpen} class:split={showPanes}>
		<aside>
			<nav aria-label="Main">
				<div class="top">
					<a class="brand" href="/" title="Ledger"><span class="brand-full">Ledger</span><span class="brand-short">L</span></a>
					<button
						class="icon-button collapse-toggle"
						onclick={toggleCollapsed}
						aria-expanded={!collapsed}
						aria-controls="main-links"
						title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
					>
						{@render icon(ICONS.collapse)}<span class="sr-only">{collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}</span>
					</button>
					<button
						class="icon-button menu-toggle"
						onclick={() => (menuOpen = !menuOpen)}
						aria-expanded={menuOpen}
						aria-controls="main-links"
						title="Menu"
					>
						{@render icon(ICONS.menu)}<span class="sr-only">Menu</span>
					</button>
				</div>
				<div class="links" id="main-links">
					<ul>
						{#each visible as l (l.id)}
							<li>
								<a href={l.href} title={l.label} aria-current={active(l.href, l.exact) ? 'page' : undefined}>
									<NavIcon d={l.icon} fill={l.iconFill} url={l.iconUrl} /><span class="label">{l.label}</span>
								</a>
								{#if wide && !collapsed && !panes.full}
									<button class="icon-button beside" title="Open {l.label} beside" onclick={() => panes.open(l.href)}>
										{@render icon(ICONS.split)}<span class="sr-only">Open {l.label} beside</span>
									</button>
								{/if}
							</li>
						{/each}
					</ul>
					<ul class="bottom">
						<li>
							<a href="/settings" title="Settings" aria-current={active('/settings', false) ? 'page' : undefined}>
								{@render icon(ICONS.settings)}<span class="label">Settings</span>
							</a>
						</li>
						<li>
							<button class="link" onclick={logout} title="Log out ({data.user.username})"
								>{@render icon(ICONS.logout)}<span class="label">Log out</span></button
							>
						</li>
					</ul>
				</div>
			</nav>
		</aside>
		<div class="panes" class:split={showPanes} class:busy={dragId !== null || busyPointer} bind:this={container}>
			{#each shown as p (p.id)}
				{@const title = pageTitle(p.path ?? page.url.pathname, nav)}
				<section
					class="pane"
					class:drop-target={dragId !== null && dragId !== p.id}
					style:order={p.order}
					style:flex-grow={p.weight}
					ondragover={(e) => dragId && e.preventDefault()}
					ondrop={(e) => drop(e, p.id)}
					aria-label={title}
				>
					{#if showPanes}
						<!-- svelte-ignore a11y_no_static_element_interactions (keyboard users close/open panes with the buttons) -->
						<header draggable="true" ondragstart={(e) => dragStart(e, p.id)} ondragend={() => (dragId = null)} title="Drag to move">
							{@render icon(ICONS.grip)}
							<span class="pane-title">{title}</span>
							{#if p.id !== MAIN_ID}
								<button class="icon-button" title="Open here, full width" onclick={() => openHere(p)}>
									{@render icon(ICONS.expand)}<span class="sr-only">Open here</span>
								</button>
								<button class="icon-button" title="Close" onclick={() => panes.close(p.id)}>
									{@render icon(ICONS.close)}<span class="sr-only">Close</span>
								</button>
							{/if}
						</header>
					{/if}
					<div class="pane-body">
						{#if p.id === MAIN_ID}
							<main>
								{@render children()}
							</main>
						{:else}
							<iframe bind:this={frames[p.id]} src={srcOf(p)} {title}></iframe>
						{/if}
					</div>
					{#if showPanes && p.order !== lastOrder}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is the ARIA splitter pattern) -->
						<div
							class="resizer"
							role="separator"
							aria-orientation="vertical"
							aria-label="Resize {title}"
							tabindex="0"
							onpointerdown={(e) => resizeStart(e, p.id)}
							onkeydown={(e) => resizeKey(e, p.id)}
						></div>
					{/if}
				</section>
			{/each}
		</div>
	</div>
{:else}
	<main>
		{@render children()}
	</main>
{/if}

<style>
	.shell {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		min-height: 100vh;
		transition: grid-template-columns 0.15s ease;
	}
	.shell.collapsed {
		grid-template-columns: 3.75rem minmax(0, 1fr);
	}
	aside {
		background: var(--surface);
		border-right: 1px solid var(--border);
		min-width: 0;
	}
	nav {
		position: sticky;
		top: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 100vh;
		padding: 0.75rem 0.5rem;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		padding-bottom: 0.5rem;
	}
	.links {
		display: flex;
		flex-direction: column;
		flex: 1;
		gap: 0.5rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	ul.bottom {
		margin-top: auto;
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
	}
	nav a,
	nav button.link {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		text-align: left;
		color: var(--muted);
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius);
		border-left: 3px solid transparent;
		white-space: nowrap;
	}
	nav a:hover,
	nav button.link:hover {
		color: var(--text);
		background: var(--row-hover);
		text-decoration: none;
	}
	nav a[aria-current='page'] {
		color: var(--text);
		font-weight: 600;
		background: var(--row-hover);
		border-left-color: var(--accent);
	}
	nav a.brand {
		color: var(--text);
		font-weight: 700;
		font-size: 1.1rem;
		border-left: none;
		width: auto;
	}
	nav a.brand:hover {
		background: none;
	}
	.brand-short {
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
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.35rem;
		border: none;
		background: none;
		color: var(--muted);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.icon-button:hover {
		color: var(--text);
		background: var(--row-hover);
	}
	.menu-toggle {
		display: none;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* Collapsed: icons only; names show as tooltips (title). */
	.collapsed .label,
	.collapsed .brand-full {
		display: none;
	}
	.collapsed .brand-short {
		display: inline;
	}
	.collapsed .top {
		flex-direction: column;
	}
	.collapsed nav a,
	.collapsed nav button.link {
		justify-content: center;
		padding-left: 0.4rem;
		padding-right: 0.4rem;
	}
	.collapsed nav a.brand {
		justify-content: center;
	}
	.collapsed .collapse-toggle svg {
		transform: rotate(180deg);
	}

	.shell main {
		margin: 0;
		max-width: 1200px;
		width: 100%;
	}
	main.embedded {
		max-width: none;
		padding-top: 0.75rem;
	}

	/* "Open beside" shows on hover, at the right of each entry. */
	.links li {
		position: relative;
	}
	.beside {
		position: absolute;
		right: 0.2rem;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0;
	}
	.links li:hover .beside,
	.beside:focus-visible {
		opacity: 1;
	}
	.beside svg {
		width: 16px;
		height: 16px;
	}

	/* Panes: full height, side by side, sharing the width by weight. */
	.panes {
		min-width: 0;
	}
	.panes.split {
		display: flex;
		height: 100vh;
		overflow-x: auto;
		gap: 0;
	}
	.panes.split .pane {
		position: relative;
		display: flex;
		flex-direction: column;
		flex-basis: 0;
		min-width: 260px;
		border-right: 1px solid var(--border);
	}
	.panes.split .pane-body {
		flex: 1;
		overflow: auto;
	}
	.panes.split main {
		max-width: none;
	}
	.pane header {
		min-height: 2.4rem;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.4rem 0.3rem 0.6rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		cursor: grab;
		user-select: none;
	}
	.pane header svg {
		width: 16px;
		height: 16px;
	}
	.pane-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		color: var(--text);
		font-size: 0.9rem;
	}
	.pane.drop-target {
		outline: 2px dashed var(--accent);
		outline-offset: -2px;
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--bg);
	}
	.panes.busy iframe {
		pointer-events: none;
	}
	.resizer {
		position: absolute;
		top: 0;
		right: -5px;
		width: 9px;
		height: 100%;
		cursor: col-resize;
		z-index: 2;
		touch-action: none;
	}
	.resizer:hover,
	.resizer:focus-visible {
		background: linear-gradient(to right, transparent 3px, var(--accent) 3px, var(--accent) 6px, transparent 6px);
		outline: none;
	}

	/* Phones: a top bar with a menu button; the collapse setting doesn't apply. */
	@media (max-width: 760px) {
		.shell,
		.shell.collapsed {
			grid-template-columns: minmax(0, 1fr);
			transition: none;
		}
		aside {
			border-right: none;
			border-bottom: 1px solid var(--border);
			position: sticky;
			top: 0;
			z-index: 10;
		}
		nav {
			position: static;
			height: auto;
			padding: 0.5rem 0.75rem;
		}
		.top,
		.collapsed .top {
			flex-direction: row;
			padding-bottom: 0;
		}
		.collapse-toggle {
			display: none;
		}
		.menu-toggle {
			display: inline-flex;
		}
		.links {
			display: none;
		}
		.menu-open .links {
			display: flex;
			padding-top: 0.5rem;
		}
		.collapsed .label,
		.collapsed .brand-full {
			display: inline;
		}
		.collapsed .brand-short {
			display: none;
		}
		.collapsed nav a,
		.collapsed nav button.link {
			justify-content: flex-start;
			padding: 0.45rem 0.6rem;
		}
	}
</style>
