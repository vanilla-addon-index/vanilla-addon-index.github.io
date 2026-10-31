-- Tie a report's current decision to its exact audit entry. The reference survives
-- account deletion and distinguishes repeated decisions and reports on one addon.
alter table public.reports add column decision_log_id bigint references public.activity_log;
create unique index reports_decision_log_idx on public.reports(decision_log_id)
 where decision_log_id is not null;

-- Old decisions recorded the addon, reason, actor and transaction time, but no
-- report id. Link only unambiguous matches; never guess between reports.
with matches as (
 select r.id as report_id, l.id as log_id,
  count(*) over (partition by r.id) as report_matches,
  count(*) over (partition by l.id) as log_matches
 from public.reports r join public.activity_log l
  on l.addon_id = r.addon_id and l.actor is not distinct from r.decided_by and l.at = r.decided_at
   and l.details ->> 'reason' = r.reason
   and l.action = case r.status when 'handled' then 'report.handle' when 'dismissed' then 'report.dismiss' end
 where r.status <> 'open'
)
update public.reports r set decision_log_id = m.log_id from matches m
 where r.id = m.report_id and m.report_matches = 1 and m.log_matches = 1;

create or replace function public.decide_report(report bigint, outcome text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
 if not public.is_admin() then raise exception 'Only admins can close reports.'; end if;
 if outcome is null or outcome not in ('handled', 'dismissed') then raise exception 'Unknown outcome.'; end if;
 update public.reports set status = outcome, decided_by = auth.uid(), decided_at = now()
 where id = report and status = 'open' returning * into r;
 if r.id is null then raise exception 'That report has already been closed.'; end if;
 perform public.log_action(
  case outcome when 'handled' then 'report.handle' else 'report.dismiss' end,
  (select name from public.addons where id = r.addon_id), r.addon_id,
  jsonb_build_object('reason', r.reason, 'report_id', r.id)
 );
 -- log_action inserts exactly one activity row; currval is local to this session.
 update public.reports set decision_log_id = currval(pg_get_serial_sequence('public.activity_log', 'id'))
 where id = r.id;
end;
$$;

-- Owner-only recovery avoids introducing an unlimited reopen/close loop for admins.
-- False means this decision has already been superseded or its report is gone.
create function public.reopen_report(log_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare entry public.activity_log; r public.reports;
begin
 if not public.is_owner() then raise exception 'Only the owner can reopen reports.'; end if;
 select * into entry from public.activity_log
 where id = log_id and action in ('report.handle', 'report.dismiss');
 if entry.id is null then raise exception 'That log line is not a report decision.'; end if;
 select * into r from public.reports where decision_log_id = log_id for update;
 if r.id is null then
  if not (entry.details ? 'report_id') and exists(
   select 1 from public.reports p where p.addon_id = entry.addon_id and p.status <> 'open'
    and p.decided_at = entry.at and p.decided_by is not distinct from entry.actor
    and p.reason = entry.details ->> 'reason'
  ) then
   raise exception 'This older decision cannot be matched to one report safely; manual review is required.';
  end if;
  return false;
 end if;
 if r.status = 'open' then return false; end if;
 if exists(select 1 from public.reports p where p.id <> r.id and p.status = 'open'
  and p.addon_id = r.addon_id and p.reported_by = r.reported_by) then
  raise exception 'A newer report from this member is already open; review both reports before reopening this one.';
 end if;
 update public.reports set status = 'open', decided_by = null, decided_at = null, decision_log_id = null
 where id = r.id;
 perform public.log_action('report.reopen', (select name from public.addons where id = r.addon_id), r.addon_id,
  jsonb_build_object('report_id', r.id, 'reason', r.reason, 'previous_status', r.status, 'undid', entry.id));
 return true;
end;
$$;
revoke all on function public.reopen_report(bigint) from public, anon, service_role;
grant execute on function public.reopen_report(bigint) to authenticated;

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
					-- One revert per addon, to before the account first touched it. An addon the
					-- account itself posted or imported in this time is dealt with as a whole below.
					select min(id) into first_edit
					from public.activity_log
					where (actor = target or recovery_actor = target) and at >= since and addon_id = line.addon_id
						and action in ('addon.update', 'addon.revert');
					if line.id = first_edit
						and exists (select 1 from public.addons where id = line.addon_id)
						and not exists (
							select 1 from public.activity_log
							where (actor = target or recovery_actor = target) and at >= since and addon_id = line.addon_id
								and action in ('addon.create', 'import.approve')
						)
						-- Nothing to do when it already reads as it did before that edit.
						and exists (
							select 1
							from public.addons a, jsonb_each(line.details -> 'before') b
							where a.id = line.addon_id
								and b.key in ('name', 'description', 'category', 'author', 'versions', 'images')
								and to_jsonb(a) -> b.key is distinct from b.value
						) then
						select count(*) into later
						from public.activity_log
						where addon_id = line.addon_id and id > first_edit and actor is distinct from target and recovery_actor is distinct from target
							and action in ('addon.update', 'addon.revert');
						perform public.revert_addon(line.id);
						steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject, 'others', later);
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
			jsonb_build_object('since', since, 'steps', jsonb_array_length(steps), 'skipped', jsonb_array_length(skipped))
		);
	exception when sqlstate 'RBACK' then
		null;
	end;

	return jsonb_build_object('steps', steps, 'skipped', skipped);
end;
$$;


notify pgrst, 'reload schema';
