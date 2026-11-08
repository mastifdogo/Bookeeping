import { goto } from '$app/navigation';

/**
 * For table rows that open something when clicked anywhere: follows `href`
 * unless the click was on a link, button or field, or selected text.
 */
export function openRow(ev: MouseEvent, href: string): void {
	if ((ev.target as HTMLElement).closest('a, button, input, select, textarea') || window.getSelection()?.toString()) return;
	goto(href);
}
