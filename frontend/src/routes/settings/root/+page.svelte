<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ErrorNotice from '#lib/components/ErrorNotice.svelte';
	import { api, unwrap } from '#lib/api/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let root = $derived(page.data.user?.root === true);
	let busy = $state('');
	let error: unknown = $state(null);
	let notice = $state('');

	type Action = (typeof data.actions)[number];
	const LABELS: Record<Action['action'], string> = {
		'account.update': 'Account changed',
		'account.delete': 'Account deleted',
		'user.update': 'User renamed',
		'user.delete': 'User deleted'
	};

	async function reverse(a: Action) {
		if (!confirm(`Reverse this root action?\n\n${a.summary}\n\nWhat it changed or deleted is put back.`)) return;
		error = null;
		notice = '';
		busy = `${a.scope}:${a.id}`;
		try {
			unwrap(await api().POST('/root-actions/{scope}/{actionId}/reverse', { params: { path: { scope: a.scope, actionId: a.id } } }));
			notice = `Reversed: ${a.summary}.`;
			await invalidateAll();
		} catch (e) {
			error = e;
		} finally {
			busy = '';
		}
	}
</script>

<p class="muted" style="margin-top:0">
	Everything done in root mode: accounts deleted or changed, users renamed or deleted. Each keeps what it changed or deleted, so
	<strong>Reverse</strong> puts it back. Reversing needs root mode on (Settings → Account).
</p>
<ErrorNotice {error} />
{#if notice}<div class="notice ok">{notice}</div>{/if}

<div class="table-wrap">
	{#if data.actions.length === 0}
		<div class="empty">No root actions yet.</div>
	{:else}
		<table>
			<thead>
				<tr><th>When</th><th>By</th><th>What</th><th>Details</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.actions as a (`${a.scope}:${a.id}`)}
					<tr class:reversed={a.reversed_at}>
						<td class="small">{new Date(a.done_at).toLocaleString()}</td>
						<td>{a.done_by}</td>
						<td><span class="badge" class:danger={a.action.endsWith('.delete')}>{LABELS[a.action]}</span></td>
						<td>{a.summary}</td>
						<td class="num">
							{#if a.reversed_at}
								<span class="muted small">reversed by {a.reversed_by}, {new Date(a.reversed_at).toLocaleString()}</span>
							{:else}
								<button disabled={!root || busy !== ''} title={root ? 'Put back what it changed or deleted' : 'Turn on root mode under Settings → Account to reverse'} onclick={() => reverse(a)}
									>{busy === `${a.scope}:${a.id}` ? 'Reversing…' : 'Reverse'}</button
								>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	tr.reversed td {
		opacity: 0.6;
	}
</style>
