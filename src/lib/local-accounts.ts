// The test accounts of the local copy of the backend: one of each kind. scripts/local.mjs
// creates them, the login page offers them when the site runs against that copy, and the
// browser tests log in with them. They exist nowhere else: the real site has no password
// login at all.
export interface LocalAccount {
	username: string;
	email: string;
	// What the login button says.
	label: string;
	role: 'owner' | 'admin' | 'member';
	banned?: boolean;
}

export const LOCAL_PASSWORD = 'local-test-accounts-only';

export const LOCAL_ACCOUNTS: LocalAccount[] = [
	{ username: 'owner', email: 'owner@local.test', label: 'the owner', role: 'owner' },
	{ username: 'admin', email: 'admin@local.test', label: 'an admin', role: 'admin' },
	{ username: 'admin2', email: 'admin2@local.test', label: 'a second admin', role: 'admin' },
	{ username: 'member', email: 'member@local.test', label: 'a member', role: 'member' },
	{ username: 'member2', email: 'member2@local.test', label: 'a second member', role: 'member' },
	// Deletes its own account in the browser tests, so nothing else may depend on it.
	{ username: 'leaver', email: 'leaver@local.test', label: 'a member who leaves', role: 'member' },
	{ username: 'banned', email: 'banned@local.test', label: 'a banned member', role: 'member', banned: true }
];
