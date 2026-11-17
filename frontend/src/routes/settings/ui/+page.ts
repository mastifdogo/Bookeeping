import { api } from '#lib/api/client.ts';
import type { Tile } from '#lib/dashboard-layout.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:dashboard-layout');
	const r = await api(fetch).GET('/settings/dashboard-layout');
	return { layout: (r.data?.tiles ?? []) as Tile[] };
};
