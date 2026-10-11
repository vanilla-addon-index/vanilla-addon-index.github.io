-- One-off, for a database that was set up while admins could add to the import queue.
-- A database built from the other files as they are now does not need this.
--
-- Only the nightly job queues imports now. Admins review the queue but cannot add to it,
-- so approving imports stays bounded by what the wiki lists.

create or replace function public.may_import() returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

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

revoke all on function public.queue_imports(jsonb) from public, anon, authenticated;
grant execute on function public.queue_imports(jsonb) to service_role;
