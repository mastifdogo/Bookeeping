import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const kind = (['receipt', 'statement', 'invoice', 'other'] as const).find((k) => k === p.get('kind'));
	const origin = (['imported', 'created'] as const).find((o) => o === p.get('origin'));
	const year = /^\d{4}$/.test(p.get('year') ?? '') ? Number(p.get('year')) : undefined;
	const q = p.get('q') ?? '';
	const account = p.get('account') ?? '';
	const tag = /^[a-z][a-z0-9_-]{0,39}$/.test(p.get('tag') ?? '') ? (p.get('tag') as string) : '';
	const [docs, entities, accounts, tags] = await Promise.all([
		api(fetch).GET('/documents', { params: { query: { kind, origin, year, account_code: account || undefined, tag: tag || undefined, q: q || undefined, limit: 200 } } }),
		api(fetch).GET('/entities'),
		api(fetch).GET('/accounts'),
		api(fetch).GET('/document-tags')
	]);
	// Statements belong to bank, card and loan accounts.
	const accounts2 = unwrapLoad(accounts).data.filter((a) => !a.hidden && (a.type === 'asset' || a.type === 'liability'));
	return { docs: unwrapLoad(docs), entities: unwrapLoad(entities).data, accounts: accounts2, tags: unwrapLoad(tags).data, filter: { kind, origin, year, account, tag, q } };
};
