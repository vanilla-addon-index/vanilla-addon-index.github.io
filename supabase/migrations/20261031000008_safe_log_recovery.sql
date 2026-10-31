-- Field-level recovery never replaces a whole addon snapshot.
create function private.edit_recovery_plan(source_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; f text; fields text[]; patch jsonb := '{}'; conflicts jsonb := '[]'; link jsonb; expected jsonb; current_link jsonb;
begin
 select * into e from public.activity_log where id=source_id;
 select * into a from public.addons where id=e.addon_id;
 fields := array(select jsonb_array_elements_text(coalesce(e.details->'changed','[]')));
 if a.id is null then return jsonb_build_object('conflicts',jsonb_build_array('addon'),'patch','{}','current','{}'); end if;
 if not coalesce(e.details ? 'after',false) or cardinality(fields)=0 then
  return jsonb_build_object('conflicts',jsonb_build_array('unrecorded changes'),'patch','{}','current',to_jsonb(a));
 end if;
 foreach f in array fields loop
  -- Availability is derived from the links by a trigger, never restored from History.
  if f in ('unavailable_links','slug','aliases','link_code_updates') then continue; end if;
  if f not in ('name','description','category','author','versions','images','pinned_link','shared','separate_name') then conflicts:=conflicts||to_jsonb(f); continue; end if;
  if f='versions' and (jsonb_typeof(e.details->'added_links')='array' or jsonb_typeof(e.details->'removed_links')='array') then
   for link in select value from jsonb_array_elements(coalesce(e.details->'added_links',e.details->'removed_links')) loop
    if jsonb_typeof(link)='string' then
     select v into expected from jsonb_array_elements(e.details->'after'->'versions') v where v->>'url'=link#>>'{}';
    else expected:=link; end if;
    select v into current_link from jsonb_array_elements(a.versions) v where v->>'url'=expected->>'url';
    if current_link is not null and current_link is distinct from expected then conflicts:=conflicts||to_jsonb(f); end if;
   end loop;
  elsif to_jsonb(a)->f is distinct from e.details->'before'->f and to_jsonb(a)->f is distinct from e.details->'after'->f then
   conflicts:=conflicts||to_jsonb(f);
  elsif not (e.details->'before' ? f) or not(e.details->'after' ? f) then
   conflicts:=conflicts||to_jsonb(f);
  else patch:=patch||jsonb_build_object(f,e.details->'before'->f);
  end if;
 end loop;
 return jsonb_build_object('conflicts',conflicts,'patch',patch,'current',to_jsonb(a));
end;
$$;
revoke all on function private.edit_recovery_plan(bigint) from public, anon, authenticated, service_role;

create function private.finish_edit_recovery(e public.activity_log, newest_before bigint, manual boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare made bigint;
begin
 select id into made from public.activity_log where id>newest_before and addon_id=e.addon_id and actor=auth.uid() and action in ('addon.update','addon.revert') order by id desc limit 1;
 if made is null then
  perform public.log_action('addon.recovery',e.subject,e.addon_id,jsonb_build_object('undid',e.id,'manual',manual,'unchanged',true));
 else
  update public.activity_log set details=details||jsonb_build_object('undid',e.id,'manual',manual) where id=made;
 end if;
end;
$$;
revoke all on function private.finish_edit_recovery(public.activity_log,bigint,boolean) from public, anon, authenticated, service_role;

create or replace function public.recover_edit(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; changed public.addons; plan jsonb; newest_before bigint;
begin
 if not public.is_admin() then raise exception 'Only admins can revert edits.'; end if;
 select * into e from public.activity_log where id=log_id and action in ('addon.update','addon.revert') for update;
 if e.id is null then raise exception 'That log line is not an edit.'; end if;
 if e.details->'before' is null then raise exception 'That edit is too old to revert: what an addon looked like before an edit is kept for 90 days.'; end if;
 if exists(select 1 from public.activity_log where details->>'undid'=e.id::text and action in ('addon.update','addon.revert','addon.recovery')) then raise exception 'This edit has already been recovered.'; end if;
 select * into a from public.addons where id=e.addon_id for update;
 if a.id is null then raise exception 'That addon no longer exists. Look for it in the trash.'; end if;
 plan:=private.edit_recovery_plan(e.id);
 if jsonb_array_length(plan->'conflicts')>0 then raise exception 'Conflicts with later changes—review manually.'; end if;
 select coalesce(max(id),0) into newest_before from public.activity_log;
 if jsonb_typeof(e.details->'added_links')='array' or jsonb_typeof(e.details->'removed_links')='array' then
  perform private.apply_edit_recovery(e.id);
 else
  changed:=jsonb_populate_record(a,plan->'patch');
  perform set_config('app.doing','revert',true);
  update public.addons set name=changed.name,description=changed.description,category=changed.category,author=changed.author,
   versions=changed.versions,images=changed.images,pinned_link=changed.pinned_link,shared=changed.shared,separate_name=changed.separate_name where id=a.id;
  perform set_config('app.doing','',true);
 end if;
 perform private.finish_edit_recovery(e,newest_before,false);
end;
$$;

create function public.recovery_comparison(log_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; plan jsonb; later jsonb;
begin
 if not public.is_admin() then raise exception 'Only admins can inspect recovery status.'; end if;
 select * into e from public.activity_log where id=log_id and action in ('addon.update','addon.revert');
 if e.id is null then raise exception 'That log line is not an edit.'; end if;
 plan:=private.edit_recovery_plan(e.id);
 select coalesce(jsonb_agg(jsonb_build_object('actor',l.actor_name,'at',l.at,'fields',l.details->'changed') order by l.id desc),'[]') into later
 from (select * from public.activity_log where addon_id=e.addon_id and id>e.id and action in ('addon.update','addon.revert') order by id desc limit 50) l;
 return jsonb_build_object('entry',to_jsonb(e),'current',plan->'current','conflicts',plan->'conflicts','later',later);
end;
$$;
revoke all on function public.recovery_comparison(bigint) from public, anon, service_role;
grant execute on function public.recovery_comparison(bigint) to authenticated;

-- Manual review uses the same current-version check as the normal editor.
create function public.resolve_log_edit(log_id bigint, input jsonb, expected_updated timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; changed public.addons; patch jsonb; newest_before bigint;
begin
 if not public.is_admin() then raise exception 'Only admins can resolve edits.'; end if;
 select * into e from public.activity_log where id=log_id and action in ('addon.update','addon.revert') for update;
 if e.id is null then raise exception 'That log line is not an edit.'; end if;
 if exists(select 1 from public.activity_log where details->>'undid'=e.id::text and action in ('addon.update','addon.revert','addon.recovery')) then raise exception 'This edit has already been recovered.'; end if;
 select * into a from public.addons where id=e.addon_id for update;
 if a.id is null or a.updated_at is distinct from expected_updated then raise exception 'This addon changed while you were reviewing it. Reload before saving; nothing was overwritten.'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into patch from jsonb_each(input) where key in ('name','description','category','author','versions','images');
 changed:=jsonb_populate_record(a,patch);
 select coalesce(max(id),0) into newest_before from public.activity_log;
 update public.addons set name=changed.name,description=changed.description,category=changed.category,author=changed.author,versions=changed.versions,images=changed.images where id=a.id;
 perform private.finish_edit_recovery(e,newest_before,true);
end;
$$;
revoke all on function public.resolve_log_edit(bigint,jsonb,timestamptz) from public, anon, service_role;
grant execute on function public.resolve_log_edit(bigint,jsonb,timestamptz) to authenticated;

-- Snapshot current grouping as well as its prior state for new group events.
create or replace function public.log_action(action text, subject text, addon bigint, details jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if action in ('group.add','group.remove','group.main','group.undo') and jsonb_typeof(details->'groups_before')='array' then
  details:=details||jsonb_build_object('groups_after',public.groups_of(array(select (v->>'id')::bigint from jsonb_array_elements(details->'groups_before') v)));
 end if;
 insert into public.activity_log(actor,actor_name,action,subject,addon_id,details)
 values(auth.uid(),(select username from public.profiles where id=auth.uid()),action,subject,addon,details);
end;
$$;

create function private.group_recovery_conflict(e public.activity_log) returns boolean
language sql stable security definer set search_path = '' as $$
 select case when e.details ? 'groups_after' then
  public.groups_of(array(select (v->>'id')::bigint from jsonb_array_elements(e.details->'groups_before') v)) is distinct from e.details->'groups_after'
 else true end;
$$;
revoke all on function private.group_recovery_conflict(public.activity_log) from public, anon, authenticated, service_role;

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
	perform 1 from public.addons where id in (select (v->>'id')::bigint from jsonb_array_elements(before) v) order by id for update;
	if private.group_recovery_conflict(entry) then raise exception 'Conflicts with later grouping changes—review manually.'; end if;
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


drop function public.log_recovery_status(bigint[]);
create function public.log_recovery_status(ids bigint[])
returns table(log_id bigint, recovery_id bigint, actor_name text, recovered_at timestamptz, available boolean, reason text, conflicts jsonb)
language plpgsql security definer set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can inspect recovery status.'; end if;
 if coalesce(cardinality(ids),0) > 100 then raise exception 'Request at most 100 entries at a time.'; end if;
 return query
 select e.id, r.id, r.actor_name, r.at,
  case
   when e.action in ('addon.update','addon.revert') then r.id is null and jsonb_array_length(private.edit_recovery_plan(e.id)->'conflicts')=0 and coalesce(e.details ? 'before',false) and exists(select 1 from public.addons a where a.id = e.addon_id)
   when e.action in ('group.add','group.remove','group.main','group.undo') then r.id is null and not private.group_recovery_conflict(e) and jsonb_array_length(coalesce(e.details -> 'groups_before','[]')) > 0
   when e.action in ('report.handle','report.dismiss') then r.id is null and exists(select 1 from public.reports p where p.decision_log_id = e.id and p.status <> 'open')
   else false
  end,
  case
   when r.id is not null then null
   when e.action in ('addon.update','addon.revert') and jsonb_array_length(private.edit_recovery_plan(e.id)->'conflicts')>0 then 'Conflicts with later changes—review manually.'
   when e.action in ('group.add','group.remove','group.main','group.undo') and not (e.details ? 'groups_after') then 'The earlier grouping cannot be verified safely; review the current grouping.'
   when e.action in ('group.add','group.remove','group.main','group.undo') and private.group_recovery_conflict(e) then 'Conflicts with later grouping changes—review manually.'
   when e.action in ('addon.update','addon.revert') and not coalesce(e.details ? 'before',false) then 'The earlier addon data is no longer available.'
   when e.action in ('addon.update','addon.revert') and not exists(select 1 from public.addons a where a.id = e.addon_id) then 'The addon is no longer live. Look in the Trash.'
   when e.action in ('report.handle','report.dismiss') and not exists(select 1 from public.reports p where p.decision_log_id = e.id and p.status <> 'open') then
    case when not coalesce(e.details ? 'report_id',false) then 'This older decision cannot be matched safely; review it manually.' else 'This report decision is no longer current.' end
   else null
  end,
  case when e.action in ('addon.update','addon.revert') then private.edit_recovery_plan(e.id)->'conflicts' else '[]'::jsonb end
 from public.activity_log e
 left join lateral (
  select u.id,u.actor_name,u.at from public.activity_log u
  where u.details ->> 'undid' = e.id::text
   and u.action in ('addon.update','addon.revert','addon.recovery','group.undo','report.reopen')
   and ((e.action in ('addon.update','addon.revert') and u.action in ('addon.update','addon.revert','addon.recovery'))
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

create or replace function public.rollback_account(target uuid, since timestamptz, preview boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
 archived public.deleted_account_recovery;
	line public.activity_log;
	steps jsonb := '[]';
	skipped jsonb := '[]';
	first_edit bigint;
 recovered_addons bigint[] := '{}';
 suggestion record;
	later integer;
	found_id bigint;
	found_user uuid;
begin
	if not public.is_admin() then
		raise exception 'Only admins can roll an account back.';
	end if;
	if target = auth.uid() then
		raise exception 'You cannot roll yourself back.';
	end if;
	select username, is_owner into who, target_is_owner from public.profiles where id = target;
	if who is null then
  select * into archived from public.deleted_account_recovery where id = target;
  if archived.id is null then raise exception 'That account does not exist.'; end if;
  if not public.is_owner() then raise exception 'Only the owner can roll a deleted account back.'; end if;
  who := 'deleted account ' || archived.id::text;
 end if;
	if target_is_owner then
		raise exception 'The owner cannot be rolled back.';
	end if;
	if public.is_staff(target) and not public.is_owner() then
		raise exception 'Only the owner can roll an admin back.';
	end if;

	begin
  -- Approved suggestions retain contributor ownership even though approval was
  -- performed by an admin. Remove only still-owned links from this time window.
  for suggestion in select r.*, a.name from public.addon_link_requests r
   join public.addons a on a.id = r.addon_id
   where (r.proposed_by = target or r.id = any(archived.link_requests)) and r.created_at >= since
    and r.status = 'accepted' and exists(select 1 from public.addon_link_contributions c
     where c.addon_id = r.addon_id and c.url = r.url and (c.submitted_by = target or (c.submitted_by is null and c.url = any(archived.links))))
  loop
   perform set_config('app.doing', 'remove_link', true);
   update public.addons a set versions = (select coalesce(jsonb_agg(v), '[]')
    from jsonb_array_elements(a.versions) v where v ->> 'url' <> suggestion.url)
   where a.id = suggestion.addon_id;
   perform set_config('app.doing', '', true);
   steps := steps || jsonb_build_object('kind', 'revert', 'subject', suggestion.name);
  end loop;
  update public.addon_link_requests set status = 'withdrawn', decided_at = now()
   where (proposed_by = target or id = any(archived.link_requests)) and created_at >= since and status = 'pending';
		for line in
			select * from public.activity_log where (actor = target or recovery_actor = target) and at >= since order by id desc
		loop
			begin
    if line.action in ('addon.update','addon.revert') and exists(select 1 from public.activity_log u where u.details->>'undid'=line.id::text and u.action in ('addon.update','addon.revert','addon.recovery')) then continue; end if;
				if line.action = 'addon.delete' then
					found_id := (line.details ->> 'trash_id')::bigint;
					if exists (select 1 from public.addon_trash where id = found_id) then
						perform public.restore_addon(found_id);
						steps := steps || jsonb_build_object('kind', 'restore', 'subject', line.subject);
					end if;

				elsif line.action = 'addon.update' and (jsonb_typeof(line.details -> 'added_links') = 'array' or jsonb_typeof(line.details -> 'removed_links') = 'array') then
     if exists(select 1 from public.addons where id = line.addon_id) then
      perform public.revert_addon(line.id);
      -- Shared-page imports are logged as added links, not import.approve.
      -- Requeue this deleted account's approvals when their links were removed.
      update public.import_queue q set status = 'pending', decided_by = null, decided_at = null,
       addon_id = null, problem = null
      where q.id = any(archived.imports) and q.status = 'approved' and q.decided_by is null
       and q.addon_id = line.addon_id and q.decided_at >= since
       and not exists(select 1 from public.addons a, jsonb_array_elements(a.versions) v
        where a.id = line.addon_id and public.link_key(v ->> 'url') = q.key);
      steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject);
     end if;
    elsif line.action in ('addon.update', 'addon.revert') then
     if exists(select 1 from public.addons where id=line.addon_id)
      and not exists(select 1 from public.activity_log where (actor=target or recovery_actor=target) and at>=since and addon_id=line.addon_id and action in ('addon.create','import.approve')) then
      perform public.revert_addon(line.id);
      if not (line.addon_id=any(recovered_addons)) then
       steps:=steps||jsonb_build_object('kind','revert','subject',line.subject,'others',0);
       recovered_addons:=array_append(recovered_addons,line.addon_id);
      end if;
     end if;

				elsif line.action = 'import.approve' then
					if exists (select 1 from public.addons where id = line.addon_id) then
						perform set_config('app.doing', 'rollback', true);
						if exists(select 1 from public.addons where id = line.addon_id and shared) then
        perform public.remove_contributor_links(line.addon_id, target);
        steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject);
       elsif exists (select 1 from public.import_queue where addon_id = line.addon_id and status = 'approved') then
							perform public.unapprove_import(line.addon_id);
							steps := steps || jsonb_build_object('kind', 'unapprove', 'subject', line.subject);
						else
							delete from public.addons where id = line.addon_id;
							steps := steps || jsonb_build_object('kind', 'delete', 'subject', line.subject);
						end if;
					end if;

				elsif line.action = 'addon.create' then
					if exists (select 1 from public.addons where id = line.addon_id) then
						perform set_config('app.doing', 'rollback', true);
						if exists(select 1 from public.addons where id = line.addon_id and shared) then
       perform public.remove_contributor_links(line.addon_id, target);
      else delete from public.addons where id = line.addon_id;
      end if;
      steps := steps || jsonb_build_object('kind', 'delete', 'subject', line.subject);
					end if;

				elsif line.action = 'import.reject' then
					select id into found_id
					from public.import_queue
					where url = line.details ->> 'url' and status = 'rejected';
					if found_id is not null then
						perform public.decide_imports(array[found_id], 'pending');
						steps := steps || jsonb_build_object('kind', 'requeue', 'subject', line.subject);
					end if;

				elsif line.action in ('group.add', 'group.remove', 'group.main', 'group.undo') then
					if jsonb_array_length(coalesce(line.details -> 'groups_before', '[]')) > 0
						and not exists (
							select 1 from public.activity_log u
							where u.action = 'group.undo' and (u.details ->> 'undid')::bigint = line.id
						) then
						perform set_config('app.doing', 'rollback', true);
						perform public.undo_grouping(line.id);
						steps := steps || jsonb_build_object('kind', 'ungroup', 'subject', line.subject);
					end if;

				elsif line.action = 'user.ban' then
					select id into found_user from public.profiles where username = line.subject and banned;
					if found_user is not null then
						perform public.set_banned(found_user, false);
						steps := steps || jsonb_build_object('kind', 'unban', 'subject', line.subject);
					end if;

				elsif line.action = 'group.suggest' then
					delete from public.group_suggestions s
					using public.addons t
					where (s.suggested_by = target or s.id = any(archived.suggestions)) and s.kind = 'user' and s.status = 'pending'
						and s.addon_id = line.addon_id
						and t.id = s.target_id and t.name = line.details ->> 'target';
					if found then
						steps := steps || jsonb_build_object('kind', 'withdraw', 'subject', line.subject || ' as a version of ' || (line.details ->> 'target'));
					end if;

                elsif line.action in ('report.handle', 'report.dismiss') then
                    if public.reopen_report(line.id) then
                        steps := steps || jsonb_build_object('kind', 'reopen', 'subject', line.subject);
                    end if;

				elsif line.action = 'report.create' then
					select id into found_id
					from public.reports
					where (reported_by = target or id = any(archived.reports)) and addon_id = line.addon_id and status = 'open';
					if found_id is not null then
						perform public.decide_report(found_id, 'dismissed');
						steps := steps || jsonb_build_object('kind', 'dismiss', 'subject', line.subject);
					end if;
				end if;
			exception when others then
				skipped := skipped || jsonb_build_object('action', line.action, 'subject', line.subject, 'why', sqlerrm);
			end;
		end loop;
		perform set_config('app.doing', '', true);

		if preview then
			-- Takes back everything done in this block; what was noted down stays.
			raise exception 'preview only' using errcode = 'RBACK';
		end if;
		perform public.log_action(
			'user.rollback',
			who,
			null,
			jsonb_build_object('since', since, 'steps', jsonb_array_length(steps), 'skipped', jsonb_array_length(skipped), 'skipped_details', skipped)
		);
	exception when sqlstate 'RBACK' then
		null;
	end;

	return jsonb_build_object('steps', steps, 'skipped', skipped);
end;
$$;


notify pgrst, 'reload schema';
