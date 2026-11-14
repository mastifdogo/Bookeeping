import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Gmail lives on the Mail tab now; old links land there.
export const load: PageLoad = () => redirect(307, '/settings/mail?kind=gmail');
