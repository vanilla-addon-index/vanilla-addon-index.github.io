import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

const CACHE_KEY = 'profile-v2';

export const auth = $state({
	session: null as Session | null,
	username: '',
	isAdmin: false,
	// The one account that can suspend admins and empty the trash.
	isOwner: false,
	// A banned account stays logged in but cannot post or edit.
	banned: false,
	// False until it is known whether anyone is logged in at all.
	known: false,
	ready: false
});

type Profile = { id: string; username: string; isAdmin: boolean; isOwner: boolean; banned: boolean };

function readCache(id?: string): Profile | null {
	try {
		const cached: Profile = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
		return cached && (!id || cached.id === id) ? cached : null;
	} catch {
		return null;
	}
}

function writeCache(profile: Profile | null) {
	try {
		if (profile) localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
		else localStorage.removeItem(CACHE_KEY);
	} catch {
		// Ignore quota and private-mode errors.
	}
}

// Shows the last known name and role at once, so a reload has nothing to flash.
// The cache only decides what is displayed; the database decides what is allowed.
function applySession(session: Session | null) {
	const cached = session && readCache(session.user.id);
	auth.session = session;
	auth.known = true;
	auth.username = cached?.username ?? '';
	auth.isAdmin = cached?.isAdmin ?? false;
	auth.isOwner = cached?.isOwner ?? false;
	auth.banned = cached?.banned ?? false;
	if (!session) writeCache(null);
	if (!session || cached) auth.ready = true;
}

type Role = { admin: boolean; owner: boolean; banned: boolean };

async function refreshProfile(session: Session) {
	if (!supabase) return;
	const id = session.user.id;
	const [{ data }, answer] = await Promise.all([
		supabase.from('profiles').select('username').eq('id', id).maybeSingle(),
		supabase.rpc('my_role')
	]);
	const role = (answer.data ?? {}) as Partial<Role>;
	// The user may have logged out or switched account while this was loading.
	if (auth.session?.user.id !== id) return;
	if (data) {
		const { admin = false, owner = false, banned = false } = role;
		auth.username = data.username;
		auth.isAdmin = admin;
		auth.isOwner = owner;
		auth.banned = banned;
		writeCache({ id, username: data.username, isAdmin: admin, isOwner: owner, banned });
	}
	auth.ready = true;
}

export function initAuth() {
	if (!supabase) {
		auth.known = true;
		auth.ready = true;
		return;
	}
	// The cache is cleared on logout, so its presence means a session is about to be restored.
	auth.username = readCache()?.username ?? '';
	supabase.auth.onAuthStateChange((_event, session) => {
		applySession(session);
		// Deferred: Supabase forbids awaiting its own client inside this callback.
		if (session) setTimeout(() => refreshProfile(session));
	});
}

/** An import has no owner, so only admins can edit it. */
export function canEdit(owner: string | null) {
	if (!auth.session || auth.banned) return false;
	return auth.isAdmin || auth.session.user.id === owner;
}
