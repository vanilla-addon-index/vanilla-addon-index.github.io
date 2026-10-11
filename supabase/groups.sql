-- Run once in the Supabase SQL editor, after moderation.sql. Safe to run again.
--
-- Groups replace merging. Versions (forks) of one addon each stay a full entry and are
-- linked into a group, with one of them marked as the main version. Grouping deletes
-- nothing and can always be undone.
--
--   * admins group, ungroup and pick the main version
--   * anyone can suggest that their addon is a version of another; an admin decides
--   * the wiki's "Alt" links arrive in the import queue as entries of their own,
--     already tied to the entry they are an alternative to

drop function if exists public.merge_addons(bigint, bigint);

alter table public.addons add column if not exists group_id bigint;
alter table public.addons add column if not exists is_main boolean not null default false;
create index if not exists addons_group_idx on public.addons (group_id);
create sequence if not exists public.addon_group_seq;

-- Replaces the version in schema.sql: grouping an addon is not an edit of it, so it
-- leaves the "updated" date alone.
create or replace function public.addons_before_update() returns trigger
language plpgsql as $$
begin
	new.owner := old.owner;
	new.created_at := old.created_at;
	-- repo_url is derived by the database after this trigger, so it is still empty here.
	if to_jsonb(new) - '{group_id,is_main,repo_url}'::text[] is distinct from to_jsonb(old) - '{group_id,is_main,repo_url}'::text[] then
		new.updated_at := now();
	else
		new.updated_at := old.updated_at;
	end if;
	return new;
end;
$$;

-- Keeps a group sound: exactly one main version, and no group of one.
create or replace function public.tidy_group(gid bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	keep bigint;
begin
	if gid is null then
		return;
	end if;
	if (select count(*) from public.addons where group_id = gid) <= 1 then
		update public.addons set group_id = null, is_main = false where group_id = gid;
		return;
	end if;
	if (select count(*) from public.addons where group_id = gid and is_main) <> 1 then
		select id into keep
		from public.addons
		where group_id = gid
		order by is_main desc, updated_at desc, id
		limit 1;
		update public.addons set is_main = (id = keep) where group_id = gid and is_main is distinct from (id = keep);
	end if;
end;
$$;

-- Every group change records how the addons involved were grouped before, so that it can
-- be undone from its log line. How many an admin can make in an hour is in limits.sql.

-- The group, if any, and main flag of the given addons and of everything grouped with them.
create or replace function public.groups_of(ids bigint[]) returns jsonb
language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'group_id', a.group_id, 'is_main', a.is_main) order by a.id), '[]')
	from public.addons a
	where a.id = any (ids)
		or a.group_id in (select g.group_id from public.addons g where g.id = any (ids) and g.group_id is not null);
$$;

-- Puts addons in one group. The first one decides: its group is the one the others
-- join, bringing their own groups along, and its main version stays the main version.
create or replace function public.group_addons(ids bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
	gid bigint;
	absorbed bigint[];
	before jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can group addons.';
	end if;
	if (select count(distinct x) from unnest(ids) x) < 2 then
		raise exception 'Pick at least two different addons.';
	end if;
	if cardinality(ids) > 20 then
		raise exception 'Group at most 20 addons at a time.';
	end if;
	if (select count(*) from public.addons where id = any (ids)) <> (select count(distinct x) from unnest(ids) x) then
		raise exception 'One of those addons no longer exists.';
	end if;
	perform public.group_limit();
	before := public.groups_of(ids);

	select group_id into gid from public.addons where id = ids[1];
	if gid is null then
		gid := nextval('public.addon_group_seq');
		update public.addons set group_id = gid, is_main = true where id = ids[1];
	end if;

	absorbed := array(
		select distinct group_id from public.addons
		where id = any (ids) and group_id is not null and group_id <> gid
	);
	update public.addons
	set group_id = gid, is_main = false
	where (id = any (ids) or group_id = any (absorbed)) and group_id is distinct from gid;
	perform public.tidy_group(gid);

	perform public.log_action(
		'group.add',
		(select name from public.addons where group_id = gid and is_main),
		(select id from public.addons where group_id = gid and is_main),
		jsonb_build_object(
			'members', (select jsonb_agg(name order by name) from public.addons where group_id = gid),
			'groups_before', before
		)
	);
end;
$$;

create or replace function public.ungroup_addon(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	gid bigint;
	label text;
	before jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can change groups.';
	end if;
	select group_id, name into gid, label from public.addons where id = target;
	if gid is null then
		raise exception 'That addon is not in a group.';
	end if;
	perform public.group_limit();
	before := public.groups_of(array[target]);
	update public.addons set group_id = null, is_main = false where id = target;
	perform public.tidy_group(gid);
	perform public.log_action('group.remove', label, target, jsonb_build_object('groups_before', before));
end;
$$;

create or replace function public.set_main(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	gid bigint;
	label text;
	before jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can pick the main version.';
	end if;
	select group_id, name into gid, label from public.addons where id = target;
	if gid is null then
		raise exception 'That addon is not in a group.';
	end if;
	perform public.group_limit();
	before := public.groups_of(array[target]);
	update public.addons set is_main = (id = target) where group_id = gid and is_main is distinct from (id = target);
	perform public.log_action('group.main', label, target, jsonb_build_object('groups_before', before));
end;
$$;

-- Puts the addons of one logged group change back the way they were grouped before it.
-- The undo is logged the same way, so it can be undone in turn.
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
	select * into entry from public.activity_log where id = log_id and action like 'group.%';
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

-- A deleted addon leaves its group in order.
create or replace function public.addons_group_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	perform public.tidy_group(old.group_id);
	return null;
end;
$$;

drop trigger if exists addons_group_cleanup on public.addons;
create trigger addons_group_cleanup
	after delete on public.addons
	for each row execute function public.addons_group_cleanup();

-- "This addon is a version of that one", waiting for an admin. Also remembers pairs an
-- admin turned down, so the same suggestion is not made twice.
create table if not exists public.group_suggestions (
	id bigint generated always as identity primary key,
	addon_id bigint not null references public.addons on delete cascade,
	target_id bigint not null references public.addons on delete cascade,
	-- The two ids in a fixed order, so a pair is stored once whichever way round it came.
	pair text generated always as (
		least(addon_id, target_id)::text || ':' || greatest(addon_id, target_id)::text
	) stored unique,
	-- user: the addon's poster asked. auto: spotted by the site (same name, GitHub fork).
	kind text not null check (kind in ('user', 'auto')),
	suggested_by uuid references public.profiles on delete set null,
	suggested_by_name text,
	status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
	decided_by uuid references public.profiles on delete set null,
	decided_at timestamptz,
	created_at timestamptz not null default now()
);

alter table public.group_suggestions enable row level security;
-- Admins read them all; whoever made a suggestion can follow what became of it.
drop policy if exists "admins read group suggestions" on public.group_suggestions;
drop policy if exists "admins and the suggester read group suggestions" on public.group_suggestions;
create policy "admins and the suggester read group suggestions" on public.group_suggestions for select to authenticated
	using (public.is_admin() or suggested_by = auth.uid());
revoke all on public.group_suggestions from anon, authenticated;
grant select on public.group_suggestions to authenticated;

-- The poster of an addon suggests it is a version of another. Nothing changes until an
-- admin accepts.
create or replace function public.suggest_group(addon bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	mine public.addons;
	theirs public.addons;
begin
	if auth.uid() is null or public.is_banned() then
		raise exception 'You cannot suggest a group.';
	end if;
	select * into mine from public.addons where id = addon;
	select * into theirs from public.addons where id = target;
	if mine.id is null or theirs.id is null or addon = target then
		raise exception 'Pick two different addons.';
	end if;
	if mine.owner <> auth.uid() and not public.is_admin() then
		raise exception 'You can only suggest a group for an addon you posted.';
	end if;
	if mine.group_id is not null and mine.group_id = theirs.group_id then
		return;
	end if;

	insert into public.group_suggestions (addon_id, target_id, kind, suggested_by, suggested_by_name)
	values (addon, target, 'user', auth.uid(), (select username from public.profiles where id = auth.uid()))
	on conflict (pair) do nothing;
	if found then
		perform public.log_action('group.suggest', mine.name, addon, jsonb_build_object('target', theirs.name));
	end if;
end;
$$;

create or replace function public.decide_suggestion(suggestion bigint, accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
	s public.group_suggestions;
begin
	if not public.is_admin() then
		raise exception 'Only admins can decide on suggestions.';
	end if;
	select * into s from public.group_suggestions where id = suggestion and status = 'pending';
	if s.id is null then
		raise exception 'That suggestion has already been decided.';
	end if;
	if accept then
		perform public.group_addons(array[s.target_id, s.addon_id]);
	else
		perform public.log_action(
			'group.decline',
			(select name from public.addons where id = s.addon_id),
			s.addon_id,
			jsonb_build_object('target', (select name from public.addons where id = s.target_id))
		);
	end if;
	update public.group_suggestions
	set status = case when accept then 'accepted' else 'rejected' end, decided_by = auth.uid(), decided_at = now()
	where id = suggestion;
end;
$$;

-- Turns down a pair the site spotted by itself, so it is not offered again.
create or replace function public.dismiss_pair(addon bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
	if not public.is_admin() then
		raise exception 'Only admins can decide on suggestions.';
	end if;
	insert into public.group_suggestions (addon_id, target_id, kind, status, decided_by, decided_at)
	values (addon, target, 'auto', 'rejected', auth.uid(), now())
	on conflict (pair) do update set status = 'rejected', decided_by = auth.uid(), decided_at = now();
	perform public.log_action(
		'group.decline',
		(select name from public.addons where id = addon),
		addon,
		jsonb_build_object('target', (select name from public.addons where id = target))
	);
end;
$$;

-- Replaces the version in moderation.sql: grouping and the wiki credit have their own log
-- lines, so neither is also logged as an edit.
create or replace function public.addons_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	changed text[];
	trashed bigint;
begin
	if tg_op = 'INSERT' then
		if not public.doing('restore') then
			perform public.log_action(
				case when new.source <> '' then 'import.approve' else 'addon.create' end, new.name, new.id, null
			);
		end if;
	elsif tg_op = 'UPDATE' then
		select array_agg(n.key) into changed
		from jsonb_each(to_jsonb(new)) n
		where n.key not in ('updated_at', 'link_keys', 'repo_url', 'group_id', 'is_main', 'source')
			and n.value is distinct from to_jsonb(old) -> n.key;
		if changed is not null then
			perform public.log_action(
				case when public.doing('revert') then 'addon.revert' else 'addon.update' end,
				new.name,
				new.id,
				jsonb_build_object(
					'changed', to_jsonb(changed),
					'before', to_jsonb(old) - 'link_keys',
					'after', (select jsonb_object_agg(field, to_jsonb(new) -> field) from unnest(changed) field)
				)
			);
		end if;
	else
		insert into public.addon_trash (addon, name, reason, deleted_by, deleted_by_name)
		values (
			-- With the others in its group, so a restore can put it back among them. This
			-- runs before addons_group_cleanup, while a group of two is still a group.
			to_jsonb(old) - 'link_keys' || jsonb_build_object(
				'group_members',
				(select coalesce(jsonb_agg(g.id), '[]') from public.addons g where g.group_id = old.group_id)
			),
			old.name,
			'delete',
			auth.uid(),
			(select username from public.profiles where id = auth.uid())
		)
		returning id into trashed;
		perform public.log_action('addon.delete', old.name, old.id, jsonb_build_object('trash_id', trashed));
		delete from public.addon_trash where deleted_at < now() - interval '90 days';
	end if;
	return null;
end;
$$;

-- Import queue: the key of the entry this one is an alternative version of, on the wiki.
alter table public.import_queue add column if not exists group_key text;

-- Groups a freshly published import with the entries the wiki ties it to, in either
-- direction, as far as they are already live.
create or replace function public.join_import_group(queue_id bigint, made bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
	main bigint;
	other record;
begin
	select * into q from public.import_queue where id = queue_id;
	if q.group_key is not null then
		select a.id into main from public.addons a where a.link_keys @> array[q.group_key] limit 1;
		if main is not null and main <> made then
			perform public.group_addons(array[main, made]);
		end if;
	end if;
	for other in
		select i.addon_id
		from public.import_queue i
		join public.addons a on a.id = i.addon_id
		where i.group_key = q.key and i.status = 'approved' and i.addon_id <> made
	loop
		perform public.group_addons(array[made, other.addon_id]);
	end loop;
end;
$$;

-- Replaces the version in import.sql: stores which entry a candidate is a version of.
create or replace function public.queue_imports(items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	added integer;
begin
	if not public.may_import() then
		raise exception 'Only the nightly job can queue imports.';
	end if;

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
	on conflict (key) do nothing;

	get diagnostics added = row_count;
	return added;
end;
$$;

-- Replaces the version in import.sql: the wiki's other versions are entries of their own
-- now, so they are no longer attached as extra links; the new addon joins their group.
create or replace function public.approve_imports(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
	made bigint;
	published integer := 0;
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;

	for q in select * from public.import_queue where id = any (ids) and status = 'pending' order by id loop
		begin
			-- The address is made from the name by the database; see slugs.sql.
			insert into public.addons (name, description, category, author, versions, images, source)
			values (
				left(q.name, 60),
				btrim(q.description),
				q.category,
				case when q.key like 'github.com/%' then split_part(q.url, '/', 4) else '' end,
				jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
				q.images[1:5],
				'Turtle WoW Wiki'
			)
			returning id into made;

			update public.import_queue
			set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = made, problem = null
			where id = q.id;
			perform public.join_import_group(q.id, made);
			published := published + 1;
		exception when others then
			update public.import_queue set problem = sqlerrm where id = q.id;
		end;
	end loop;

	return published;
end;
$$;

-- Replaces the version in import.sql: an entry published through the form joins its
-- wiki group too, and is logged as an approved import.
create or replace function public.mark_imported(queue_id bigint, target bigint, credit boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;
	update public.import_queue
	set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null
	where id = queue_id;
	if credit then
		update public.addons set source = 'Turtle WoW Wiki' where id = target;
		perform public.log_action('import.approve', (select name from public.addons where id = target), target, null);
		perform public.join_import_group(queue_id, target);
	end if;
end;
$$;

-- Undoes an approval: the addon goes to the trash and its entry is back in the queue.
create or replace function public.unapprove_import(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
begin
	if not public.is_admin() then
		raise exception 'Only admins can review imports.';
	end if;
	select * into q from public.import_queue where addon_id = target and status = 'approved';
	if q.id is null then
		raise exception 'That addon did not come from the import queue.';
	end if;
	delete from public.addons where id = target;
	update public.import_queue
	set status = 'pending', decided_by = null, decided_at = null, addon_id = null, problem = null
	where id = q.id;
	perform public.log_action('import.requeue', q.name, null, jsonb_build_object('url', q.url));
end;
$$;

-- Publishes a queued entry straight into the group of an addon that is already live.
create or replace function public.approve_into(queue_id bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	made bigint;
	why text;
begin
	perform public.approve_imports(array[queue_id]);
	select addon_id, problem into made, why from public.import_queue where id = queue_id;
	if made is null then
		raise exception 'Could not publish it: %', coalesce(why, 'it is no longer waiting for review.');
	end if;
	perform public.group_addons(array[target, made]);
end;
$$;

revoke all on function public.tidy_group(bigint) from public, anon, authenticated;
revoke all on function public.join_import_group(bigint, bigint) from public, anon, authenticated;
revoke all on function public.group_addons(bigint[]) from public, anon;
revoke all on function public.ungroup_addon(bigint) from public, anon;
revoke all on function public.set_main(bigint) from public, anon;
revoke all on function public.suggest_group(bigint, bigint) from public, anon;
revoke all on function public.decide_suggestion(bigint, boolean) from public, anon;
revoke all on function public.dismiss_pair(bigint, bigint) from public, anon;
revoke all on function public.approve_into(bigint, bigint) from public, anon;
grant execute on function public.group_addons(bigint[]) to authenticated;
grant execute on function public.ungroup_addon(bigint) to authenticated;
grant execute on function public.set_main(bigint) to authenticated;
grant execute on function public.suggest_group(bigint, bigint) to authenticated;
grant execute on function public.decide_suggestion(bigint, boolean) to authenticated;
grant execute on function public.dismiss_pair(bigint, bigint) to authenticated;
grant execute on function public.approve_into(bigint, bigint) to authenticated;
revoke all on function public.groups_of(bigint[]) from public, anon, authenticated;
revoke all on function public.undo_grouping(bigint) from public, anon;
revoke all on function public.unapprove_import(bigint) from public, anon;
grant execute on function public.undo_grouping(bigint) to authenticated;
grant execute on function public.unapprove_import(bigint) to authenticated;
revoke all on function public.queue_imports(jsonb) from authenticated;
grant execute on function public.queue_imports(jsonb) to service_role;
