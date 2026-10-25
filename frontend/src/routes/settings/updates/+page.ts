import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	return { info: unwrapLoad(await api(fetch).GET('/system/update')) };
};
