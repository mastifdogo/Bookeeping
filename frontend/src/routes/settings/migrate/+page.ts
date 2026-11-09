import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [info, accounts] = await Promise.all([api(fetch).GET('/migrations'), api(fetch).GET('/accounts', { params: { query: { include_inactive: false } } })]);
	return { info: unwrapLoad(info), accounts: unwrapLoad(accounts).data };
};
