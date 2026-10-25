import { redirect } from '@sveltejs/kit';

// Moved under Settings.
export const load = () => redirect(308, '/settings/modules');
