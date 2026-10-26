import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = api(fetch);
	const [accounts, recs] = await Promise.all([
		client.GET('/accounts').then(unwrapLoad),
		client.GET('/reconciliations').then(unwrapLoad)
	]);
	return { accounts: accounts.data, reconciliations: recs.data, preselect: url.searchParams.get('account') ?? '' };
};
