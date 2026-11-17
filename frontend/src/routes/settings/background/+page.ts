import { redirect } from '@sveltejs/kit';

// Background moved into Settings → UI.
export const load = () => redirect(308, '/settings/ui');
