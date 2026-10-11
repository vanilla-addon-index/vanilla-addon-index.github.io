-- One-off, for a database that was set up while addons still had a summary. A database
-- built from the other files as they are now never had one and does not need this.
--
-- Run it after the site without the summary field has been deployed: until then the
-- site still sends the field when an addon is posted or edited.

-- Puts a deleted or merged addon back. Returns its address.
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
		slug, name, description, category, author, versions, images, source, aliases, owner, created_at
	)
	values (
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
	)
	returning id into made;
	perform set_config('app.doing', '', true);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

-- Sets an addon back to how it was before one logged edit.
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

alter table public.addons drop column if exists summary;
