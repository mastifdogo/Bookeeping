<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { api } from '#lib/api/client.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	async function logout() {
		await api().POST('/auth/logout');
		await invalidateAll();
		await goto('/login');
	}

	// Icons are 24x24 stroked paths.
	const ICONS = {
		dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
		journal: 'M4 5h16M4 12h16M4 19h10',
		new: 'M12 5v14M5 12h14',
		accounts: 'M3 6h6l2 2h10v11H3z',
		reports: 'M5 20V10M12 20V4M19 20v-7',
		files: 'M6 3h8l4 4v14H6zM14 3v4h4',
		updates: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
		user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
		logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
		collapse: 'M15 6l-6 6 6 6',
		module: 'M9 3h6v3a2 2 0 1 0 4 0V5h2v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H3v-6h3a2 2 0 1 0 0-4H3V5h6z',
		modules: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7',
		menu: 'M4 6h16M4 12h16M4 18h16'
	} as const;

	// Icons modules can name in their manifest's nav.icon (docs/MODULES.md).
	const MODULE_ICONS: Record<string, string> = {
		hammer: 'M15 12l-8.4 8.4a1 1 0 1 1-3-3L12 9M18 15l4-4M21.5 11.5l-1.9-1.9A2 2 0 0 1 19 8.2V7l-2.3-2.3a6 6 0 0 0-4.2-1.7L9 3l.9.8A6.2 6.2 0 0 1 12 8.4V10l2 2h1.2a2 2 0 0 1 1.4.6l1.9 1.9',
		invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
		cart: 'M3 4h2l2.5 11h11L21 7H6.2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01',
		chart: 'M4 20h16M7 16V11M12 16V6M17 16v-3',
		users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a7 7 0 0 1 4 7',
		mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
		calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
		box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
		dollar: 'M12 2v20M17 6.5C17 4.6 14.8 4 12 4S7 5 7 7.5 9.5 10.5 12 11s5 1.5 5 4-2.2 3.5-5 3.5-5-.9-5-3',
		wrench: 'M14.7 6.3a4 4 0 0 0 5 5L22 14l-3 3-2.4-2.3a4 4 0 0 0-5-5L4 17.3a2 2 0 1 0 2.8 2.8l7.6-7.6'
	};
	const moduleIcon = (name: string | null) => (name && MODULE_ICONS[name]) || ICONS.module;

	const links = [
		{ href: '/', label: 'Dashboard', exact: true, icon: ICONS.dashboard },
		{ href: '/journal', label: 'Journal', exact: true, icon: ICONS.journal },
		{ href: '/journal/new', label: 'New entry', exact: true, icon: ICONS.new },
		{ href: '/accounts', label: 'Accounts', exact: false, icon: ICONS.accounts },
		{ href: '/reports', label: 'Reports', exact: false, icon: ICONS.reports },
		{ href: '/files', label: 'Files', exact: false, icon: ICONS.files }
	];

	function active(href: string, exact: boolean): boolean {
		const p = page.url.pathname;
		if (exact) return p === href || (href === '/journal' && /^\/journal\/\d+$/.test(p));
		return p === href || p.startsWith(href + '/');
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
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Ledger</title>
</svelte:head>

{#snippet icon(d: string)}
	<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path {d} /></svg>
{/snippet}

{#if data.user}
	<div class="shell" class:collapsed class:menu-open={menuOpen}>
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
						{#each links as l (l.href)}
							<li>
								<a href={l.href} title={l.label} aria-current={active(l.href, l.exact) ? 'page' : undefined}>
									{@render icon(l.icon)}<span class="label">{l.label}</span>
								</a>
							</li>
						{/each}
						{#each data.modules as mod (mod.id)}
							<li>
								<a href="/apps/{mod.id}" title={mod.label} aria-current={active('/apps/' + mod.id, false) ? 'page' : undefined}>
									{@render icon(moduleIcon(mod.icon))}<span class="label">{mod.label}</span>
								</a>
							</li>
						{/each}
					</ul>
					<ul class="bottom">
						<li>
							<a href="/modules" title="Modules" aria-current={active('/modules', true) ? 'page' : undefined}>
								{@render icon(ICONS.modules)}<span class="label">Modules</span>
							</a>
						</li>
						<li>
							<a href="/system" title="Updates" aria-current={active('/system', true) ? 'page' : undefined}>
								{@render icon(ICONS.updates)}<span class="label">Updates</span>
							</a>
						</li>
						<li>
							<a href="/settings" title="Account settings ({data.user.username})" aria-current={active('/settings', true) ? 'page' : undefined}>
								{@render icon(ICONS.user)}<span class="label">{data.user.username}</span>
							</a>
						</li>
						<li>
							<button class="link" onclick={logout} title="Log out">{@render icon(ICONS.logout)}<span class="label">Log out</span></button>
						</li>
					</ul>
				</div>
			</nav>
		</aside>
		<main>
			{@render children()}
		</main>
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
