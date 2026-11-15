import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = api(fetch);
	const [accounts, recs, statements] = await Promise.all([
		client.GET('/accounts').then(unwrapLoad),
		client.GET('/reconciliations').then(unwrapLoad),
		client.GET('/documents', { params: { query: { kind: 'statement', limit: 200 } } }).then(unwrapLoad)
	]);
	return { accounts: accounts.data, reconciliations: recs.data, statements: statements.data, preselect: url.searchParams.get('account') ?? '', finished: Number(url.searchParams.get('finished')) || null };
};
