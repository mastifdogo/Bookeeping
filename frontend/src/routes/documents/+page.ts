import { api, unwrapLoad } from '#lib/api/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const kind = (['receipt', 'statement', 'invoice', 'other'] as const).find((k) => k === p.get('kind'));
	const origin = (['imported', 'created'] as const).find((o) => o === p.get('origin'));
	const year = /^\d{4}$/.test(p.get('year') ?? '') ? Number(p.get('year')) : undefined;
	const q = p.get('q') ?? '';
	const [docs, entities] = await Promise.all([
		api(fetch).GET('/documents', { params: { query: { kind, origin, year, q: q || undefined, limit: 200 } } }),
		api(fetch).GET('/entities')
	]);
	return { docs: unwrapLoad(docs), entities: unwrapLoad(entities).data, filter: { kind, origin, year, q } };
};
