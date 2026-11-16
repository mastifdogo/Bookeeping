<script lang="ts">
	// The root console: a live, read-only view of the requests this session
	// makes and every SQL statement they run, beside the page (root mode only).
	import { page } from '$app/state';

	type Ev = { t: number; kind: 'request' | 'response' | 'sql' | 'sql-error' | 'info'; request: string; db?: string; text: string; params?: string[]; ms?: number; rows?: number | null; status?: number };

	let { onclose }: { onclose: () => void } = $props();

	const MAX = 2000;
	let lines = $state<Ev[]>([]);
	let paused = $state(false);
	let showParams = $state(true);
	let showSql = $state(true);
	let filter = $state('');
	let scope = $state<'mine' | 'all'>('mine');
	let connected = $state(false);
	let box: HTMLDivElement | undefined = $state();
	let follow = $state(true);
	let serverAdmin = $derived(page.data.user?.server_admin === true);

	$effect(() => {
		const es = new EventSource(`/api/v1/root/console${scope === 'all' ? '?scope=all' : ''}`);
		es.onopen = () => (connected = true);
		es.onerror = () => (connected = false);
		es.onmessage = (m) => {
			if (paused) return;
			try {
				const ev = JSON.parse(m.data) as Ev;
				lines = lines.length >= MAX ? [...lines.slice(lines.length - MAX + 1), ev] : [...lines, ev];
			} catch {
				// not an event
			}
		};
		return () => es.close();
	});

	let shown = $derived(
		lines.filter((l) => (showSql || (l.kind !== 'sql' && l.kind !== 'sql-error') || l.kind === 'sql-error') && (!filter || `${l.text} ${l.params?.join(' ') ?? ''}`.toLowerCase().includes(filter.toLowerCase())))
	);

	// Keep the newest line in view unless the reader scrolled up.
	$effect(() => {
		void shown.length;
		if (follow && box) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
	});
	const onScroll = () => {
		if (box) follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
	};

	const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
	const prompt = (l: Ev) => (l.kind === 'request' ? '→' : l.kind === 'response' ? '←' : l.kind === 'info' ? '#' : l.kind === 'sql-error' ? '✗' : '$');

	function copyAll() {
		const text = shown.map((l) => `${time(l.t)} ${prompt(l)} ${l.text}${l.params?.length ? `  -- [${l.params.join(', ')}]` : ''}${l.ms !== undefined ? `  (${l.ms} ms${l.rows !== undefined && l.rows !== null ? `, ${l.rows} rows` : ''})` : ''}`).join('\n');
		navigator.clipboard?.writeText(text).catch(() => {});
	}
</script>

<section class="console" aria-label="Root console">
	<header>
		<strong>Console</strong>
		<span class="dot" class:on={connected} title={connected ? 'Connected' : 'Not connected'}></span>
		{#if serverAdmin}
			<select bind:value={scope} aria-label="What to show" title="Whose requests to show">
				<option value="mine">This session</option>
				<option value="all">Whole server</option>
			</select>
		{/if}
		<input class="filter" bind:value={filter} placeholder="Filter" aria-label="Filter lines" />
		<span class="spacer"></span>
		<label title="Show SQL statements"><input type="checkbox" bind:checked={showSql} /> SQL</label>
		<label title="Show the values sent with each statement"><input type="checkbox" bind:checked={showParams} /> Values</label>
		<button class="tool" onclick={() => (paused = !paused)} title={paused ? 'Resume' : 'Pause'}>{paused ? 'Resume' : 'Pause'}</button>
		<button class="tool" onclick={copyAll} title="Copy the lines shown">Copy</button>
		<button class="tool" onclick={() => (lines = [])} title="Clear">Clear</button>
		<button class="tool" onclick={onclose} title="Close the console">✕</button>
	</header>
	<div class="out" bind:this={box} onscroll={onScroll} role="log" aria-live="off">
		{#if shown.length === 0}
			<div class="muted-line"># Waiting for requests. Use the page on the left; what it asks the server and the SQL that runs show up here.</div>
		{/if}
		{#each shown as l, i (i)}
			<div class="line {l.kind}" class:bad={l.kind === 'response' && (l.status ?? 0) >= 400}>
				<span class="ts">{time(l.t)}</span>
				<span class="pr">{prompt(l)}</span>
				<span class="tx"
					>{l.text}{#if showParams && l.params?.length}<span class="params">-- [{l.params.join(', ')}]</span>{/if}{#if l.ms !== undefined}<span class="ms"
							>({l.ms} ms{#if l.rows !== undefined && l.rows !== null}, {l.rows} row{l.rows === 1 ? '' : 's'}{/if}{#if l.db}, {l.db}{/if})</span
						>{/if}</span
				>
			</div>
		{/each}
	</div>
	{#if !follow}<button class="jump" onclick={() => ((follow = true), box && (box.scrollTop = box.scrollHeight))}>↓ Newest</button>{/if}
</section>

<style>
	.console {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: #0d1117;
		color: #d1d7e0;
		border-radius: var(--radius);
		border: 1px solid #30363d;
		position: relative;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #30363d;
		font-size: 0.8rem;
		font-family: var(--font, system-ui);
	}
	header label {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: #d1d7e0;
		font-size: 0.8rem;
	}
	header select,
	header .filter {
		background: #161b22;
		color: #d1d7e0;
		border: 1px solid #30363d;
		padding: 0.15rem 0.35rem;
		font-size: 0.8rem;
		width: auto;
	}
	header .filter {
		width: 8rem;
	}
	.spacer {
		flex: 1;
	}
	.tool {
		background: #21262d;
		color: #d1d7e0;
		border: 1px solid #30363d;
		padding: 0.15rem 0.5rem;
		font-size: 0.75rem;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: #6e7681;
	}
	.dot.on {
		background: #3fb950;
	}
	.out {
		flex: 1;
		overflow: auto;
		padding: 0.4rem 0.5rem;
		font-size: 0.75rem;
		line-height: 1.45;
	}
	.line {
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ts {
		color: #6e7681;
		margin-right: 0.4rem;
	}
	.pr {
		margin-right: 0.35rem;
		color: #8b949e;
	}
	.request .tx {
		color: #79c0ff;
	}
	.response .tx {
		color: #7ee787;
	}
	.response.bad .tx {
		color: #ffa657;
	}
	.sql-error .tx,
	.sql-error .pr {
		color: #ff7b72;
	}
	.info .tx,
	.muted-line {
		color: #8b949e;
	}
	.params {
		color: #d2a8ff;
		margin-left: 0.6em;
	}
	.ms {
		color: #6e7681;
		margin-left: 0.6em;
	}
	.jump {
		position: absolute;
		right: 0.75rem;
		bottom: 0.75rem;
		background: #1f6feb;
		color: #fff;
		border: none;
		font-size: 0.75rem;
	}
</style>
