import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [accounts, vendors] = await Promise.all([
		api(fetch).GET('/accounts', { params: { query: { include_inactive: false } } }),
		api(fetch).GET('/entities', { params: { query: { role: 'vendor' } } })
	]);
	return { accounts: unwrapLoad(accounts).data, vendors: unwrapLoad(vendors).data };
};
