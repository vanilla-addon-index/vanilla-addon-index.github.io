-- Preserve destination screenshots and append reviewed import images up to six.
alter table public.addons drop constraint addons_images_check;
alter table public.addons add constraint addons_images_check
 check (cardinality(images) <= 6 and array_to_string(images, ' ') ~ '^(https://\S+( |$))*$');

create or replace function public.publish_import(queue_id bigint, input jsonb default null, destination bigint default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare q public.import_queue; target bigint; title text; draft jsonb; kept text[]; candidates text[];
begin
 if not public.is_admin() then raise exception 'Only admins can approve imports.'; end if;
 select * into q from public.import_queue where id = queue_id and status = 'pending' for update;
 if q.id is null then raise exception 'That import is no longer pending.'; end if;
 title := left(coalesce(input ->> 'name', q.name), 60);
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

create or replace function public.propose_addon_edit(target bigint, input jsonb, base jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; patch jsonb := '{}'; prior jsonb := '{}'; field text; made bigint; value jsonb;
begin
 if not coalesce((public.addon_contribution_access(target) ->> 'can_propose')::boolean, false) then raise exception 'Only contributors can propose edits to this shared page.'; end if;
 if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(base) is distinct from 'object' or octet_length(input::text) > 65536 then raise exception 'Invalid edit proposal.'; end if;
 select * into a from public.addons where id = target for update;
 foreach field in array array['name','description','category','author','images','versions'] loop
  if input ? field and input -> field is distinct from base -> field then
   if base -> field is distinct from to_jsonb(a) -> field then raise exception 'The page changed while you were editing. Reload it before proposing changes.'; end if;
   value := input -> field;
   if value = 'null'::jsonb then raise exception 'An edit field cannot be null.'; end if;
   if field in ('name','description','category','author') and jsonb_typeof(value) <> 'string' then raise exception 'Invalid edit field.'; end if;
   if field in ('images','versions') and jsonb_typeof(value) <> 'array' then raise exception 'Invalid edit list.'; end if;
   if field = 'name' and (char_length(input ->> field) not between 2 and 60 or public.addon_name_key(input ->> field) = '') then raise exception 'Invalid addon name.'; end if;
   if field = 'description' and char_length(input ->> field) > 5000 then raise exception 'The description is too long.'; end if;
   if field in ('category','author') and char_length(input ->> field) > 60 then raise exception 'That field is too long.'; end if;
   if field = 'images' and (jsonb_array_length(value) > 6 or exists(select 1 from jsonb_array_elements(value) image where jsonb_typeof(image) <> 'string' or (image #>> '{}') !~ '^https://\S+$' or char_length(image #>> '{}') > 500)) then raise exception 'Invalid screenshot links.'; end if;
   if field = 'versions' and (jsonb_array_length(value) > 100 or exists(select 1 from jsonb_array_elements(value) v where jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'url') is distinct from 'string' or (v ->> 'url') !~ '^https://\S+$' or char_length(v ->> 'url') > 300 or (v ? 'note' and jsonb_typeof(v -> 'note') <> 'string') or char_length(coalesce(v ->> 'note','')) > 80)) then raise exception 'Invalid download links.'; end if;
   patch := patch || jsonb_build_object(field, value); prior := prior || jsonb_build_object(field, base -> field);
  end if;
 end loop;
 if patch = '{}' then raise exception 'There are no changes to review.'; end if;
 if (select count(*) from public.addon_edit_requests where proposed_by = auth.uid() and created_at > now() - interval '1 day') >= 20
  and not exists(select 1 from public.addon_edit_requests where addon_id = target and proposed_by = auth.uid() and status = 'pending') then raise exception 'You can propose at most 20 edits a day.' using errcode = 'LIMIT'; end if;
 insert into public.addon_edit_requests(addon_id,proposed_by,base,changes) values(target,auth.uid(),prior,patch)
 on conflict(addon_id,proposed_by) where status = 'pending' do update set base = excluded.base, changes = excluded.changes, updated_at = now()
 returning id into made;
 return made;
end;
$$;

create or replace function public.store_queue_images(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	given integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store screenshots for the queue.';
	end if;

	with found as (
		select
			i ->> 'key' as key,
			-- At most six, each an https address of a sane length, like an addon's own.
			coalesce(
				(
					select array_agg(image order by place)
					from (
						select image, place
						from jsonb_array_elements_text(coalesce(i -> 'images', '[]')) with ordinality as listed(image, place)
						where image ~ '^https://\S+$' and char_length(image) <= 500
						order by place
						limit 6
					) kept
				),
				'{}'
			) as images
		from jsonb_array_elements(items) i
	),
	stored as (
		update public.import_queue q
		set images = f.images, readme_checked_at = now()
		from found f
		where q.key = f.key and q.status = 'pending' and q.readme_checked_at is null
		returning (f.images <> '{}') as has
	)
	select count(*) filter (where has) into given from stored;
	return given;
end;
$$;

notify pgrst, 'reload schema';
