import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({ users: unwrapLoad(await api(fetch).GET('/users')).data });
