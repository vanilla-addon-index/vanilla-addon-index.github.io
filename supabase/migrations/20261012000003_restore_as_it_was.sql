-- Restoring an addon from the trash put three things back wrong:
--   * an addon that belonged to nobody (its poster's account is gone) came back belonging
--     to the admin who restored it
--   * an import came back naming that admin as the one who approved it
--   * "updated" became the moment of the restore, which put every restored addon at the
--     top of "recently updated"
-- Rolling a vandal back restores in bulk, so one clean-up could hand an admin dozens of
-- addons they never posted. A restored addon is now exactly what was deleted.
--
-- Replaces the version in the align hosted functions migration.
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
	approver uuid;
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

	-- Back to whoever posted it, if that account still exists; to nobody otherwise, and
	-- never to whoever restores it. The same goes for who approved an import.
	select id into poster from public.profiles where id = (a ->> 'owner')::uuid;
	select id into approver from public.profiles where id = (a ->> 'approved_by')::uuid;

	made := (a ->> 'id')::bigint;
	if made is null or exists (select 1 from public.addons where id = made) then
		made := nextval(pg_get_serial_sequence('public.addons', 'id'));
	end if;

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		id, slug, name, description, category, author, versions, images, source, aliases, owner, approved_by, created_at, updated_at
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
		poster,
		approver,
		(a ->> 'created_at')::timestamptz,
		coalesce((a ->> 'updated_at')::timestamptz, now())
	);
	perform set_config('app.doing', '', true);

	-- Back in its group: the one it left if that still exists, or the group of two that
	-- fell apart when it was deleted. See the groups migration.
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
