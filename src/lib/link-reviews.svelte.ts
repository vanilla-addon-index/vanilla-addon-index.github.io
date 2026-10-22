import { supabase } from './supabase';
import { loadAddons } from './addons.svelte';
import { countEditReviews } from './edit-reviews.svelte';
import { auth } from './auth.svelte';

export interface LinkRequest {
	id: number;
	addon_id: number;
	url: string;
	proposer?: { username: string } | null;
}
function client() {
	if (!supabase) throw new Error('Database is not configured.');
	return supabase;
}
async function call(name: string, args: Record<string, unknown>) {
	const { error } = await client().rpc(name, args);
	if (error) throw new Error(error.message);
}
export async function requestLink(target: number, link: string) {
	await call('request_addon_link', { target, link });
}
export async function ownLinkRequests(target: number) {
	const { data, error } = await client().from('addon_link_requests').select('id,url')
		.eq('addon_id', target).eq('proposed_by', auth.session!.user.id).eq('status', 'pending').order('id');
	if (error) throw new Error(error.message);
	return data as Pick<LinkRequest, 'id' | 'url'>[];
}
export const withdrawLink = (request_id: number) => call('withdraw_addon_link', { request_id });
export async function loadLinkRequests() {
	const { data, error } = await client().from('addon_link_requests')
		.select('*, proposer:profiles!addon_link_requests_proposed_by_fkey(username)').eq('status', 'pending').order('id').limit(1000);
	if (error) throw new Error(error.message);
	return data as LinkRequest[];
}
export async function decideLink(request_id: number, accept: boolean) {
	await call('decide_addon_link', { request_id, accept });
	await Promise.all([loadAddons(), countEditReviews()]);
}
