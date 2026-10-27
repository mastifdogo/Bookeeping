<script lang="ts">
	// A sidebar icon: a 24x24 stroked (or filled) path, or a module's SVG file
	// used as a mask so it takes the text colour like the built-in icons.
	let { d, fill = false, url = null, size = 20 }: { d: string; fill?: boolean; url?: string | null; size?: number } = $props();
</script>

{#if url}
	<span class="masked" style:width="{size}px" style:height="{size}px" style:--icon="url('{url.replace(/['\\\\]/g, '')}')" aria-hidden="true"></span>
{:else}
	<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" class:fill><path {d} /></svg>
{/if}

<style>
	svg {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	svg.fill {
		fill: currentColor;
		stroke: none;
	}
	.masked {
		flex: none;
		display: inline-block;
		background-color: currentColor;
		-webkit-mask: var(--icon) center / contain no-repeat;
		mask: var(--icon) center / contain no-repeat;
	}
</style>
