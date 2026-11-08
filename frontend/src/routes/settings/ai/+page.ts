import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The tab was called "AI" before Ledger 0.11.2.
export const load: PageLoad = () => redirect(308, '/settings/llm');
