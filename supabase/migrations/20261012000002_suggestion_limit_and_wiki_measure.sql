-- Two repairs.
--
-- 1. Group suggestions get a daily limit: 10 for a member, 50 for an admin, none for the
--    owner. There was none, so one account with one addon could suggest it as a version
--    of every addon in the list and bury the admins' review page. Rolling an account back
--    now also withdraws its suggestions that are still waiting.
--
-- 2. The wiki page is measured against what it listed last time, not against every link
--    the queue has ever held. That number only grows: links on the wiki come and go, and
--    once a quarter of them had been replaced the import would have refused every page
--    from then on.

-- Replaces the version in the ownerless imports migration: the limit.
create or replace function public.suggest_group(addon bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	mine public.addons;
	theirs public.addons;
	cap integer;
begin
	if auth.uid() is null or public.is_banned() then
		raise exception 'You cannot suggest a group.';
	end if;
	select * into mine from public.addons where id = addon;
	select * into theirs from public.addons where id = target;
	if mine.id is null or theirs.id is null or addon = target then
		raise exception 'Pick two different addons.';
	end if;
	if mine.owner is distinct from auth.uid() and not public.is_admin() then
		raise exception 'You can only suggest a group for an addon you posted.';
	end if;
	if mine.group_id is not null and mine.group_id = theirs.group_id then
		return;
	end if;

	cap := case when public.is_admin() then 50 else 10 end;
	-- Counted from the log, like the other limits; see the limits migration.
	if not public.is_owner() and (
		select count(*)
		from public.activity_log
		where actor = auth.uid() and action = 'group.suggest' and at > now() - interval '1 day'
	) >= cap then
		raise exception 'You can suggest at most % groups a day. Try again tomorrow.', cap using errcode = 'LIMIT';
	end if;

	insert into public.group_suggestions (addon_id, target_id, kind, suggested_by, suggested_by_name)
	values (addon, target, 'user', auth.uid(), (select username from public.profiles where id = auth.uid()))
	on conflict (pair) do nothing;
	if found then
		perform public.log_action('group.suggest', mine.name, addon, jsonb_build_object('target', theirs.name));
	end if;
end;
$$;

-- How many addons the wiki listed the last time its page was taken in. Not readable by clients.
create table if not exists public.wiki_listing (
	-- At most one row.
	id boolean primary key default true check (id),
	entries integer not null,
	at timestamptz not null default now()
);
alter table public.wiki_listing enable row level security;
revoke all on public.wiki_listing from anon, authenticated, service_role;

-- Replaces the version in the wiki checks migration: fewer than four fifths of what the
-- page listed last time is not a wiki that shrank, it is a page that was not read
-- properly. A refused page leaves the measure as it was, so the next one is held to it
-- too. Should the wiki really have shrunk that much, run this once in the SQL editor:
--   delete from public.wiki_listing;
create or replace function public.queue_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	listed integer := jsonb_array_length(items);
	last integer;
	added integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can queue imports.';
	end if;

	select w.entries into last from public.wiki_listing w where w.id;
	-- A list that is only starting out has nothing to measure against.
	if last >= 100 and listed < last * 0.8 then
		raise exception 'The wiki lists % addons, far fewer than the % it listed last time. Nothing was queued: check that the page still reads properly.', listed, last;
	end if;

	with taken as (
		insert into public.import_queue (
			key, url, name, description, images, alts, category, obsolete, parent, group_key
		)
		select
			public.link_key(i ->> 'url'),
			i ->> 'url',
			left(btrim(i ->> 'name'), 120),
			coalesce(i ->> 'description', ''),
			array(select jsonb_array_elements_text(coalesce(i -> 'images', '[]'))),
			array(select jsonb_array_elements_text(coalesce(i -> 'alts', '[]'))),
			coalesce(i ->> 'category', 'Miscellaneous'),
			coalesce((i ->> 'obsolete')::boolean, false),
			i ->> 'parent',
			nullif(i ->> 'group_key', '')
		from jsonb_array_elements(items) i
		where (i ->> 'url') ~ '^https://\S+$'
			and btrim(coalesce(i ->> 'name', '')) <> ''
			and not exists (
				select 1 from public.addons a where a.link_keys @> array[public.link_key(i ->> 'url')]
			)
			-- A renamed repository is the same addon under either address.
			and not exists (
				select 1
				from public.repo_stats s
				join public.addons a on a.link_keys @> array[s.key] or a.link_keys @> array[s.canonical]
				where public.link_key(i ->> 'url') in (s.key, s.canonical)
			)
		on conflict (key) do update set category = excluded.category
			where import_queue.status = 'pending' and import_queue.category is distinct from excluded.category
		-- xmax is 0 for a row this statement inserted, and not for one it changed.
		returning (xmax = 0) as is_new
	)
	select count(*) filter (where is_new) into added from taken;

	insert into public.wiki_listing (id, entries) values (true, listed)
	on conflict (id) do update set entries = excluded.entries, at = now();
	return added;
end;
$$;

-- Replaces the version in the rollback migration: a suggestion the account made that is
-- still waiting is withdrawn. It is removed, not turned down, so the pair can be
-- suggested again by someone who means it.
create or replace function public.rollback_account(target uuid, since timestamptz, preview boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
	line public.activity_log;
	steps jsonb := '[]';
	skipped jsonb := '[]';
	first_edit bigint;
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
						if exists (select 1 from public.import_queue where addon_id = line.addon_id and status = 'approved') then
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
						delete from public.addons where id = line.addon_id;
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
