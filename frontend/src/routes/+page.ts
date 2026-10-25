import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:dashboard');
	const client = api(fetch);
	const [dashboard, accounts, entries] = await Promise.all([
		client.GET('/dashboard').then(unwrapLoad),
		client.GET('/accounts', { params: { query: { include_inactive: true } } }).then(unwrapLoad),
		client.GET('/journal-entries', { params: { query: { limit: 10 } } }).then(unwrapLoad)
	]);
	return { dashboard, hasAccounts: accounts.data.length > 0, entries: entries.data };
};
