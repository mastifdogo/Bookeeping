<script lang="ts">
	import { page } from '$app/state';
	import { arrangeNav } from '#lib/nav.ts';

	// A page hidden from the sidebar, shown inside Settings.
	let item = $derived(arrangeNav(page.data.sidebar ?? [], page.data.modules ?? []).find((i) => i.id === `core:${page.params.name}`));
</script>

{#if item}
	<p class="muted small" style="margin-top:0">
		{item.label} is hidden from the sidebar{item.hidden ? '' : ' (not any more)'}, so it's here. Show it again under
		<a href="/settings/sidebar">Sidebar</a>, or <a href={item.href}>open it full size</a>.
	</p>
	<iframe class="card" src={item.href} title={item.label}></iframe>
{:else}
	<p>No such page.</p>
{/if}

<style>
	iframe {
		display: block;
		width: 100%;
		height: calc(100vh - 13rem);
		min-height: 420px;
		padding: 0;
		margin: 0;
	}
</style>
