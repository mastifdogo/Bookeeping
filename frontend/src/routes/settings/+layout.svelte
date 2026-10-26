<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Ledger's own tabs, then one per module that has settings.
	let tabs = $derived([
		{ href: '/settings/account', label: 'Account' },
		{ href: '/settings/sidebar', label: 'Sidebar' },
		{ href: '/settings/backups', label: 'Backups' },
		{ href: '/settings/import-export', label: 'Import & export' },
		{ href: '/settings/modules', label: 'Modules' },
		{ href: '/settings/updates', label: 'Updates' },
		...data.moduleSettings.map((m) => ({ href: `/settings/m/${m.id}`, label: m.name }))
	]);
</script>

<h1>Settings</h1>

<nav class="tabs" aria-label="Settings">
	{#each tabs as t, i (t.href)}
		{#if i === 6}<span class="sep" aria-hidden="true"></span>{/if}
		<a href={t.href} aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a>
	{/each}
</nav>

{@render children()}

<style>
	.tabs {
		display: flex;
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
