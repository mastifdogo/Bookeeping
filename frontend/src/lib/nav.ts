// The sidebar's entries: Ledger's own pages plus running modules, arranged by
// the user's preferences (Settings → Sidebar, stored per user on the server).

// Icons are 24x24 stroked paths.
export const ICONS = {
	dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
	journal: 'M4 5h16M4 12h16M4 19h10',
	new: 'M12 5v14M5 12h14',
	accounts: 'M3 6h6l2 2h10v11H3z',
	reports: 'M5 20V10M12 20V4M19 20v-7',
	files: 'M6 3h8l4 4v14H6zM14 3v4h4',
	settings:
		'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
	logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
	collapse: 'M15 6l-6 6 6 6',
	module: 'M9 3h6v3a2 2 0 1 0 4 0V5h2v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H3v-6h3a2 2 0 1 0 0-4H3V5h6z',
	menu: 'M4 6h16M4 12h16M4 18h16',
	split: 'M3 4h18v16H3zM13 4v16M16 10v4M14 12h4',
	close: 'M6 6l12 12M18 6L6 18',
	expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
	grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
	up: 'M6 15l6-6 6 6',
	down: 'M6 9l6 6 6-6'
} as const;

// Icons modules can name in their manifest's nav.icon (docs/MODULES.md).
const MODULE_ICONS: Record<string, string> = {
	hammer:
		'M15 12l-8.4 8.4a1 1 0 1 1-3-3L12 9M18 15l4-4M21.5 11.5l-1.9-1.9A2 2 0 0 1 19 8.2V7l-2.3-2.3a6 6 0 0 0-4.2-1.7L9 3l.9.8A6.2 6.2 0 0 1 12 8.4V10l2 2h1.2a2 2 0 0 1 1.4.6l1.9 1.9',
	invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
	cart: 'M3 4h2l2.5 11h11L21 7H6.2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01',
	chart: 'M4 20h16M7 16V11M12 16V6M17 16v-3',
	users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a7 7 0 0 1 4 7',
	mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
	calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
	box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
	dollar: 'M12 2v20M17 6.5C17 4.6 14.8 4 12 4S7 5 7 7.5 9.5 10.5 12 11s5 1.5 5 4-2.2 3.5-5 3.5-5-.9-5-3',
	wrench: 'M14.7 6.3a4 4 0 0 0 5 5L22 14l-3 3-2.4-2.3a4 4 0 0 0-5-5L4 17.3a2 2 0 1 0 2.8 2.8l7.6-7.6'
};
export const moduleIcon = (name: string | null) => (name && MODULE_ICONS[name]) || ICONS.module;

export interface NavItem {
	/** "core:<name>" or "module:<id>"; the key stored in the preferences. */
	id: string;
	href: string;
	label: string;
	icon: string;
	/** Only this exact path counts as the current page. */
	exact: boolean;
	kind: 'core' | 'module';
	hidden: boolean;
}

const CORE: Omit<NavItem, 'hidden'>[] = [
	{
		id: 'core:dashboard',
		href: '/',
		label: 'Dashboard',
		exact: true,
		icon: ICONS.dashboard,
		kind: 'core'
	},
	{
		id: 'core:journal',
		href: '/journal',
		label: 'Journal',
		exact: true,
		icon: ICONS.journal,
		kind: 'core'
	},
	{
		id: 'core:new-entry',
		href: '/journal/new',
		label: 'New entry',
		exact: true,
		icon: ICONS.new,
		kind: 'core'
	},
	{
		id: 'core:accounts',
		href: '/accounts',
		label: 'Accounts',
		exact: false,
		icon: ICONS.accounts,
		kind: 'core'
	},
	{
		id: 'core:reports',
		href: '/reports',
		label: 'Reports',
		exact: false,
		icon: ICONS.reports,
		kind: 'core'
	},
	{
		id: 'core:files',
		href: '/files',
		label: 'Files',
		exact: false,
		icon: ICONS.files,
		kind: 'core'
	}
];

export type SidebarPref = { id: string; hidden: boolean };

/**
 * All entries in the user's order. Entries the preferences don't mention
 * (defaults, newly installed modules) follow in their default order;
 * preferences for modules that are gone are dropped.
 */
export function arrangeNav(prefs: SidebarPref[], modules: { id: string; label: string; icon: string | null }[]): NavItem[] {
	const all: Omit<NavItem, 'hidden'>[] = [
		...CORE,
		...modules.map((m) => ({
			id: `module:${m.id}`,
			href: `/apps/${m.id}`,
			label: m.label,
			exact: false,
			icon: moduleIcon(m.icon),
			kind: 'module' as const
		}))
	];
	const byId = new Map(all.map((i) => [i.id, i]));
	const out: NavItem[] = [];
	for (const p of prefs) {
		const item = byId.get(p.id);
		if (!item) continue;
		out.push({ ...item, hidden: p.hidden });
		byId.delete(p.id);
	}
	for (const item of byId.values()) out.push({ ...item, hidden: false });
	return out;
}

/** The label of the page at `path`, for pane headers. */
export function pageTitle(path: string, items: NavItem[]): string {
	const p = path.split(/[?#]/)[0]!;
	if (p.startsWith('/settings')) return 'Settings';
	if (/^\/journal\/\d+$/.test(p)) return `Entry ${p.slice(9)}`;
	if (/^\/accounts\/./.test(p)) return `Account ${decodeURIComponent(p.slice(10))}`;
	const exact = items.find((i) => i.href === p);
	if (exact) return exact.label;
	const prefix = items.filter((i) => i.href !== '/' && p.startsWith(i.href + '/')).sort((a, b) => b.href.length - a.href.length)[0];
	return prefix?.label ?? p;
}
