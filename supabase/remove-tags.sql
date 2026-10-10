-- One-off, for a database that was set up while addons still had tags. A database built
-- from the other files as they are now never had them and does not need this.

create or replace function public.queue_imports(items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	added integer;
begin
	if not public.may_import() then
		raise exception 'Only admins can import addons.';
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

create or replace function public.approve_imports(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
	base text;
	new_slug text;
	n integer;
	made bigint;
	published integer := 0;
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;

	for q in select * from public.import_queue where id = any (ids) and status = 'pending' order by id loop
		begin
			base := btrim(regexp_replace(lower(q.name), '[^a-z0-9]+', '-', 'g'), '-');
			if base = '' then
				base := 'addon';
			end if;
			new_slug := base;
			n := 1;
			while exists (select 1 from public.addons a where a.slug = new_slug) loop
				n := n + 1;
				new_slug := base || '-' || n;
			end loop;

			insert into public.addons (slug, name, description, category, author, versions, images, source)
			values (
				new_slug,
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

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		slug, name, summary, description, category, author, versions, images, source, aliases, owner, created_at
	)
	values (
		new_slug,
		a ->> 'name',
		coalesce(a ->> 'summary', ''),
		coalesce(a ->> 'description', ''),
		a ->> 'category',
		coalesce(a ->> 'author', ''),
		a -> 'versions',
		array(select jsonb_array_elements_text(coalesce(a -> 'images', '[]'))),
		coalesce(a ->> 'source', ''),
		array(select jsonb_array_elements_text(coalesce(a -> 'aliases', '[]'))),
		coalesce(poster, auth.uid()),
		(a ->> 'created_at')::timestamptz
	)
	returning id into made;
	perform set_config('app.doing', '', true);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

create or replace function public.revert_addon(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	entry public.activity_log;
	b jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can revert edits.';
	end if;
	select * into entry from public.activity_log where id = log_id and action in ('addon.update', 'addon.revert');
	if entry.id is null then
		raise exception 'That log line is not an edit.';
	end if;
	b := entry.details -> 'before';

	perform set_config('app.doing', 'revert', true);
	update public.addons
	set name = b ->> 'name',
		summary = coalesce(b ->> 'summary', ''),
		description = coalesce(b ->> 'description', ''),
		category = b ->> 'category',
		author = coalesce(b ->> 'author', ''),
		versions = b -> 'versions',
		images = array(select jsonb_array_elements_text(coalesce(b -> 'images', '[]')))
	where id = entry.addon_id;
	if not found then
		raise exception 'That addon no longer exists. Look for it in the trash.';
	end if;
	perform set_config('app.doing', '', true);
end;
$$;

alter table public.addons drop column if exists tags;
alter table public.import_queue drop column if exists tags;
