-- OctoWoW uses the same review queue and publication rules as wiki imports.
alter table public.import_queue add column source text not null default 'Turtle WoW Wiki';

create function public.queue_octowow_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer;
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can queue imports.'; end if;
	with entries as materialized (
		-- Each entry with its key, worked out once, and its place in the source listing.
		select i, public.link_key(i ->> 'url') as key, place
		from jsonb_array_elements(items) with ordinality as listed_entries(i, place)
		where (i ->> 'url') ~ '^https://octowow\.st/git/[^/?#[:space:]]+/[^/?#[:space:]]+$' and btrim(coalesce(i ->> 'name', '')) <> ''
	),
	live as materialized (
		select distinct unnest(a.link_keys) as key from public.addons a
	),
	taken as materialized (
		-- Every link that is live, and the other address of a repository that is live under
		-- its old or its new one: a renamed repository is the same addon under either.
		select key from live
		union
		select s.key from public.repo_stats s where s.canonical in (select key from live)
		union
		select s.canonical from public.repo_stats s where s.canonical is not null and s.key in (select key from live)
	),
	queued as (
		insert into public.import_queue (
			key, url, name, description, images, alts, category, obsolete, parent, group_key, source
		)
		select
			e.key,
			e.i ->> 'url',
			left(btrim(e.i ->> 'name'), 120),
			coalesce(e.i ->> 'description', ''),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'images', '[]'))),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'alts', '[]'))),
			'',
			coalesce((e.i ->> 'obsolete')::boolean, false),
			e.i ->> 'parent',
			nullif(e.i ->> 'group_key', ''),
			'OctoWoW'
		from entries e
		where not exists (select 1 from taken t where t.key = e.key)
		-- Preserve source listing order.
		order by e.place
		on conflict (key) do nothing
		returning id
	)
	select count(*) into added from queued;

 return added;
end;
$$;
revoke all on function public.queue_octowow_imports(text, jsonb) from public, authenticated, service_role;
grant execute on function public.queue_octowow_imports(text, jsonb) to anon;

create or replace function public.publish_import(queue_id bigint, input jsonb default null, destination bigint default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare q public.import_queue; target bigint; title text; draft jsonb; kept text[]; candidates text[];
begin
 if not public.is_admin() then raise exception 'Only admins can approve imports.'; end if;
 select * into q from public.import_queue where id = queue_id and status = 'pending' for update;
 if q.id is null then raise exception 'That import is no longer pending.'; end if;
 title := left(regexp_replace(coalesce(input ->> 'name', q.name), '[[:space:]' || chr(160) || ']+', '', 'g'), 60);
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 target := coalesce(target, destination);
 if target is not null then
  -- Lock the destination while filling its remaining screenshot slots.
  select images into kept from public.addons where id = target for update;
  candidates := case when input ? 'images' then
   array(select jsonb_array_elements_text(input -> 'images')) else q.images end;
  select coalesce(array_agg(image order by first_seen), '{}') into kept
  from (
   select image, min(position) as first_seen
   from unnest(kept || candidates) with ordinality as shots(image, position)
   group by image order by min(position) limit 6
  ) unique_shots;
  perform public.add_addon_link(target, q.url);
  update public.addons set images = kept where id = target and images is distinct from kept;
 else
  draft := coalesce(input, jsonb_build_object('name', title, 'description', btrim(q.description), 'category', q.category,
   'author', public.link_author(q.url), 'images', to_jsonb(q.images[1:6])));
  insert into public.addons(name, description, category, author, versions, images, source)
  values(title, coalesce(draft ->> 'description', ''), draft ->> 'category', coalesce(draft ->> 'author', ''),
   jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
   array(select jsonb_array_elements_text(coalesce(draft -> 'images', '[]'))), q.source) returning id into target;
 end if;
 update public.import_queue set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null where id = queue_id;
 return target;
end;
$$;

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
		update public.addons set source = (select source from public.import_queue where id = queue_id) where id = target;
		perform public.log_action('import.approve', (select name from public.addons where id = target), target, null);
		perform public.join_import_group(queue_id, target);
	end if;
end;
$$;
notify pgrst, 'reload schema';
