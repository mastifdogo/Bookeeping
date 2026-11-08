<script lang="ts">
	import { page } from '$app/state';
	import { arrangeNav } from '#lib/nav.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Ledger's own tabs; the admin ones only for admins (the API enforces it too).
	const ALL = [
		{ href: '/settings/account', label: 'Account', title: '', admin: false },
		{ href: '/settings/sidebar', label: 'Sidebar', title: '', admin: false },
		{ href: '/settings/users', label: 'Users', title: '', admin: true },
		{ href: '/settings/ai', label: 'AI', title: '', admin: true },
		{ href: '/settings/gmail', label: 'Gmail', title: '', admin: true },
		{ href: '/settings/backups', label: 'Backups', title: '', admin: true },
		{ href: '/settings/import-export', label: 'Import & export', title: '', admin: false },
		{ href: '/settings/modules', label: 'Modules', title: '', admin: true },
		{ href: '/settings/updates', label: 'Updates', title: '', admin: true }
	];
	let isAdmin = $derived(data.user?.server_admin === true);
	// Modules' settings belong to each organization: its admins set them.
	let orgAdmin = $derived(data.user?.role === 'admin');
	let OWN = $derived(ALL.filter((t) => isAdmin || !t.admin));
	// Pages hidden from the sidebar stay reachable here; modules always get a
	// tab of their own (which shows a hidden module's page too).
	let hidden = $derived(arrangeNav(data.sidebar, data.modules).filter((i) => i.hidden && i.kind === 'core'));
	let tabs = $derived([
		...OWN,
		...hidden.map((i) => ({ href: `/settings/page/${i.id.slice(5)}`, label: i.label, title: 'Hidden from the sidebar' })),
		...(orgAdmin ? data.installedModules.map((m) => ({ href: `/settings/m/${m.id}`, label: m.name, title: 'Module' })) : [])
	]);
</script>

<h1>Settings</h1>

<nav class="tabs" aria-label="Settings">
	{#each tabs as t, i (t.href)}
		{#if i === OWN.length || (i > OWN.length && t.title !== tabs[i - 1]!.title)}<span class="sep" aria-hidden="true"></span>{/if}
		<a href={t.href} title={t.title || undefined} aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a>
	{/each}
</nav>

{@render children()}

<style>
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1.25rem;
		overflow-x: auto;
	}
	.sep {
		width: 1px;
		margin: 0.5rem 0.35rem;
		background: var(--border);
		flex: none;
	}
	.tabs a {
		padding: 0.5rem 0.9rem;
		color: var(--muted);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		white-space: nowrap;
	}
	.tabs a:hover {
		color: var(--text);
		text-decoration: none;
	}
	.tabs a[aria-current='page'] {
		color: var(--text);
		font-weight: 600;
		border-bottom-color: var(--accent);
	}
</style>
