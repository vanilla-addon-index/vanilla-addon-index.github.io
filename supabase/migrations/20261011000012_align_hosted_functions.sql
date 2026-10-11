-- Brings three functions of the hosted database in line with the migrations. They had
-- been pasted into the SQL editor by hand in a slightly different form:
--   * approve_imports still built an address of its own, which the slug trigger then replaced
--   * addons_slug and restore_addon differed in their comments only
-- None of them behaved differently. A database built from the migrations already has these.

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
			-- The address is made from the name by the database; see the slugs migration.
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

create or replace function public.addons_slug() returns trigger
language plpgsql set search_path = '' as $$
declare
	key text := public.link_key(new.versions -> 0 ->> 'url');
	host text;
	stem text;
	n integer := 1;
begin
	-- A restored addon gets back the address it had.
	if public.doing('restore') then
		return new;
	end if;

	stem := coalesce(nullif(public.slugify(new.name), ''), 'addon');
	new.slug := stem;
	-- An address that once led to an addon merged into another still belongs to that one.
	if exists (select 1 from public.addons a where a.slug = new.slug or new.slug = any (a.aliases)) then
		host := public.slugify(
			case when split_part(key, '/', 1) = 'github.com' then split_part(key, '/', 2) else split_part(key, '/', 1) end
		);
		if host <> '' then
			stem := stem || '-' || host;
			new.slug := stem;
		end if;
	end if;
	while exists (select 1 from public.addons a where a.slug = new.slug or new.slug = any (a.aliases)) loop
		n := n + 1;
		new.slug := stem || '-' || n;
	end loop;
	return new;
end;
$$;

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
