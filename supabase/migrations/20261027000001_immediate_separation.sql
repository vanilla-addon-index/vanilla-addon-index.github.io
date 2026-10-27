-- Separation derives content from the selected link, never from a client form.
drop function public.split_addon_link(bigint, text, jsonb);
create function public.split_addon_link(target bigint, link text, new_name text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; q public.import_queue; made bigint; kept jsonb; moved jsonb; contributor uuid; title text;
begin
 if not public.is_admin() then raise exception 'Only admins can separate links.'; end if;
 select * into a from public.addons where id = target for update;
 select v into moved from jsonb_array_elements(a.versions) v where v ->> 'url' = link;
 if a.id is null or moved is null then raise exception 'That link no longer exists.'; end if;
 if jsonb_array_length(a.versions) < 2 then raise exception 'The only link cannot be separated.'; end if;
 -- Only an exact queued link provides independent content. Alternate links do not.
 select * into q from public.import_queue where key = public.link_key(link);
 title := btrim(regexp_replace(coalesce(new_name, nullif(q.name, ''), a.name), '\s+', ' ', 'g'));
 if char_length(title) not between 2 and 60 or public.addon_name_key(title) = '' then
  raise exception 'Enter an addon name between 2 and 60 characters.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 if exists(select 1 from public.addons where public.addon_name_key(name) = public.addon_name_key(title)) then
  raise exception using errcode = 'PNA01', message = 'Choose a different name. Addons with matching names stay grouped.';
 end if;
 select submitted_by into contributor from public.addon_link_contributions where addon_id = target and url = link;
 select jsonb_agg(v) into kept from jsonb_array_elements(a.versions) v where v ->> 'url' <> link;
 update public.addons set versions = kept where id = target;
 insert into public.addons(name, description, category, author, versions, images, source, separate_name, shared)
 values(title, coalesce(q.description, ''),
  coalesce(nullif(q.category, ''), 'Miscellaneous'), public.link_author(link),
  jsonb_build_array(moved), coalesce(q.images[1:6], '{}'::text[]), coalesce(q.source, ''), false, true)
 returning id into made;
 update public.addon_link_contributions set submitted_by = contributor where addon_id = made and url = link;
 insert into public.addon_contributors(addon_id, user_id)
 select made, submitted_by from public.addon_link_contributions where addon_id = made and submitted_by is not null
 on conflict do nothing;
 update public.import_queue set addon_id = made where id = q.id and status = 'approved';
 return made;
end;
$$;
revoke all on function public.split_addon_link(bigint, text, text) from public, anon, service_role;
grant execute on function public.split_addon_link(bigint, text, text) to authenticated;

-- Repair old name-collision exceptions and make the name rule apply to every page.
do $$
declare g record; item record; destination bigint;
begin
 for g in select public.addon_name_key(name) as key from public.addons group by 1 having count(*) > 1 loop
  select id into destination from public.addons where public.addon_name_key(name) = g.key
   order by separate_name, created_at, id limit 1;
  for item in select id from public.addons where public.addon_name_key(name) = g.key and id <> destination order by id loop
   perform public.merge_addon_links(item.id, destination);
  end loop;
 end loop;
end;
$$;
update public.addons set separate_name = false where separate_name;
create or replace function public.addons_name_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(new.name), 0));
 if exists(select 1 from public.addons a where a.id is distinct from new.id
  and public.addon_name_key(a.name) = public.addon_name_key(new.name)) then
  raise exception 'An addon with this name already exists. Add its link to that page.';
 end if;
 new.separate_name := false;
 return new;
end;
$$;
drop index public.addons_canonical_name;
create unique index addons_canonical_name on public.addons(public.addon_name_key(name));
