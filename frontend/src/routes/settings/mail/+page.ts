import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({ info: unwrapLoad(await api(fetch).GET('/integrations/mail')) });
