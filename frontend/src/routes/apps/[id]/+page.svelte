<script lang="ts">
	import { page } from '$app/state';
	import { forwardSearchKeys } from '#lib/search-shortcut.ts';

	const id = $derived(page.params.id ?? '');
	const mod = $derived(page.data.modules?.find((m: { id: string }) => m.id === id));
	// /apps/<id>?invoice=31 opens the module's page as /m/<id>/?invoice=31, so
	// search results and dashboard links can point at one record.
	const src = $derived(`/m/${id}/${page.url.search}`);
</script>

<svelte:head><title>{mod?.label ?? 'Module'} · Ledger</title></svelte:head>

{#if mod}
	<!-- The module's own UI, served by Ledger at /m/<id>/ (same origin, same login). -->
	<!-- Its "/" and Ctrl/Cmd+K open Ledger's search too. -->
	<iframe class="module" title={mod.label} {src} {@attach forwardSearchKeys}></iframe>
{:else}
	<h1>Module not found</h1>
	<p>No running module is called "{id}". See <a href="/settings/modules">Settings → Modules</a>.</p>
{/if}

<style>
	.module {
		display: block;
		width: 100%;
		height: calc(100vh - 2.5rem);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
</style>
