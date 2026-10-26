import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const res = await api(fetch).GET('/modules/{moduleId}/settings', { params: { path: { moduleId: params.id } } });
	return { id: params.id, settings: unwrapLoad(res) };
};
