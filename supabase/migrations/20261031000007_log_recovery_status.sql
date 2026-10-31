-- Recovery links are durable audit data, independent of the currently displayed page.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create index activity_log_recovery_source_idx on public.activity_log ((details ->> 'undid'), id desc)
 where action in ('addon.update', 'addon.revert', 'addon.recovery', 'group.undo', 'report.reopen');

create or replace function private.apply_edit_recovery(log_id bigint) returns void
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

revoke all on function private.apply_edit_recovery(bigint) from public, anon, authenticated, service_role;

-- Each original entry can be recovered only once.
create function public.recover_edit(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
 entry public.activity_log;
 recovered bigint;
 newest_before bigint;
 made bigint;
begin
 if not public.is_admin() then raise exception 'Only admins can revert edits.'; end if;
 select * into entry from public.activity_log where id = log_id and action in ('addon.update','addon.revert') for update;
 if entry.id is null then raise exception 'That log line is not an edit.'; end if;
 if entry.details -> 'before' is null then
  raise exception 'That edit is too old to revert: what an addon looked like before an edit is kept for 90 days.';
 end if;
 select id into recovered from public.activity_log
 where action in ('addon.revert','addon.recovery') and details ->> 'undid' = log_id::text order by id desc limit 1;
 if recovered is not null then
  raise exception 'This edit has already been recovered or its recovery status changed. Refresh the log and review it before reverting again.';
 end if;
 -- Serialize changes to this addon before identifying the audit event created below.
 perform 1 from public.addons where id = entry.addon_id for update;
 if not found then raise exception 'That addon no longer exists. Look for it in the trash.'; end if;
 select coalesce(max(id),0) into newest_before from public.activity_log;
 perform private.apply_edit_recovery(log_id);
 select id into made from public.activity_log
 where id > newest_before and addon_id = entry.addon_id and actor = auth.uid() and action = 'addon.revert'
 order by id desc limit 1;
 if made is null and recovered is not null then
  return;
 elsif made is null then
  -- A no-op is still a completed recovery, but must not consume the edit budget.
  perform public.log_action('addon.recovery',entry.subject,entry.addon_id,jsonb_build_object('undid',log_id,'unchanged',true));
 else
  update public.activity_log set details = details || jsonb_build_object('undid',log_id) where id = made;
 end if;
end;
$$;
revoke all on function public.recover_edit(bigint) from public, anon, service_role;
grant execute on function public.recover_edit(bigint) to authenticated;

-- Existing callers, including account rollback, cannot silently repeat a recovery.
create or replace function public.revert_addon(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
 perform public.recover_edit(log_id);
end;
$$;

create or replace function public.undo_grouping(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	entry public.activity_log;
	before jsonb;
	ids bigint[];
	after jsonb;
	item jsonb;
	gid bigint;
begin
	if not public.is_admin() then
		raise exception 'Only admins can change groups.';
	end if;
	select * into entry from public.activity_log where id = log_id and action like 'group.%' for update;
	if exists(select 1 from public.activity_log where action = 'group.undo' and details ->> 'undid' = log_id::text) then
		raise exception 'That group change has already been recovered.';
	end if;
	before := entry.details -> 'groups_before';
	if before is null or jsonb_array_length(before) = 0 then
		raise exception 'That log line has nothing to undo.';
	end if;
	perform public.group_limit();

	ids := array(select (b ->> 'id')::bigint from jsonb_array_elements(before) b);
	after := public.groups_of(ids);
	for item in select * from jsonb_array_elements(before) loop
		update public.addons
		set group_id = (item ->> 'group_id')::bigint, is_main = coalesce((item ->> 'is_main')::boolean, false)
		where id = (item ->> 'id')::bigint;
	end loop;
	-- Addons may have been deleted or regrouped since; every group touched is left sound.
	for gid in
		select distinct (g ->> 'group_id')::bigint
		from jsonb_array_elements(before || after) g
		where g ->> 'group_id' is not null
	loop
		perform public.tidy_group(gid);
	end loop;

	perform public.log_action(
		'group.undo', entry.subject, entry.addon_id, jsonb_build_object('groups_before', after, 'undid', log_id)
	);
end;
$$;

-- Resolve the requested original entries against the whole audit trail and current state.
create function public.log_recovery_status(ids bigint[])
returns table(log_id bigint, recovery_id bigint, actor_name text, recovered_at timestamptz, available boolean, reason text)
language plpgsql security definer set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can inspect recovery status.'; end if;
 if coalesce(cardinality(ids),0) > 100 then raise exception 'Request at most 100 entries at a time.'; end if;
 return query
 select e.id, r.id, r.actor_name, r.at,
  case
   when e.action in ('addon.update','addon.revert') then coalesce(e.details ? 'before',false) and exists(select 1 from public.addons a where a.id = e.addon_id)
   when e.action in ('group.add','group.remove','group.main','group.undo') then r.id is null and jsonb_array_length(coalesce(e.details -> 'groups_before','[]')) > 0
   when e.action in ('report.handle','report.dismiss') then r.id is null and exists(select 1 from public.reports p where p.decision_log_id = e.id and p.status <> 'open')
   else false
  end,
  case
   when r.id is not null then null
   when e.action in ('addon.update','addon.revert') and not coalesce(e.details ? 'before',false) then 'The earlier addon data is no longer available.'
   when e.action in ('addon.update','addon.revert') and not exists(select 1 from public.addons a where a.id = e.addon_id) then 'The addon is no longer live. Look in the Trash.'
   when e.action in ('report.handle','report.dismiss') and not exists(select 1 from public.reports p where p.decision_log_id = e.id and p.status <> 'open') then
    case when not coalesce(e.details ? 'report_id',false) then 'This older decision cannot be matched safely; review it manually.' else 'This report decision is no longer current.' end
   else null
  end
 from public.activity_log e
 left join lateral (
  select u.id,u.actor_name,u.at from public.activity_log u
  where u.details ->> 'undid' = e.id::text
   and u.action in ('addon.revert','addon.recovery','group.undo','report.reopen')
   and ((e.action in ('addon.update','addon.revert') and u.action in ('addon.revert','addon.recovery'))
    or (e.action in ('group.add','group.remove','group.main','group.undo') and u.action = 'group.undo')
    or (e.action in ('report.handle','report.dismiss') and u.action = 'report.reopen'))
  order by u.id desc limit 1
 ) r on true
 where e.id = any(ids) and e.action in ('addon.update','addon.revert','group.add','group.remove','group.main','group.undo','report.handle','report.dismiss');
end;
$$;
revoke all on function public.log_recovery_status(bigint[]) from public, anon, service_role;
grant execute on function public.log_recovery_status(bigint[]) to authenticated;
notify pgrst, 'reload schema';
