-- Additional links from members wait for review without modifying the live page.
create table public.addon_link_requests (
 id bigint generated always as identity primary key,
 addon_id bigint not null references public.addons on delete cascade,
 proposed_by uuid not null references public.profiles on delete cascade,
 url text not null,
 key text not null,
 status text not null default 'pending' check(status in ('pending','accepted','rejected','withdrawn')),
 created_at timestamptz not null default now(),
 decided_by uuid references public.profiles on delete set null,
 decided_at timestamptz
);
create unique index addon_link_requests_pending on public.addon_link_requests(key) where status = 'pending';
alter table public.addon_link_requests enable row level security;
revoke all on public.addon_link_requests from public, anon, authenticated, service_role;
grant select on public.addon_link_requests to authenticated;
create policy "proposer and admins read link requests" on public.addon_link_requests for select to authenticated
 using(proposed_by = auth.uid() or public.is_admin());

create function public.request_addon_link(target bigint, link text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare normalized text; a public.addons;
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot suggest links.'; end if;
 link := btrim(link);
 if link is null or char_length(link) > 300 or link !~ '^https://\S+$' then raise exception 'A valid HTTPS addon link is required.'; end if;
 if not public.is_admin() and not public.host_allowed(link, 'link') then raise exception 'That link host is not allowed.'; end if;
 select * into a from public.addons where id = target for update;
 if a.id is null then raise exception 'That addon no longer exists.'; end if;
 normalized := public.link_key(link);
 if exists(select 1 from public.addons where link_keys @> array[normalized]) then raise exception 'This link is already listed.'; end if;
 if jsonb_array_length(a.versions) >= 100 then raise exception 'This addon already has the maximum number of links.'; end if;
 if public.is_admin() then return public.add_addon_link(target, link); end if;
 if exists(select 1 from public.addon_link_requests where key = normalized and status = 'pending') then raise exception 'This link is already waiting for admin review.'; end if;
 -- Serialize the daily allowance across submissions to different addons.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 27));
 if (select count(*) from public.addon_link_requests where proposed_by = auth.uid() and created_at > now() - interval '1 day') >= 20 then
  raise exception 'You can suggest at most 20 links a day.' using errcode = 'LIMIT';
 end if;
 insert into public.addon_link_requests(addon_id, proposed_by, url, key) values(target, auth.uid(), link, normalized);
 return target;
end;
$$;
revoke all on function public.request_addon_link(bigint,text) from public, anon, service_role;
grant execute on function public.request_addon_link(bigint,text) to authenticated;

create function public.decide_addon_link(request_id bigint, accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.addon_link_requests;
begin
 if not public.is_admin() then raise exception 'Only admins can review links.'; end if;
 select * into r from public.addon_link_requests where id = request_id and status = 'pending' for update;
 if r.id is null then raise exception 'That link is no longer pending.'; end if;
 if accept then
  if exists(select 1 from public.profiles where id = r.proposed_by and banned) then raise exception 'This contributor is banned. Reject the suggestion.'; end if;
  perform public.add_addon_link(r.addon_id, r.url);
  update public.addon_link_contributions set submitted_by = r.proposed_by where addon_id = r.addon_id and url = r.url;
  insert into public.addon_contributors(addon_id,user_id) values(r.addon_id,r.proposed_by) on conflict do nothing;
 end if;
 update public.addon_link_requests set status = case when accept then 'accepted' else 'rejected' end,
  decided_by = auth.uid(), decided_at = now() where id = r.id;
end;
$$;
revoke all on function public.decide_addon_link(bigint,boolean) from public, anon, service_role;
grant execute on function public.decide_addon_link(bigint,boolean) to authenticated;

create function public.withdraw_addon_link(request_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot withdraw suggestions.'; end if;
 update public.addon_link_requests set status = 'withdrawn', decided_at = now()
 where id = request_id and proposed_by = auth.uid() and status = 'pending';
 if not found then raise exception 'That pending suggestion does not belong to you.'; end if;
end;
$$;
revoke all on function public.withdraw_addon_link(bigint) from public, anon, service_role;
grant execute on function public.withdraw_addon_link(bigint) to authenticated;

-- Preserve new-addon submission, but close the old same-name submission bypass.
alter function public.submit_addon(jsonb) rename to submit_addon_before_link_reviews;
revoke all on function public.submit_addon_before_link_reviews(jsonb) from public, anon, authenticated, service_role;
create function public.submit_addon(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot submit addons.'; end if;
 if title is null or char_length(title) not between 2 and 60 or public.addon_name_key(title) = '' then raise exception 'The name needs 2 to 60 characters.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 if target is not null then
  if jsonb_array_length(input -> 'versions') is distinct from 1 then raise exception 'Submit one link at a time.'; end if;
  return public.request_addon_link(target, input -> 'versions' -> 0 ->> 'url');
 end if;
 return public.submit_addon_before_link_reviews(input);
end;
$$;
revoke all on function public.submit_addon(jsonb) from public, anon, service_role;
grant execute on function public.submit_addon(jsonb) to authenticated;

-- Also cover direct owner updates and every elevated internal append path.
create function public.addons_review_new_links() returns trigger
language plpgsql set search_path = '' as $$
begin
 if auth.uid() is not null and not public.is_admin() and exists(
  select 1 from jsonb_array_elements(new.versions) v
  where not exists(select 1 from jsonb_array_elements(old.versions) o where public.link_key(o ->> 'url') = public.link_key(v ->> 'url'))
 ) then raise exception 'Additional links require admin review. Suggest the link on the addon page.'; end if;
 return new;
end;
$$;
create trigger addons_review_new_links before update of versions on public.addons
 for each row execute function public.addons_review_new_links();

-- Link suggestions participate in the existing nightly review notification count.
alter function public.nightly_waiting(text) rename to nightly_waiting_before_link_reviews;
revoke all on function public.nightly_waiting_before_link_reviews(text) from public, anon, authenticated, service_role;
create function public.nightly_waiting(token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare totals jsonb;
begin
 totals := public.nightly_waiting_before_link_reviews(token);
 return jsonb_set(totals, '{suggestions}', to_jsonb((totals ->> 'suggestions')::bigint + (select count(*) from public.addon_link_requests where status = 'pending')));
end;
$$;
revoke all on function public.nightly_waiting(text) from public, authenticated, service_role;
grant execute on function public.nightly_waiting(text) to anon;

-- Include reviewed link contributions in account rollback and its dry-run preview.
create or replace function public.rollback_account(target uuid, since timestamptz, preview boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
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
		raise exception 'That account does not exist.';
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
   where r.proposed_by = target and r.created_at >= since
    and r.status = 'accepted' and exists(select 1 from public.addon_link_contributions c
     where c.addon_id = r.addon_id and c.url = r.url and c.submitted_by = target)
  loop
   perform set_config('app.doing', 'remove_link', true);
   update public.addons a set versions = (select coalesce(jsonb_agg(v), '[]')
    from jsonb_array_elements(a.versions) v where v ->> 'url' <> suggestion.url)
   where a.id = suggestion.addon_id;
   perform set_config('app.doing', '', true);
   steps := steps || jsonb_build_object('kind', 'revert', 'subject', suggestion.name);
  end loop;
  update public.addon_link_requests set status = 'withdrawn', decided_at = now()
   where proposed_by = target and created_at >= since and status = 'pending';
		for line in
			select * from public.activity_log where actor = target and at >= since order by id desc
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
      steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject);
     end if;
    elsif line.action in ('addon.update', 'addon.revert') then
					-- One revert per addon, to before the account first touched it. An addon the
					-- account itself posted or imported in this time is dealt with as a whole below.
					select min(id) into first_edit
					from public.activity_log
					where actor = target and at >= since and addon_id = line.addon_id
						and action in ('addon.update', 'addon.revert');
					if line.id = first_edit
						and exists (select 1 from public.addons where id = line.addon_id)
						and not exists (
							select 1 from public.activity_log
							where actor = target and at >= since and addon_id = line.addon_id
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
						where addon_id = line.addon_id and id > first_edit and actor is distinct from target
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
					where s.suggested_by = target and s.kind = 'user' and s.status = 'pending'
						and s.addon_id = line.addon_id
						and t.id = s.target_id and t.name = line.details ->> 'target';
					if found then
						steps := steps || jsonb_build_object('kind', 'withdraw', 'subject', line.subject || ' as a version of ' || (line.details ->> 'target'));
					end if;

				elsif line.action = 'report.create' then
					select id into found_id
					from public.reports
					where reported_by = target and addon_id = line.addon_id and status = 'open';
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
