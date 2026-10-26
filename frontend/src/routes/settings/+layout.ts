import { api } from '#lib/api/client.ts';
import type { LayoutLoad } from './$types';

// Running modules that declare settings get a tab (none if the request fails).
export const load: LayoutLoad = async ({ fetch, depends }) => {
	depends('app:modules');
	const res = await api(fetch).GET('/modules');
	const moduleSettings = (res.data?.modules ?? [])
		.filter((m) => m.has_settings && m.id)
		.map((m) => ({ id: m.id!, name: m.name }));
	return { moduleSettings };
};
