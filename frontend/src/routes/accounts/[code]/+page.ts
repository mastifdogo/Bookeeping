import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const from = url.searchParams.get('from') || undefined;
	const to = url.searchParams.get('to') || undefined;
	const res = await api(fetch).GET('/accounts/{accountCode}/ledger', {
		params: { path: { accountCode: params.code }, query: { from, to } }
	});
	// The whole chart, for the account's place in it (parent, sub-accounts).
	const all = await api(fetch).GET('/accounts', { params: { query: { include_inactive: true } } });
	return { ledger: unwrapLoad(res), accounts: all.data?.data ?? [], from: from ?? '', to: to ?? '' };
};
