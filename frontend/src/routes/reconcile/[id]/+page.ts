import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const id = Number(params.id);
	const res = await api(fetch).GET('/reconciliations/{reconciliationId}', { params: { path: { reconciliationId: id } } });
	return { detail: unwrapLoad(res) };
};
