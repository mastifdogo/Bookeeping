<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '#lib/api/client.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	async function logout() {
		await api().POST('/auth/logout');
		await invalidateAll();
		await goto('/login');
	}

	const links = [
		{ href: '/', label: 'Dashboard', exact: true },
		{ href: '/journal', label: 'Journal', exact: true },
		{ href: '/journal/new', label: 'New entry', exact: true },
		{ href: '/accounts', label: 'Accounts', exact: false },
		{ href: '/reports', label: 'Reports', exact: false },
		{ href: '/files', label: 'Files', exact: false }
	];

	function active(href: string, exact: boolean): boolean {
		const p = page.url.pathname;
		if (exact) return p === href || (href === '/journal' && /^\/journal\/\d+$/.test(p));
		return p === href || p.startsWith(href + '/');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Ledger</title>
</svelte:head>

{#if data.user}
	<div class="shell">
		<aside>
			<nav aria-label="Main">
				<a class="brand" href="/">Ledger</a>
				<ul>
					{#each links as l (l.href)}
						<li><a href={l.href} aria-current={active(l.href, l.exact) ? 'page' : undefined}>{l.label}</a></li>
					{/each}
				</ul>
				<ul class="bottom">
					<li><a href="/system" aria-current={active('/system', true) ? 'page' : undefined}>Updates</a></li>
					<li>
						<a href="/settings" aria-current={active('/settings', true) ? 'page' : undefined} title="Account settings">{data.user.username}</a>
					</li>
					<li><button class="link" onclick={logout}>Log out</button></li>
				</ul>
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
	}
	aside {
		background: var(--surface);
		border-right: 1px solid var(--border);
	}
	nav {
		position: sticky;
		top: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 100vh;
		padding: 1rem 0.75rem;
		overflow-y: auto;
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
		display: block;
		width: 100%;
		text-align: left;
		color: var(--muted);
		padding: 0.45rem 0.75rem;
		border-radius: var(--radius);
		border-left: 3px solid transparent;
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
		padding-bottom: 0.75rem;
	}
	nav a.brand:hover {
		background: none;
	}
	.shell main {
		margin: 0;
		max-width: 1200px;
		width: 100%;
	}

	/* Narrow screens: the sidebar becomes a bar across the top. */
	@media (max-width: 760px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
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
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
			padding: 0.5rem 0.75rem;
		}
		ul,
		ul.bottom {
			flex-direction: row;
			flex-wrap: wrap;
			margin: 0;
			border: none;
			padding: 0;
		}
		ul.bottom {
			margin-left: auto;
		}
		nav a,
		nav button.link {
			padding: 0.35rem 0.5rem;
			border-left: none;
		}
		nav a.brand {
			padding-bottom: 0.35rem;
		}
	}
</style>
