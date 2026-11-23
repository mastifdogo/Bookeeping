<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { api } from '#lib/api/client.ts';
	import { formatCents } from '#lib/money.ts';
	import { ICONS, arrangeNav, pageTitle, sectionHref } from '#lib/nav.ts';
	import NavIcon from '#lib/components/NavIcon.svelte';
	import RootConsole from '#lib/components/RootConsole.svelte';
	import SearchPalette from '#lib/components/SearchPalette.svelte';
	import NewAccountDialog from '#lib/components/NewAccountDialog.svelte';
	import { requestNewAccount, type NewAccountDefaults } from '#lib/new-account.svelte.ts';
	import { isSearchKey, requestSearch } from '#lib/search-shortcut.ts';
	import { MAIN_ID, MIN_PANE_PX, panes, type Pane } from '#lib/panes.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Root mode: the whole background goes red while it is on.
	$effect(() => {
		document.documentElement.classList.toggle('root', data.user?.root === true);
	});

	// The user's background picture (Settings → UI): it shows around the windows, under a light veil of the page colour.
	$effect(() => {
		const el = document.documentElement;
		const bg = data.background;
		el.classList.toggle('has-bg', !!bg);
		if (bg) {
			el.style.setProperty('--bg-image', `url("/api/v1/settings/background/image?v=${bg.version}")`);
			el.style.setProperty('--bg-dim', `${bg.dim}%`);
		} else {
			el.style.removeProperty('--bg-image');
			el.style.removeProperty('--bg-dim');
		}
	});

	// Root console beside the page: open or closed and its width, remembered on this device.
	let consoleOn = $state(false);
	let consoleWidth = $state(42);
	let consoleDrag = $state(false);
	let consoleBox: HTMLDivElement | undefined = $state();
	$effect(() => {
		try {
			consoleOn = localStorage.getItem('ledger:root-console') === 'open';
			const w = Number(localStorage.getItem('ledger:root-console-width'));
			if (w >= 20 && w <= 75) consoleWidth = w;
		} catch {
			// storage blocked
		}
	});
	function setConsole(on: boolean) {
		consoleOn = on;
		try {
			localStorage.setItem('ledger:root-console', on ? 'open' : 'closed');
		} catch {
			// storage blocked
		}
	}
	function consoleMove(e: PointerEvent) {
		if (!consoleDrag || !consoleBox) return;
		const box = consoleBox.getBoundingClientRect();
		consoleWidth = Math.min(75, Math.max(20, Math.round(((box.right - e.clientX) / box.width) * 1000) / 10));
	}
	function consoleDragEnd() {
		consoleDrag = false;
		try {
			localStorage.setItem('ledger:root-console-width', String(consoleWidth));
		} catch {
			// storage blocked
		}
	}
	let showConsole = $derived(data.user?.root === true && consoleOn);

	async function logout() {
		await api().POST('/auth/logout');
		await invalidateAll();
		await goto('/login');
	}

	// Ledger's pages and running modules, in the order set under Settings → Sidebar.
	let nav = $derived(arrangeNav(data.sidebar, data.modules));
	// Viewers can't post, so no "New entry" for them.
	let visible = $derived(nav.filter((i) => !i.hidden && !(data.user?.role === 'viewer' && i.id === 'core:new-entry')));

	function active(href: string, exact: boolean): boolean {
		const p = page.url.pathname;
		if (exact) return p === href || (href === '/journal' && /^\/journal\/\d+$/.test(p));
		return p === href || p.startsWith(href + '/');
	}

	// Inside a pane (an iframe of Ledger itself): only the page, and tell the
	// window around it where we are so the pane is restored there.
	const embedded = window.self !== window.top && window.parent.location.origin === location.origin;
	if (embedded) document.documentElement.classList.add('in-pane');
	afterNavigate(() => {
		if (embedded) window.parent.postMessage({ type: 'ledger-pane', path: location.pathname + location.search + location.hash }, location.origin);
	});
	// "/" and Ctrl/Cmd+K in a pane open the search of the window around it.
	function embeddedKey(e: KeyboardEvent) {
		if (embedded && isSearchKey(e)) {
			e.preventDefault();
			requestSearch();
		}
	}

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
	// Any window can be closed, the last one too: nothing is drawn in the page area until a page is opened.
	let closed = $state(false);
	afterNavigate(() => (closed = false));
	let shown = $derived(showPanes ? panes.list : closed ? [] : [MAIN_PANE]);
	function closeMain() {
		// With others open, the next window takes this one's place.
		const next = showPanes ? panes.ordered.find((p) => p.id !== MAIN_ID) : undefined;
		if (!next) return void (closed = true);
		const path = next.path ?? '/';
		panes.promote(next.id);
		goto(path);
	}
	// Back: undoes the last change to the windows (a page opened in one, a
	// view opened inside a module's page, a window opened, closed or moved). Kept for this page load only.
	interface WinState {
		key: string;
		path: string;
		closed: boolean;
		panes: Pane[];
	}
	function winState(): WinState {
		// With the part after "#": the view a module's page is on (/apps/sales#/invoices/31).
		const path = page.url.pathname + page.url.search + page.url.hash;
		const list = panes.list.map((p) => ({ ...p }));
		const key = JSON.stringify([path, closed, list.map((p) => [p.id, p.path, p.order])]);
		return { key, path, closed, panes: list };
	}
	let undo = $state<WinState[]>([]);
	let current: WinState | null = null;
	let restoring: string | null = null;
	let lastPush = 0;
	let restoreTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (embedded) return;
		const now = winState();
		if (current && now.key === current.key) {
			current = now; // only sizes changed: keep the latest
			return;
		}
		if (restoring !== null) {
			if (now.key === restoring) restoring = null;
		} else if (current && Date.now() - lastPush > 400) {
			// One step per action: closing a window may also change the page a moment later.
			undo = [...undo.slice(-49), current];
			lastPush = Date.now();
		}
		current = now;
	});
	async function goBack() {
		const prev = undo.at(-1);
		if (!prev) return;
		undo = undo.slice(0, -1);
		restoring = prev.key;
		clearTimeout(restoreTimer);
		restoreTimer = setTimeout(() => (restoring = null), 3000);
		// Windows beside that were closed come back at the page they showed.
		const open = new Map(panes.list.map((p) => [p.id, p]));
		for (const p of prev.panes) {
			const was = open.get(p.id);
			if (!was) firstSrc.delete(p.id);
			else if (p.path && was.path !== p.path) {
				// Only the view inside a module's page differs: "#" alone is its first view, and doesn't reload the window.
				const first = !p.path.includes('#') && was.path?.split('#')[0] === p.path;
				frames[p.id]?.contentWindow?.location.replace(first ? p.path + '#' : p.path);
			}
		}
		panes.list = prev.panes.map((p) => ({ ...p }));
		panes.save();
		if (prev.path !== page.url.pathname + page.url.search + page.url.hash) await goto(prev.path, { reset: prev.path.split('#')[0] !== page.url.pathname + page.url.search });
		closed = prev.closed;
	}

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
		if (e.origin === location.origin && e.data?.type === 'ledger-new-account') return newAccountForFrame(e);
		if (e.origin !== location.origin || e.data?.type !== 'ledger-pane' || typeof e.data.path !== 'string') return;
		const id = Object.keys(frames).find((k) => frames[k]?.contentWindow === e.source);
		if (id) panes.navigated(id, e.data.path);
	}

	// A module's page asks for a new account (e.g. while categorizing):
	//   parent.postMessage({ type: 'ledger-new-account', id, defaults: { name, type, currency, code } }, location.origin)
	// and gets { type: 'ledger-new-account-result', id, account } back (account null if cancelled or not allowed).
	async function newAccountForFrame(e: MessageEvent) {
		const src = e.source as Window | null;
		if (!src) return;
		const reply = (account: unknown) => src.postMessage({ type: 'ledger-new-account-result', id: e.data.id ?? null, account }, location.origin);
		if (!data.user || data.user.role === 'viewer') return reply(null);
		const d = (e.data.defaults && typeof e.data.defaults === 'object' ? e.data.defaults : {}) as Record<string, unknown>;
		const pick = (k: string) => (typeof d[k] === 'string' ? (d[k] as string).slice(0, 1000) : undefined);
		const defaults: NewAccountDefaults = {
			code: pick('code'),
			name: pick('name'),
			type: (['asset', 'liability', 'equity', 'revenue', 'expense'] as const).find((t) => t === d.type),
			currency: (['CAD', 'USD'] as const).find((c) => c === d.currency),
			description: pick('description')
		};
		const account = await requestNewAccount(defaults);
		reply(account ? JSON.parse(JSON.stringify(account)) : null);
		if (account) invalidateAll();
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

	// Each window scrolls on its own, so a new page starts at its top.
	let mainBody: HTMLDivElement | undefined = $state();
	afterNavigate((nav) => {
		if (nav.type !== 'popstate' && !nav.to?.url.hash && mainBody) mainBody.scrollTop = 0;
	});
	// A module's page fills its window edge to edge; the dashboard's tiles stand on their own, without a window around them.
	let flush = $derived(/^\/apps\/[^/]+\/?$/.test(page.url.pathname));
	let bare = $derived(page.url.pathname === '/');

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

<svelte:window onmessage={onMessage} onkeydown={embeddedKey} />

{#snippet icon(d: string)}
	<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path {d} /></svg>
{/snippet}

{#if data.user && !data.user.must_change_password}<NewAccountDialog />{/if}

{#if embedded}
	<main class="embedded" class:flush>
		{@render children()}
	</main>
{:else if data.user && !data.user.must_change_password}
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
					<div class="search-row">
						<button class="icon-button back" onclick={goBack} disabled={undo.length === 0} title="Back: the page, the view in a module or the windows as they were before">
							{@render icon(ICONS.back)}<span class="sr-only">Back</span>
						</button>
						<div class="search"><SearchPalette {nav} isAdmin={data.user.server_admin} {collapsed} /></div>
					</div>
					<ul>
						{#each visible as l (l.id)}
							<li>
								<a href={l.href} title={l.label} aria-current={active(l.href, l.exact) ? 'page' : undefined}>
									<NavIcon d={l.icon} fill={l.iconFill} url={l.iconUrl} /><span class="label">{l.label}</span>
								</a>
								{#if wide && !collapsed && !panes.full}
									<button class="icon-button beside" title="Open {l.label} beside" onclick={() => (closed ? goto(l.href) : panes.open(l.href))}>
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
				{@const at = p.path ?? page.url.pathname + page.url.search + page.url.hash}
				{@const title = pageTitle(at, nav)}
				{@const up = sectionHref(at, nav)}
				<section
					class="pane"
					class:bare={p.id === MAIN_ID && bare && !showPanes}
					class:drop-target={dragId !== null && dragId !== p.id}
					style:order={p.order}
					style:flex-grow={p.weight}
					ondragover={(e) => dragId && e.preventDefault()}
					ondrop={(e) => drop(e, p.id)}
					aria-label={title}
				>
					{#if !embedded}
						<!-- svelte-ignore a11y_no_static_element_interactions (keyboard users close/open panes with the buttons) -->
						<header class:alone={!showPanes} draggable={showPanes ? 'true' : undefined} ondragstart={(e) => showPanes && dragStart(e, p.id)} ondragend={() => (dragId = null)} title={showPanes ? 'Drag to move' : undefined}>
							{#if showPanes}{@render icon(ICONS.grip)}{/if}
							<span class="pane-title">
								{#if up}
									<!-- The title is the way back to the section's first page (the list a record was opened from). -->
									<a
										href={up}
										draggable="false"
										title="Back to {pageTitle(up, nav)}"
										onclick={(e) => {
											if (p.id === MAIN_ID) return;
											e.preventDefault();
											frames[p.id]?.contentWindow?.location.assign(up);
										}}>{title}</a
									>
								{:else}{title}{/if}
							</span>
							{#if p.id !== MAIN_ID}
								<button class="icon-button" title="Open here, full width" onclick={() => openHere(p)}>
									{@render icon(ICONS.expand)}<span class="sr-only">Open here</span>
								</button>
							{/if}
							<button class="icon-button" title="Close" onclick={() => (p.id === MAIN_ID ? closeMain() : panes.close(p.id))}>
								{@render icon(ICONS.close)}<span class="sr-only">Close</span>
							</button>
						</header>
					{/if}
					<div class="pane-body" bind:this={() => (p.id === MAIN_ID ? mainBody : undefined), (el) => p.id === MAIN_ID && (mainBody = el)}>
						{#if p.id === MAIN_ID}
							<main class:with-console={showConsole} class:flush={flush && !showConsole}>
								{#snippet pageBody()}
									{#if data.unreconciled?.length}
										<div class="notice error unrec" role="alert">
											<strong>Danger: unreconciled transactions.</strong>
											{#each data.unreconciled as u, i (u.code)}{i ? '; ' : ' '}{u.line_count} in
												<a href="/accounts/{encodeURIComponent(u.code)}">{u.name}</a> ({formatCents(u.balance_cents)}
												{u.currency}){/each}. Move each to the right account until it is back at zero.
										</div>
									{/if}
									{@render children()}
								{/snippet}
								{#if showConsole}
									<!-- svelte-ignore a11y_no_static_element_interactions (dragging the divider; the console has its own controls) -->
									<div class="console-split" class:dragging={consoleDrag} bind:this={consoleBox} style="--console:{consoleWidth}%" onpointermove={consoleMove} onpointerup={consoleDragEnd}>
										<div class="console-page">{@render pageBody()}</div>
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="console-divider" title="Drag to resize" onpointerdown={(e) => ((consoleDrag = true), (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId))}></div>
										<div class="console-side"><RootConsole onclose={() => setConsole(false)} /></div>
									</div>
								{:else}
									{@render pageBody()}
								{/if}
								{#if data.user?.root && !consoleOn}
									<button class="console-open" onclick={() => setConsole(true)} title="Show the requests and SQL the server runs, beside the page">▤ Console</button>
								{/if}
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
	/* Every window (the sidebar, the page, each pane beside it) is drawn the
	   same way: a rounded panel with a small gap around it, filling the screen. */
	.shell {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		/* One screen-tall row: a long page scrolls inside its window, so the
		   sidebar (Settings and Log out at its foot) always stays in view. */
		grid-template-rows: minmax(0, 1fr);
		gap: var(--win-gap);
		padding: var(--win-gap);
		height: 100vh;
		height: 100dvh;
		transition: grid-template-columns 0.15s ease;
	}
	.shell.collapsed {
		grid-template-columns: 3.75rem minmax(0, 1fr);
	}
	aside {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--win-radius);
		min-width: 0;
		overflow: hidden;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 100%;
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
	/* Back beside the search bar; stacked above it when the sidebar is collapsed. */
	.search-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	/* The arrow sits in the column of the tab icons under it, and the search bar starts where their names do. */
	.search-row .back {
		flex: none;
		padding: 0.45rem 0.45rem 0.45rem 0.6rem;
		border-left: 3px solid transparent;
	}
	.search-row .back:disabled {
		opacity: 0.4;
		cursor: default;
		background: none;
	}
	.search-row .back {
		margin-bottom: 0.4rem;
	}
	.search-row .search {
		flex: 1;
		min-width: 0;
	}
	.collapsed .search-row {
		flex-direction: column;
		align-items: stretch;
	}
	.collapsed .search-row .back {
		align-self: center;
		padding-left: 0.4rem;
		padding-right: 0.4rem;
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
		max-width: none;
		width: 100%;
	}
	/* A module's page: its frame fills the window. */
	main.flush {
		padding: 0;
		height: 100%;
	}
	main.embedded.flush {
		height: 100vh;
	}
	main.with-console {
		max-width: none;
	}
	.console-split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 0.6rem var(--console);
		align-items: start;
	}
	.console-split.dragging {
		user-select: none;
		cursor: col-resize;
	}
	.console-page {
		min-width: 0;
	}
	.console-divider {
		cursor: col-resize;
		align-self: stretch;
		touch-action: none;
	}
	.console-side {
		position: sticky;
		top: 0.5rem;
		height: calc(100vh - 2rem - 2 * var(--win-gap));
	}
	.console-open {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 20;
		background: #0d1117;
		color: #d1d7e0;
		border: 1px solid #30363d;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8rem;
	}
	.unrec {
		margin-bottom: 1rem;
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

	/* Panes: full height, side by side with a gap between, sharing the width by weight. */
	.panes {
		min-width: 0;
		display: flex;
		height: 100%;
		gap: var(--win-gap);
	}
	.panes.split {
		overflow-x: auto;
	}
	.pane {
		position: relative;
		display: flex;
		flex-direction: column;
		flex-basis: 0;
		min-width: 0;
		background: var(--win-bg);
		border: 1px solid var(--border);
		border-radius: var(--win-radius);
	}
	.panes.split .pane {
		min-width: 260px;
	}
	.pane-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		border-radius: inherit;
	}
	.pane header + .pane-body {
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}
	/* The dashboard alone: its tiles are the panels. */
	.pane.bare {
		background: none;
		border-color: transparent;
	}
	.pane.bare main {
		padding: 0 0 1rem;
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
		border-radius: var(--win-radius) var(--win-radius) 0 0;
		color: var(--muted);
		cursor: grab;
		user-select: none;
	}
	/* One window alone: nothing to drag. On the dashboard, whose tiles are the panels, the bar is a panel of its own. */
	.pane header.alone {
		cursor: default;
		padding-left: 0.9rem;
	}
	.pane.bare header {
		border: 1px solid var(--border);
		border-radius: var(--win-radius);
		margin-bottom: var(--win-gap);
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
	.pane-title a {
		color: inherit;
		text-decoration: none;
	}
	.pane-title a:hover {
		text-decoration: underline;
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
		background: transparent;
	}
	.panes.busy iframe {
		pointer-events: none;
	}
	/* The handle sits in the gap between two windows. */
	.resizer {
		position: absolute;
		top: 0;
		right: calc(-1px - var(--win-gap) / 2 - 4.5px);
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
			grid-template-rows: auto minmax(0, 1fr);
			transition: none;
		}
		aside {
			position: relative;
			z-index: 10;
			overflow: visible;
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
