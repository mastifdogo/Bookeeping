<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { forwardSearchKeys } from '#lib/search-shortcut.ts';

	const id = $derived(page.params.id ?? '');
	const mod = $derived(page.data.modules?.find((m: { id: string }) => m.id === id));
	// /apps/<id>?invoice=31 opens the module's page as /m/<id>/?invoice=31, so
	// search results and dashboard links can point at one record.
	// The part after "#" is the view the module is on (its own #/invoices/31):
	// it is given to the module when the frame is made, then kept in step below.
	// (Two steps, so that a change of only the "#" part doesn't make a new address and reload the frame.)
	const base = $derived(`/m/${id}/${page.url.search}`);
	const src = $derived(base + untrack(() => page.url.hash));

	// The view inside the module is part of this page's address, so Ledger's
	// Back button steps through a module's views like through Ledger's pages
	// (no back buttons in modules), and a reload or a restored window comes
	// back to the same view. The frame is same-origin, so it is read directly.
	let frame: HTMLIFrameElement | undefined = $state();
	let loaded = $state(0);
	const inner = (): Window | null => {
		try {
			const w = frame?.contentWindow;
			return w && w.location.pathname.startsWith(`/m/${id}/`) ? w : null;
		} catch {
			return null; // not a module page (yet)
		}
	};
	// The module moved to another view: this page's address follows.
	function fromModule(replace: boolean) {
		const w = inner();
		if (!w || w.location.hash === page.url.hash) return;
		goto(page.url.pathname + page.url.search + w.location.hash, { replace, reset: false });
	}
	function onload() {
		const w = inner();
		if (!w) return;
		w.addEventListener('hashchange', () => fromModule(false));
		fromModule(true); // a view the module chose while starting is no step back
		loaded++;
	}
	// In a window beside the first, Back changes this page's "#" from outside: tell the router.
	function onhashchange() {
		if (location.hash !== page.url.hash) goto(location.pathname + location.search + location.hash, { replace: true, reset: false });
	}
	// This page's address changed (Back, a link to a view): the module follows.
	$effect(() => {
		const hash = page.url.hash;
		if (!loaded) return;
		const w = inner();
		// "#" alone is the module's first view; without it the frame would reload.
		if (w && w.location.hash !== hash) w.location.replace(w.location.href.split('#')[0] + (hash || '#'));
	});
</script>

<svelte:window {onhashchange} />

<svelte:head><title>{mod?.label ?? 'Module'} · Ledger</title></svelte:head>

{#if mod}
	<!-- The module's own UI, served by Ledger at /m/<id>/ (same origin, same login). -->
	<!-- Its "/" and Ctrl/Cmd+K open Ledger's search too. -->
	<iframe class="module" title={mod.label} {src} bind:this={frame} {onload} {@attach forwardSearchKeys}></iframe>
{:else}
	<h1>Module not found</h1>
	<p>No running module is called "{id}". See <a href="/settings/modules">Settings → Modules</a>.</p>
{/if}

<style>
	.module {
		display: block;
		width: 100%;
		/* The window around it is the module's frame. */
		height: 100%;
		border: 0;
		background: transparent;
	}
</style>
