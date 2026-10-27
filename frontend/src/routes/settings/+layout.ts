import { api } from '#lib/api/client.ts';
import type { LayoutLoad } from './$types';

// Every installed module gets a tab (none if the request fails).
export const load: LayoutLoad = async ({ fetch, depends }) => {
	depends('app:modules');
	const res = await api(fetch).GET('/modules');
	const seen = new Set<string>();
	const installedModules = (res.data?.modules ?? []).filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
	return { installedModules, installerAvailable: res.data?.installer_available ?? false };
};
