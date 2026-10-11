-- One-off, for a database that was set up before every change could be undone from the
-- log. A database built from the other files as they are now does not need this.
--
--   * a restored addon keeps its id and returns to its group
--   * group changes record how things were before, and can be undone
--   * an approved import can be sent back to the queue
--   * emptying the trash and turning down a group suggestion are logged
--   * the wiki credit on an import is no longer logged as an edit

-- Group changes are held to 200 an hour per admin, and every one records how the addons
-- involved were grouped before, so that it can be undone from its log line.
create or replace function public.group_limit() returns void
language plpgsql security definer set search_path = '' as $$
begin
	if not public.is_owner() and (
		select count(*)
		from public.activity_log
		where actor = auth.uid()
			and action in ('group.add', 'group.remove', 'group.main', 'group.undo')
			and at > now() - interval '1 hour'
	) >= 200 then
		raise exception 'You can make at most 200 group changes an hour. Try again later.' using errcode = 'LIMIT';
	end if;
end;
$$;

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

-- Puts a deleted addon back as it was: under the id it had, so its lines in the log lead
-- to it again and its earlier edits can still be reverted, and in the group it was in.
-- Returns its address.
create or replace function public.restore_addon(trash_id bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
	t public.addon_trash;
	a jsonb;
	keys text[];
	holder record;
	kept jsonb;
	base text;
	new_slug text;
	n integer := 1;
	poster uuid;
	made bigint;
	gid bigint;
	others bigint[];
begin
	if not public.is_admin() then
		raise exception 'Only admins can restore addons.';
	end if;
	select * into t from public.addon_trash where id = trash_id;
	if t.id is null then
		raise exception 'That addon is no longer in the trash.';
	end if;
	a := t.addon;
	select array_agg(public.link_key(v ->> 'url')) into keys from jsonb_array_elements(a -> 'versions') v;

	-- A merge moved these links under another addon; they move back.
	for holder in select id, versions from public.addons where link_keys && keys loop
		select jsonb_agg(v) into kept
		from jsonb_array_elements(holder.versions) v
		where not public.link_key(v ->> 'url') = any (keys);
		if kept is null then
			raise exception 'Another addon now lists only these links. Edit or delete it first.';
		end if;
		update public.addons
		set versions = kept, aliases = array_remove(aliases, a ->> 'slug')
		where id = holder.id;
	end loop;

	base := a ->> 'slug';
	new_slug := base;
	while exists (select 1 from public.addons x where x.slug = new_slug) loop
		n := n + 1;
		new_slug := base || '-' || n;
	end loop;

	-- Back to whoever posted it, if that account still exists.
	select id into poster from public.profiles where id = (a ->> 'owner')::uuid;

	made := (a ->> 'id')::bigint;
	if made is null or exists (select 1 from public.addons where id = made) then
		made := nextval(pg_get_serial_sequence('public.addons', 'id'));
	end if;

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		id, slug, name, description, category, author, versions, images, source, aliases, owner, created_at
	)
	overriding system value
	values (
		made,
		new_slug,
		a ->> 'name',
		coalesce(a ->> 'description', ''),
		a ->> 'category',
		coalesce(a ->> 'author', ''),
		a -> 'versions',
		array(select jsonb_array_elements_text(coalesce(a -> 'images', '[]'))),
		coalesce(a ->> 'source', ''),
		array(select jsonb_array_elements_text(coalesce(a -> 'aliases', '[]'))),
		coalesce(poster, auth.uid()),
		(a ->> 'created_at')::timestamptz
	);
	perform set_config('app.doing', '', true);

	-- Back in its group: the one it left if that still exists, or the group of two that
	-- fell apart when it was deleted. See groups.sql.
	gid := (a ->> 'group_id')::bigint;
	if gid is not null then
		others := array(select jsonb_array_elements_text(coalesce(a -> 'group_members', '[]'))::bigint);
		if exists (select 1 from public.addons where group_id = gid) then
			update public.addons set group_id = gid, is_main = false where id = made;
		elsif cardinality(others) = 1 and exists (select 1 from public.addons where id = others[1] and group_id is null) then
			update public.addons set group_id = gid, is_main = (id <> made) where id in (made, others[1]);
		else
			gid := null;
		end if;
		if gid is not null then
			if coalesce((a ->> 'is_main')::boolean, false) then
				update public.addons set is_main = (id = made) where group_id = gid and is_main is distinct from (id = made);
			end if;
			perform public.tidy_group(gid);
		end if;
	end if;

	-- An approved import points at its addon again.
	update public.import_queue set addon_id = made where addon_id is null and status = 'approved' and key = any (keys);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

-- Removes trashed addons for good. Owner only. It is the one thing that cannot be undone,
-- so the log keeps the names.
create or replace function public.purge_trash(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	names text[];
begin
	if not public.is_owner() then
		raise exception 'Only the owner can empty the trash.';
	end if;
	with gone as (delete from public.addon_trash where id = any (ids) returning name)
	select coalesce(array_agg(name order by name), '{}') into names from gone;
	if cardinality(names) > 0 then
		perform public.log_action(
			'trash.purge',
			case when cardinality(names) = 1 then names[1] else cardinality(names) || ' addons' end,
			null,
			jsonb_build_object('names', to_jsonb(names[1:200]))
		);
	end if;
	return cardinality(names);
end;
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

revoke all on function public.group_limit() from public, anon, authenticated;
revoke all on function public.groups_of(bigint[]) from public, anon, authenticated;
revoke all on function public.undo_grouping(bigint) from public, anon;
revoke all on function public.unapprove_import(bigint) from public, anon;
grant execute on function public.undo_grouping(bigint) to authenticated;
grant execute on function public.unapprove_import(bigint) to authenticated;
