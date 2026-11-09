// "+ New account…" from any account picker, and from module pages: one dialog
// (NewAccountDialog, in the root layout) creates the account on top of the
// current page, so nothing typed there is lost.

import type { Account, AccountType, Currency } from '#lib/api/client.ts';

export interface NewAccountDefaults {
	code?: string;
	name?: string;
	type?: AccountType;
	currency?: Currency;
	description?: string;
}

interface Request {
	defaults: NewAccountDefaults;
	resolve: (a: Account | null) => void;
}

export const newAccount = $state<{ req: Request | null }>({ req: null });

/** Opens the dialog; resolves with the created account, or null if cancelled. */
export function requestNewAccount(defaults: NewAccountDefaults = {}): Promise<Account | null> {
	return new Promise((resolve) => {
		newAccount.req?.resolve(null);
		newAccount.req = { defaults, resolve };
	});
}

export { suggestCode } from '#lib/account-codes.ts';
