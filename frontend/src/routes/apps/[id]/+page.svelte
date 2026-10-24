<script lang="ts">
	import { page } from '$app/state';

	const id = $derived(page.params.id ?? '');
	const mod = $derived(page.data.modules?.find((m: { id: string }) => m.id === id));
</script>

<svelte:head><title>{mod?.label ?? 'Module'} · Ledger</title></svelte:head>

{#if mod}
	<!-- The module's own UI, served by Ledger at /m/<id>/ (same origin, same login). -->
	<iframe class="module" title={mod.label} src="/m/{id}/"></iframe>
{:else}
	<h1>Module not found</h1>
	<p>No running module is called "{id}". See <a href="/modules">Modules</a>.</p>
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
