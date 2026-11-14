import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const kind = (['receipt', 'statement', 'invoice', 'other'] as const).find((k) => k === p.get('kind'));
	const origin = (['imported', 'created'] as const).find((o) => o === p.get('origin'));
	const year = /^\d{4}$/.test(p.get('year') ?? '') ? Number(p.get('year')) : undefined;
	const q = p.get('q') ?? '';
	const account = p.get('account') ?? '';
	const [docs, entities, accounts] = await Promise.all([
		api(fetch).GET('/documents', { params: { query: { kind, origin, year, account_code: account || undefined, q: q || undefined, limit: 200 } } }),
		api(fetch).GET('/entities'),
		api(fetch).GET('/accounts')
	]);
	// Statements belong to bank, card and loan accounts.
	const accounts2 = unwrapLoad(accounts).data.filter((a) => a.type === 'asset' || a.type === 'liability');
	return { docs: unwrapLoad(docs), entities: unwrapLoad(entities).data, accounts: accounts2, filter: { kind, origin, year, account, q } };
};
