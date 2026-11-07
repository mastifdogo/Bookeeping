// "/" and Ctrl/Cmd+K open Ledger's search from anywhere, including pages in
// side-by-side panes and modules' frames: a key pressed inside a frame goes
// to that frame, so frames hand it to the top window, which opens the search.

/** Whether this key press means "open search" ("/" only when not typing). */
export function isSearchKey(e: KeyboardEvent): boolean {
	const t = e.target as { isContentEditable?: boolean; tagName?: string } | null;
	const typing = !!t && (t.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName ?? ''));
	if (e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) return true;
	return e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export const SEARCH_MESSAGE = 'ledger-search';

/** Asks the top Ledger window to open the search. */
export function requestSearch(): void {
	window.top?.postMessage({ type: SEARCH_MESSAGE }, location.origin);
}

/** Forwards the search keys from a same-origin frame (a module's page) to the top window. */
export function forwardSearchKeys(frame: HTMLIFrameElement): void {
	const attach = () => {
		try {
			frame.contentWindow?.addEventListener('keydown', (e) => {
				if (!isSearchKey(e)) return;
				e.preventDefault();
				requestSearch();
			});
		} catch {
			// not same-origin: leave it alone
		}
	};
	frame.addEventListener('load', attach);
	attach();
}
