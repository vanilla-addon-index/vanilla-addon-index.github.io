-- Shared status is permanent. An empty shared page keeps its address and history.
create or replace function public.addons_code_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if not exists(select 1 from jsonb_array_elements(new.versions) v where v ->> 'url' = new.pinned_link) then new.pinned_link := null; end if;
 select coalesce(jsonb_agg(v order by (v ->> 'url' = new.pinned_link) desc nulls last, r.committed_at desc nulls last, position), '[]'::jsonb)
 into new.versions from jsonb_array_elements(new.versions) with ordinality each(v, position)
 left join public.repo_code_updates r on r.url = v ->> 'url';
 select jsonb_build_object('date', r.committed_at, 'url', r.history_url) into new.code_update
 from public.repo_code_updates r where r.url = new.versions -> 0 ->> 'url';
 return new;
end;
$$;

create or replace function public.addons_links() returns trigger
language plpgsql set search_path = '' as $$
declare item jsonb; clash text;
begin
 if jsonb_typeof(new.versions) is distinct from 'array' or jsonb_array_length(new.versions) > 100
  or (jsonb_array_length(new.versions) = 0 and not new.shared) then
  raise exception 'An addon needs between 1 and 100 links; shared pages may have none.';
 end if;
 for item in select * from jsonb_array_elements(new.versions) loop
  if coalesce(item ->> 'url', '') !~ '^https://\S+$' then raise exception 'Every link must start with https://'; end if;
  if char_length(coalesce(item ->> 'note', '')) > 80 then raise exception 'A version note can be at most 80 characters.'; end if;
 end loop;
 select coalesce(array_agg(distinct public.link_key(v ->> 'url')), '{}'::text[]) into new.link_keys from jsonb_array_elements(new.versions) v;
 if cardinality(new.link_keys) <> jsonb_array_length(new.versions) then raise exception 'The same link is listed twice.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(k, 1)) from unnest(new.link_keys) k order by k;
 select a.name into clash from public.addons a where a.id is distinct from new.id and a.link_keys && new.link_keys limit 1;
 if clash is not null then raise exception 'This link is already listed under "%".', clash; end if;
 return new;
end;
$$;

create function public.addon_contribution_access(target bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if auth.uid() is null or public.is_banned() then return '{"can_propose":false,"links":[]}'; end if;
 return jsonb_build_object('can_propose', exists(select 1 from public.addons a join public.addon_contributors c on c.addon_id = a.id
  where a.id = target and a.shared and c.user_id = auth.uid()),
  'links', (select coalesce(jsonb_agg(c.url), '[]') from public.addon_link_contributions c where c.addon_id = target and c.submitted_by = auth.uid()));
end;
$$;
revoke all on function public.addon_contribution_access(bigint) from public, anon, service_role;
grant execute on function public.addon_contribution_access(bigint) to authenticated;

create function public.remove_own_addon_link(target bigint, link text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot remove links.'; end if;
 perform 1 from public.addons where id = target and shared for update;
 if not found or not exists(select 1 from public.addon_link_contributions c where c.addon_id = target and c.url = link and c.submitted_by = auth.uid()) then
  raise exception 'You can only remove your own submitted links from a shared page.';
 end if;
 -- A dedicated permission is only active inside this narrow operation.
 perform set_config('app.doing', 'remove_link', true);
 update public.addons a set versions = (select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(a.versions) v where v ->> 'url' <> link) where a.id = target;
 perform set_config('app.doing', '', true);
end;
$$;
revoke all on function public.remove_own_addon_link(bigint,text) from public, anon, service_role;
grant execute on function public.remove_own_addon_link(bigint,text) to authenticated;

create table public.addon_edit_requests (
 id bigint generated always as identity primary key,
 addon_id bigint not null references public.addons on delete cascade,
 proposed_by uuid not null references public.profiles on delete cascade,
 base jsonb not null,
 changes jsonb not null,
 status text not null default 'pending' check(status in ('pending','accepted','rejected','withdrawn')),
 accepted_fields text[],
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 decided_by uuid references public.profiles on delete set null,
 decided_at timestamptz
);
create unique index addon_edit_requests_pending on public.addon_edit_requests(addon_id, proposed_by) where status = 'pending';
alter table public.addon_edit_requests enable row level security;
revoke all on public.addon_edit_requests from public, anon, authenticated, service_role;
grant select on public.addon_edit_requests to authenticated;
create policy "proposer and admins read edit requests" on public.addon_edit_requests for select to authenticated
 using(proposed_by = auth.uid() or public.is_admin());

create function public.propose_addon_edit(target bigint, input jsonb, base jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; patch jsonb := '{}'; prior jsonb := '{}'; field text; made bigint; value jsonb;
begin
 if not coalesce((public.addon_contribution_access(target) ->> 'can_propose')::boolean, false) then raise exception 'Only contributors can propose edits to this shared page.'; end if;
 if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(base) is distinct from 'object' or octet_length(input::text) > 65536 then raise exception 'Invalid edit proposal.'; end if;
 select * into a from public.addons where id = target for update;
 foreach field in array array['name','description','category','author','images','versions'] loop
  if input ? field and input -> field is distinct from base -> field then
   if base -> field is distinct from to_jsonb(a) -> field then raise exception 'The page changed while you were editing. Reload it before proposing changes.'; end if;
   value := input -> field;
   if value = 'null'::jsonb then raise exception 'An edit field cannot be null.'; end if;
   if field in ('name','description','category','author') and jsonb_typeof(value) <> 'string' then raise exception 'Invalid edit field.'; end if;
   if field in ('images','versions') and jsonb_typeof(value) <> 'array' then raise exception 'Invalid edit list.'; end if;
   if field = 'name' and (char_length(input ->> field) not between 2 and 60 or public.addon_name_key(input ->> field) = '') then raise exception 'Invalid addon name.'; end if;
   if field = 'description' and char_length(input ->> field) > 5000 then raise exception 'The description is too long.'; end if;
   if field in ('category','author') and char_length(input ->> field) > 60 then raise exception 'That field is too long.'; end if;
   if field = 'images' and (jsonb_array_length(value) > 5 or exists(select 1 from jsonb_array_elements(value) image where jsonb_typeof(image) <> 'string' or (image #>> '{}') !~ '^https://\S+$' or char_length(image #>> '{}') > 500)) then raise exception 'Invalid screenshot links.'; end if;
   if field = 'versions' and (jsonb_array_length(value) > 100 or exists(select 1 from jsonb_array_elements(value) v where jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'url') is distinct from 'string' or (v ->> 'url') !~ '^https://\S+$' or char_length(v ->> 'url') > 300 or (v ? 'note' and jsonb_typeof(v -> 'note') <> 'string') or char_length(coalesce(v ->> 'note','')) > 80)) then raise exception 'Invalid download links.'; end if;
   patch := patch || jsonb_build_object(field, value); prior := prior || jsonb_build_object(field, base -> field);
  end if;
 end loop;
 if patch = '{}' then raise exception 'There are no changes to review.'; end if;
 if (select count(*) from public.addon_edit_requests where proposed_by = auth.uid() and created_at > now() - interval '1 day') >= 20
  and not exists(select 1 from public.addon_edit_requests where addon_id = target and proposed_by = auth.uid() and status = 'pending') then raise exception 'You can propose at most 20 edits a day.' using errcode = 'LIMIT'; end if;
 insert into public.addon_edit_requests(addon_id,proposed_by,base,changes) values(target,auth.uid(),prior,patch)
 on conflict(addon_id,proposed_by) where status = 'pending' do update set base = excluded.base, changes = excluded.changes, updated_at = now()
 returning id into made;
 return made;
end;
$$;
revoke all on function public.propose_addon_edit(bigint,jsonb,jsonb) from public, anon, service_role;
grant execute on function public.propose_addon_edit(bigint,jsonb,jsonb) to authenticated;

create function public.withdraw_addon_edit(request_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot withdraw proposals.'; end if;
 update public.addon_edit_requests set status = 'withdrawn', updated_at = now()
 where id = request_id and proposed_by = auth.uid() and status = 'pending';
 if not found then raise exception 'That pending proposal does not belong to you.'; end if;
end;
$$;
revoke all on function public.withdraw_addon_edit(bigint) from public, anon, service_role;
grant execute on function public.withdraw_addon_edit(bigint) to authenticated;

create function public.decide_addon_edit(request_id bigint, accept boolean, fields text[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.addon_edit_requests; a public.addons; changed public.addons; patch jsonb := '{}'; field text;
begin
 if not public.is_admin() then raise exception 'Only admins can review edits.'; end if;
 select * into r from public.addon_edit_requests where id = request_id and status = 'pending' for update;
 if r.id is null then raise exception 'That edit is no longer pending.'; end if;
 if accept then
  if exists(select 1 from public.profiles where id = r.proposed_by and banned) then raise exception 'This contributor is banned. Reject the proposal.'; end if;
  select * into a from public.addons where id = r.addon_id for update;
  if fields is null then fields := array(select jsonb_object_keys(r.changes)); end if;
  if cardinality(fields) = 0 then raise exception 'Select at least one field to accept.'; end if;
  foreach field in array fields loop
   if not (r.changes ? field) then raise exception 'That field was not proposed.'; end if;
   if to_jsonb(a) -> field is distinct from r.base -> field then raise exception 'The % field changed since this proposal. Ask the contributor to revise it.', field; end if;
   patch := patch || jsonb_build_object(field,r.changes -> field);
  end loop;
  changed := jsonb_populate_record(a,patch);
  update public.addons set name = changed.name, description = changed.description, category = changed.category,
   author = changed.author, images = changed.images, versions = changed.versions where id = a.id;
  -- New destinations are new contributions, credited to the proposer after review.
  update public.addon_link_contributions c set submitted_by = r.proposed_by where c.addon_id = a.id
   and not exists(select 1 from jsonb_array_elements(a.versions) v where v ->> 'url' = c.url);
 end if;
 update public.addon_edit_requests set status = case when accept then 'accepted' else 'rejected' end,
  accepted_fields = case when accept then fields else null end, decided_by = auth.uid(), decided_at = now(), updated_at = now() where id = r.id;
end;
$$;
revoke all on function public.decide_addon_edit(bigint,boolean,text[]) from public, anon, service_role;
grant execute on function public.decide_addon_edit(bigint,boolean,text[]) to authenticated;

-- Deleting an imported link or rolling back a contributor must keep empty shared pages.
create or replace function public.remove_contributor_links(target_id bigint, contributor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare kept jsonb;
begin
 select coalesce(jsonb_agg(v), '[]') into kept from public.addons a, jsonb_array_elements(a.versions) v
 where a.id = target_id and not exists(select 1 from public.addon_link_contributions c where c.url = v ->> 'url' and c.submitted_by = contributor);
 update public.import_queue set status = 'pending', decided_by = null, decided_at = null, addon_id = null, problem = null
 where addon_id = target_id and decided_by = contributor and status = 'approved';
 update public.addons set versions = kept where id = target_id;
end;
$$;

create or replace function public.unapprove_import(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.import_queue; a public.addons;
begin
 if not public.is_admin() then raise exception 'Only admins can review imports.'; end if;
 select * into q from public.import_queue where addon_id = target and status = 'approved' order by decided_at desc,id desc limit 1;
 if q.id is null then raise exception 'That addon did not come from the import queue.'; end if;
 select * into a from public.addons where id = target for update;
 if a.shared then
  update public.addons set versions = (select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(versions) v where public.link_key(v ->> 'url') <> q.key) where id = target;
 else delete from public.addons where id = target;
 end if;
 update public.import_queue set status = 'pending',decided_by = null,decided_at = null,addon_id = null,problem = null where id = q.id;
 perform public.log_action('import.requeue',q.name,null,jsonb_build_object('url',q.url));
end;
$$;

notify pgrst, 'reload schema';

create or replace function public.addons_links_member() returns trigger
language plpgsql set search_path = '' as $$
declare
	main_key text := public.link_key(new.versions -> 0 ->> 'url');
begin
	-- The database's own work (auth.uid() is empty), an admin, and a restore from the trash.
	if auth.uid() is null or public.is_admin() or public.doing('restore') or public.doing('add_link') or public.doing('remove_link') then
		return new;
	end if;
	if tg_op = 'INSERT' then
		if cardinality(new.link_keys) > 1 then
			raise exception 'An addon is posted with one link. Post another version as an addon of its own.';
		end if;
	elsif exists (
		select 1 from unnest(new.link_keys) k where k <> main_key and not k = any (old.link_keys)
	) then
		raise exception 'Only an admin can add another link to an addon. Post another version as an addon of its own.';
	end if;
	return new;
end;
$$;

create or replace function public.nightly_waiting(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can ask what is waiting.';
	end if;
	return jsonb_build_object(
		'reports', (select count(*) from public.reports where status = 'open'),
		'suggestions', (select count(*) from public.group_suggestions where status = 'pending' and kind = 'user') + (select count(*) from public.addon_edit_requests where status = 'pending')
	);
end;
$$;

create or replace function public.addons_edit_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	hourly integer;
	in_hour integer;
	in_day integer;
begin
	if auth.uid() is null or public.is_owner() or public.doing('revert') or public.doing('remove_link') then
		return new;
	end if;
	-- Grouping, and the credit an import gets, are not edits of the addon.
	if (new.name, new.description, new.category, new.author, new.versions, new.images)
		is not distinct from (old.name, old.description, old.category, old.author, old.versions, old.images) then
		return new;
	end if;

	hourly := case when public.is_admin() then 100 else 10 end;
	-- Counted from the log, so a save that changed nothing does not count.
	select count(*) filter (where at > now() - interval '1 hour'), count(*)
	into in_hour, in_day
	from public.activity_log
	where actor = auth.uid() and action = 'addon.update' and at > now() - interval '1 day';
	if in_hour >= hourly then
		raise exception 'You can make at most % edits an hour. Try again later.', hourly using errcode = 'LIMIT';
	end if;
	if in_day >= 50 and not public.is_admin() then
		raise exception 'You can make at most 50 edits a day. Try again tomorrow.' using errcode = 'LIMIT';
	end if;
	return new;
end;
$$;

create or replace function public.revert_addon(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	entry public.activity_log;
	b jsonb;
 prior public.addons;
begin
	if not public.is_admin() then
		raise exception 'Only admins can revert edits.';
	end if;
	select * into entry from public.activity_log where id = log_id and action in ('addon.update', 'addon.revert');
	if entry.id is null then
		raise exception 'That log line is not an edit.';
	end if;
	b := entry.details -> 'before';
	if b is null then
		raise exception 'That edit is too old to revert: what an addon looked like before an edit is kept for 90 days.';
	end if;


 if jsonb_typeof(entry.details -> 'removed_links') = 'array' then
  select * into prior from public.addons where id = entry.addon_id for update;
  if prior.id is null then raise exception 'That addon no longer exists.'; end if;
  perform set_config('app.doing', 'revert', true);
  update public.addons a set versions = a.versions || (
   select coalesce(jsonb_agg(v),'[]') from jsonb_array_elements(entry.details -> 'removed_links') v
   where not exists(select 1 from jsonb_array_elements(a.versions) existing where existing ->> 'url' = v ->> 'url')
  ), pinned_link = coalesce(a.pinned_link,b ->> 'pinned_link') where a.id = entry.addon_id;
  update public.addon_link_contributions c set submitted_by = entry.actor where c.addon_id = entry.addon_id
   and not exists(select 1 from jsonb_array_elements(prior.versions) v where v ->> 'url' = c.url);
  perform set_config('app.doing', '', true);
  return;
 end if;
 if jsonb_typeof(entry.details -> 'added_links') = 'array' then
  perform set_config('app.doing', 'revert', true);
  update public.addons a set versions = (select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(a.versions) v where not (entry.details -> 'added_links') ? (v ->> 'url')),
   shared = case when a.versions = entry.details -> 'after' -> 'versions' then coalesce((b ->> 'shared')::boolean, false) else a.shared end,
   owner = case when a.versions = entry.details -> 'after' -> 'versions' then (select id from public.profiles where id = (b ->> 'owner')::uuid) else a.owner end
  where a.id = entry.addon_id;
  perform set_config('app.doing', '', true);
  return;
 end if;

	perform set_config('app.doing', 'revert', true);
	update public.addons
	set name = b ->> 'name',
		description = coalesce(b ->> 'description', ''),
		category = b ->> 'category',
		author = coalesce(b ->> 'author', ''),
		versions = b -> 'versions',
		images = array(select jsonb_array_elements_text(coalesce(b -> 'images', '[]'))),
        owner = (select id from public.profiles where id = (b ->> 'owner')::uuid), shared = coalesce((b ->> 'shared')::boolean, false), pinned_link = b ->> 'pinned_link'
	where id = entry.addon_id;
	if not found then
		raise exception 'That addon no longer exists. Look for it in the trash.';
	end if;
	perform set_config('app.doing', '', true);
end;
$$;
