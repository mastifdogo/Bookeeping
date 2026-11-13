import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const res = await api(fetch).GET('/accounts', { params: { query: { include_inactive: false } } });
	const ents = await api(fetch).GET('/entities');
	return { accounts: unwrapLoad(res).data, entities: ents.data?.data ?? [] };
};
