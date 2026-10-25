import { redirect } from '@sveltejs/kit';

// Moved under Settings (older update notifications link here).
export const load = () => redirect(308, '/settings/updates');
