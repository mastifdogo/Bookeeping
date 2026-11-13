import { error } from '@sveltejs/kit';
import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent }) => {
	const { installedModules } = await parent();
	const mod = installedModules.find((m) => m.id === params.id);
	if (!mod) error(404, 'No such module');
	const settings = mod.has_settings
		? unwrapLoad(await api(fetch).GET('/modules/{moduleId}/settings', { params: { path: { moduleId: params.id } } }))
		: null;
	// What the module's "Import from CSV" takes, if it has one.
	const imp = await api(fetch).GET('/modules/{moduleId}/import', { params: { path: { moduleId: params.id } } });
	return { id: params.id, mod, settings, importInfo: imp.data?.available ? imp.data : null };
};
