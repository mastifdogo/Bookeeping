import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const id = Number(params.id);
	const [res, statements] = await Promise.all([
		api(fetch).GET('/reconciliations/{reconciliationId}', { params: { path: { reconciliationId: id } } }),
		api(fetch).GET('/documents', { params: { query: { kind: 'statement', limit: 200 } } })
	]);
	return { detail: unwrapLoad(res), statements: unwrapLoad(statements).data };
};
