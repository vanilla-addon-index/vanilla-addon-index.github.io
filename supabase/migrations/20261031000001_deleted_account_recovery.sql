-- Keep recovery possible after deletion without retaining the login, username or account id.
-- Only the owner can discover deleted accounts or run their account-level rollback.
create table public.deleted_account_recovery (
 id uuid primary key default gen_random_uuid(),
 deleted_at timestamptz not null default now(),
 links text[] not null,
 imports bigint[] not null,
 link_requests bigint[] not null,
 suggestions bigint[] not null,
 reports bigint[] not null
);
alter table public.deleted_account_recovery enable row level security;
revoke all on public.deleted_account_recovery from public, anon, authenticated, service_role;

alter table public.activity_log add column recovery_actor uuid references public.deleted_account_recovery;
create index activity_log_recovery_actor_idx on public.activity_log(recovery_actor, at desc)
 where recovery_actor is not null;

-- Runs before the auth cascade, including deletion outside the site's account RPC.
create function public.preserve_deleted_account_recovery() returns trigger
language plpgsql security definer set search_path = '' as $$
declare recovery uuid;
begin
 -- Lock the profile against concurrent privilege changes, then capture provenance
 -- before its foreign keys are cleared by the deletion cascade.
 perform 1 from public.profiles where id = old.id for update;
 insert into public.deleted_account_recovery(links, imports, link_requests, suggestions, reports)
 values (
  array(select url from public.addon_link_contributions where submitted_by = old.id),
  array(select id from public.import_queue where decided_by = old.id),
  array(select id from public.addon_link_requests where proposed_by = old.id),
  array(select id from public.group_suggestions where suggested_by = old.id),
  array(select id from public.reports where reported_by = old.id)
 ) returning id into recovery;
 update public.activity_log set recovery_actor = recovery, actor_name = 'deleted account' where actor = old.id;
 return old;
end;
$$;
revoke all on function public.preserve_deleted_account_recovery() from public, anon, authenticated, service_role;
create trigger preserve_deleted_account_recovery before delete on auth.users
 for each row execute function public.preserve_deleted_account_recovery();

create index deleted_account_recovery_date_idx on public.deleted_account_recovery(deleted_at desc, id desc);

create function public.list_deleted_accounts(target uuid default null, before_id uuid default null)
returns table(id uuid, deleted_at timestamptz, actions bigint)
language sql stable security definer set search_path = '' as $$
 select r.id, r.deleted_at, (select count(*) from public.activity_log l where l.recovery_actor = r.id)
 from public.deleted_account_recovery r
 where public.is_owner() and (target is null or r.id = target)
  and (before_id is null or (r.deleted_at, r.id) < (
   select b.deleted_at, b.id from public.deleted_account_recovery b where b.id = before_id
  ))
 order by r.deleted_at desc, r.id desc
 limit 200;
$$;
revoke all on function public.list_deleted_accounts(uuid, uuid) from public, anon, service_role;
grant execute on function public.list_deleted_accounts(uuid, uuid) to authenticated;

-- The original private helper also handles the deleted account's surviving links.
-- Never remove a link that has since been attributed to another account.
create or replace function public.remove_contributor_links(target_id bigint, contributor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare kept jsonb; archived public.deleted_account_recovery;
begin
 select * into archived from public.deleted_account_recovery where id = contributor;
 select coalesce(jsonb_agg(v), '[]') into kept from public.addons a, jsonb_array_elements(a.versions) v
 where a.id = target_id and not exists(
  select 1 from public.addon_link_contributions c where c.url = v ->> 'url'
   and (c.submitted_by = contributor or (c.submitted_by is null and c.url = any(archived.links)))
 );
 update public.import_queue set status = 'pending', decided_by = null, decided_at = null, addon_id = null, problem = null
 where addon_id = target_id and status = 'approved'
  and (decided_by = contributor or (decided_by is null and id = any(archived.imports)));
 update public.addons set versions = kept where id = target_id;
end;
$$;

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
