import { error } from '@sveltejs/kit';
import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) error(404, 'Not found');
	const entry = unwrapLoad(await api(fetch).GET('/journal-entries/{entryId}', { params: { path: { entryId: id } } }));
	const { user } = await parent();
	// A line in Unreconciled can be moved on, and root mode can move any line: the accounts it can go to.
	const accounts = user?.root || entry.lines.some((l) => l.unreconciled) ? (unwrapLoad(await api(fetch).GET('/accounts')).data ?? []) : [];
	return { entry, accounts };
};
