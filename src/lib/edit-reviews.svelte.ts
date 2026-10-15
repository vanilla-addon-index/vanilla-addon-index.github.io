import { auth } from './auth.svelte';
import { loadAddons } from './addons.svelte';
import { supabase } from './supabase';
import type { Addon, AddonInput } from './types';

export const EDIT_FIELDS = ['name', 'description', 'category', 'author', 'images', 'versions'] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export const FIELD_LABELS: Record<EditField, string> = {name:'Name', description:'Description', category:'Category', author:'Author', images:'Screenshots', versions:'Download links'};
export const contentOf = (addon: Addon): AddonInput => ({name:addon.name, description:addon.description, category:addon.category, author:addon.author, images:[...addon.images], versions:addon.versions.map(v => ({...v}))});
export interface EditRequest {
 id: number;
 addon_id: number;
 base: Partial<AddonInput>;
 changes: Partial<AddonInput>;
 status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
 proposer?: {username: string} | null;
}
export interface ContributionAccess {can_propose: boolean; links: string[]}
export const editReviews = $state({pending:0});

function client() {
 if (!supabase) throw new Error('Database is not configured.');
 return supabase;
}
async function call<T>(name: string, args: Record<string,unknown>) {
 const {data,error}=await client().rpc(name,args);
 if(error) throw new Error(error.message);
 return data as T;
}
export const contributionAccess = (id: number) => call<ContributionAccess>('addon_contribution_access',{target:id});
export async function ownPendingEdit(id: number) {
 const {data,error}=await client().from('addon_edit_requests').select('*').eq('addon_id',id).eq('proposed_by',auth.session!.user.id).eq('status','pending').maybeSingle();
 if(error) throw new Error(error.message);
 return data as EditRequest | null;
}
export const proposeEdit = (id: number,input: AddonInput,base: AddonInput) => call<number>('propose_addon_edit',{target:id,input,base});
export const withdrawEdit = (id: number) => call('withdraw_addon_edit',{request_id:id});
export async function removeOwnLink(id: number,link: string) {
 await call('remove_own_addon_link',{target:id,link});
 await loadAddons();
}
export async function countEditReviews() {
 if(!supabase) return;
 const {count}=await supabase.from('addon_edit_requests').select('id',{count:'exact',head:true}).eq('status','pending');
 editReviews.pending=count??0;
}
export async function loadEditReviews() {
 const {data,error}=await client().from('addon_edit_requests').select('*, proposer:profiles!addon_edit_requests_proposed_by_fkey(username)').eq('status','pending').order('id').limit(1000);
 if(error) throw new Error(error.message);
 return data as EditRequest[];
}
export async function decideEdit(id: number,accept: boolean,fields: EditField[]) {
 await call('decide_addon_edit',{request_id:id,accept,fields});
 await loadAddons();
 editReviews.pending=Math.max(0,editReviews.pending-1);
}

export const displayEditValue = (input: unknown): string => Array.isArray(input) ? input.map(v => typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.url??'') + (v.note ? ' · ' + String(v.note) : '') : String(v??'')).join('\n') || '(none)' : String(input??'');
