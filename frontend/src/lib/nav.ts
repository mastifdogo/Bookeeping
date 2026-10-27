// The sidebar's entries: Ledger's own pages plus running modules, arranged by
// the user's preferences (Settings → Sidebar, stored per user on the server).

// Icons are 24x24 stroked paths.
export const ICONS = {
	dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
	journal: 'M4 5h16M4 12h16M4 19h10',
	new: 'M12 5v14M5 12h14',
	accounts: 'M3 6h6l2 2h10v11H3z',
	reports: 'M5 20V10M12 20V4M19 20v-7',
	reconcile: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
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
	wrench: 'M14.7 6.3a4 4 0 0 0 5 5L22 14l-3 3-2.4-2.3a4 4 0 0 0-5-5L4 17.3a2 2 0 1 0 2.8 2.8l7.6-7.6',
	bank: 'M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18',
	wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 13.5h.01',
	piggy: 'M5 11a7 6 0 0 1 13-2l3-1v4l-1.5 1A7 6 0 0 1 16 17v3h-3v-2h-3v2H7v-3.5A6 6 0 0 1 5 11zM15 10h.01',
	receipt: 'M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21zM9 8h6M9 12h6',
	tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
	truck: 'M2 6h12v10H2zM14 9h4l4 4v3h-8M6 19a2 2 0 1 0 0-.01M18 19a2 2 0 1 0 0-.01',
	home: 'M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6',
	briefcase: 'M3 7h18v13H3zM8 7V4h8v3M3 13h18',
	clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
	globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
	key: 'M14.5 9.5a5 5 0 1 0-.01 0M11 13l-8 8M6 18l2 2M9 15l2 2',
	lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
	star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
	heart: 'M12 20s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 5.8-8 11-8 11z',
	bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
	file: 'M6 3h8l4 4v14H6zM14 3v4h4',
	folder: 'M3 6h6l2 2h10v11H3z',
	cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z',
	database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
	link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
	send: 'M21 3L3 10l7 3 3 7zM10 13l11-10',
	phone: 'M7 2h10v20H7zM11 18h2',
	printer: 'M6 9V3h12v6M6 18H3v-8h18v8h-3M7 14h10v7H7z',
	gift: 'M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8C10 4 6 4 7 7M12 8c2-4 6-4 5-1',
	bot: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M9 16h6M2 12v3M22 12v3',
	sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
	pie: 'M12 3v9h9A9 9 0 1 1 12 3zM15 3.5A9 9 0 0 1 20.5 9H15z',
	target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
	scale: 'M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z',
	percent: 'M19 5L5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
	calculator: 'M5 3h14v18H5zM8 7h8v3H8zM8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01M16 17.5h.01'
};
/** The names modules can use (docs/MODULES.md lists them). */
export const MODULE_ICON_NAMES = Object.keys(MODULE_ICONS);
export const moduleIcon = (name: string | null) => (name && MODULE_ICONS[name]) || ICONS.module;

/** A module's sidebar entry as the API sends it. */
export interface ModuleNav {
	id: string;
	label: string;
	icon: string | null;
	icon_path: string | null;
	icon_fill: boolean;
	icon_url: string | null;
}

export interface NavItem {
	/** "core:<name>" or "module:<id>"; the key stored in the preferences. */
	id: string;
	href: string;
	label: string;
	/** A 24x24 SVG path (stroked, or filled when iconFill)... */
	icon: string;
	iconFill: boolean;
	/** ...or an SVG file drawn by a module, used as a mask. */
	iconUrl: string | null;
	/** Only this exact path counts as the current page. */
	exact: boolean;
	kind: 'core' | 'module';
	hidden: boolean;
}

const CORE: Omit<NavItem, 'hidden' | 'iconFill' | 'iconUrl'>[] = [
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
		id: 'core:reconcile',
		href: '/reconcile',
		label: 'Reconcile',
		exact: false,
		icon: ICONS.reconcile,
		kind: 'core'
	},
	{
		id: 'core:reports',
		href: '/reports',
		label: 'Reports',
		exact: false,
		icon: ICONS.reports,
		kind: 'core'
	}
];

export type SidebarPref = { id: string; hidden: boolean };

/**
 * All entries in the user's order. Entries the preferences don't mention
 * (defaults, newly installed modules) follow in their default order;
 * preferences for modules that are gone are dropped.
 */
export function arrangeNav(prefs: SidebarPref[], modules: ModuleNav[]): NavItem[] {
	const all: Omit<NavItem, 'hidden'>[] = [
		...CORE.map((c) => ({ ...c, iconFill: false, iconUrl: null })),
		...modules.map((m) => ({
			id: `module:${m.id}`,
			href: `/apps/${m.id}`,
			label: m.label,
			exact: false,
			// A module's own drawing or file wins over a named icon.
			icon: m.icon_path ?? moduleIcon(m.icon),
			iconFill: m.icon_path !== null && m.icon_fill,
			iconUrl: m.icon_url,
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
