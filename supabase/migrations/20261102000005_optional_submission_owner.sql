-- Admins may list community addons without adding them to their account.
-- Ownership is set at insertion; history and link provenance still record the caller.
create or replace function public.submit_addon_before_link_reviews(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot submit addons.'; end if;
 if input ? 'without_owner' then
  if jsonb_typeof(input -> 'without_owner') is distinct from 'boolean' then raise exception 'Invalid submission ownership option.'; end if;
  if input -> 'without_owner' = 'true'::jsonb and not public.is_admin() then
   raise exception 'Only admins can submit addons without an owner.' using errcode = '42501';
  end if;
 end if;
 if title is null or char_length(title) not between 2 and 60 or public.addon_name_key(title) = '' then raise exception 'The name needs 2 to 60 characters.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 if target is not null then
  if jsonb_array_length(input -> 'versions') is distinct from 1 then raise exception 'Submit one link at a time.'; end if;
  return public.add_addon_link(target, btrim(input -> 'versions' -> 0 ->> 'url'));
 end if;
 insert into public.addons(name, description, similar_addons, category, author, versions, images, owner)
 values(title, coalesce(input ->> 'description', ''), coalesce(input ->> 'similar_addons', ''), input ->> 'category', coalesce(input ->> 'author', ''),
  input -> 'versions', array(select jsonb_array_elements_text(coalesce(input -> 'images', '[]'))),
  case when input -> 'without_owner' = 'true'::jsonb then null else auth.uid() end) returning id into target;
 return target;
end;
$$;

create or replace function public.submit_addon(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot submit addons.'; end if;
 if input ? 'without_owner' then
  if jsonb_typeof(input -> 'without_owner') is distinct from 'boolean' then raise exception 'Invalid submission ownership option.'; end if;
  if input -> 'without_owner' = 'true'::jsonb and not public.is_admin() then
   raise exception 'Only admins can submit addons without an owner.' using errcode = '42501';
  end if;
 end if;
 if title is null or char_length(title) not between 2 and 60 or public.addon_name_key(title) = '' then raise exception 'The name needs 2 to 60 characters.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 if target is not null then
  if jsonb_array_length(input -> 'versions') is distinct from 1 then raise exception 'Submit one link at a time.'; end if;
  return public.request_addon_link(target, input -> 'versions' -> 0 ->> 'url', coalesce(input -> 'images','[]'::jsonb));
 end if;
 return public.submit_addon_before_link_reviews(input);
end;
$$;
