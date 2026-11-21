import { error } from '@sveltejs/kit';
import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) error(404, 'Not found');
	const entry = unwrapLoad(await api(fetch).GET('/journal-entries/{entryId}', { params: { path: { entryId: id } } }));
	const { user } = await parent();
	// Whoever can edit the entry chooses each line's account: the accounts it can go to.
	const accounts = user && user.role !== 'viewer' ? (unwrapLoad(await api(fetch).GET('/accounts')).data ?? []) : [];
	const entities = unwrapLoad(await api(fetch).GET('/entities')).data ?? [];
	return { entry, accounts, entities };
};
