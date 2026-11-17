import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:dashboard', 'app:dashboard-layout');
	const client = api(fetch);
	const [dashboard, accounts, entries, layout] = await Promise.all([
		client.GET('/dashboard').then(unwrapLoad),
		client.GET('/accounts', { params: { query: { include_inactive: true } } }).then(unwrapLoad),
		client.GET('/journal-entries', { params: { query: { limit: 10 } } }).then(unwrapLoad),
		// Where the tiles go (Settings → UI); the standard layout if it can't be read.
		client.GET('/settings/dashboard-layout').then((r) => r.data?.tiles ?? [])
	]);
	return { dashboard, hasAccounts: accounts.data.length > 0, entries: entries.data, layout };
};
