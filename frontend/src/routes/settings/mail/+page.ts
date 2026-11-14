import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const [info, gmail] = await Promise.all([api(fetch).GET('/integrations/mail'), api(fetch).GET('/integrations/gmail')]);
	return { info: unwrapLoad(info), gmail: unwrapLoad(gmail), kind: url.searchParams.get('kind') };
};
