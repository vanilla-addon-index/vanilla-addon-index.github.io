-- Normalize wiki labels before they can be approved into the public list.
create function public.normalize_import_name() returns trigger
language plpgsql set search_path = '' as $$
begin
	new.name := regexp_replace(new.name, '[[:space:]' || chr(160) || ']+', '', 'g');
	new.parent := regexp_replace(new.parent, '[[:space:]' || chr(160) || ']+', '', 'g');
	return new;
end;
$$;

create trigger normalize_import_name
before insert or update of name, parent on public.import_queue
for each row execute function public.normalize_import_name();

-- Apply the same normalization to entries awaiting review.
update public.import_queue set name = name, parent = parent
where status = 'pending' and (name ~ ('[[:space:]' || chr(160) || ']')
	or parent ~ ('[[:space:]' || chr(160) || ']'));

-- Reviewed titles follow the same rule before name matching and publication.
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
   array(select jsonb_array_elements_text(coalesce(draft -> 'images', '[]'))), 'Turtle WoW Wiki') returning id into target;
 end if;
 update public.import_queue set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null where id = queue_id;
 return target;
end;
$$;
