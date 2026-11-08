import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [users, orgs] = await Promise.all([api(fetch).GET('/users'), api(fetch).GET('/organizations')]);
	return { users: unwrapLoad(users).data, orgs: unwrapLoad(orgs).data };
};
