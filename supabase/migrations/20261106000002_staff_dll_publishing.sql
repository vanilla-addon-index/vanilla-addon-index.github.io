-- Keep DLL publishing and collection changes in the existing staff workflow.
-- is_admin() includes the site owner and excludes banned accounts.
create function public.addons_entry_type_access() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is not null and not public.is_admin() then
  if (tg_op = 'INSERT' and new.entry_type = 'dll')
   or (tg_op = 'UPDATE' and new.entry_type is distinct from old.entry_type) then
   raise exception 'Only admins and the site owner can post DLL mods or change entry type.' using errcode = '42501';
  end if;
 end if;
 return new;
end;
$$;
create trigger addons_ab_entry_type_access before insert or update on public.addons
 for each row execute function public.addons_entry_type_access();

create or replace function public.submit_addon(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if input ->> 'entry_type' = 'dll' and not public.is_admin() then
  raise exception 'Only admins and the site owner can post DLL mods.' using errcode = '42501';
 end if;
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

create or replace function public.propose_addon_edit(target bigint, input jsonb, base jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; patch jsonb := '{}'; prior jsonb := '{}'; field text; made bigint; value jsonb;
begin
 if input ? 'entry_type' and input -> 'entry_type' is distinct from base -> 'entry_type' then
  raise exception 'Only admins and the site owner can change entry type.' using errcode = '42501';
 end if;
 if input ? 'similar_addons' and input -> 'similar_addons' is distinct from base -> 'similar_addons' then
  raise exception 'Only admins can edit similar addons.' using errcode = '42501';
 end if;
 if not coalesce((public.addon_contribution_access(target) ->> 'can_propose')::boolean, false) then raise exception 'Only contributors can propose edits to this shared page.'; end if;
 if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(base) is distinct from 'object' or octet_length(input::text) > 65536 then raise exception 'Invalid edit proposal.'; end if;
 select * into a from public.addons where id = target for update;
 foreach field in array array['name','description','entry_type','category','author','images','versions'] loop
  if input ? field and input -> field is distinct from base -> field then
   if base -> field is distinct from to_jsonb(a) -> field then raise exception 'The page changed while you were editing. Reload it before proposing changes.'; end if;
   value := input -> field;
   if field = 'images' then value := to_jsonb(public.screenshot_candidates(value)); end if;
   if value = 'null'::jsonb then raise exception 'An edit field cannot be null.'; end if;
   if field in ('name','description','entry_type','category','author') and jsonb_typeof(value) <> 'string' then raise exception 'Invalid edit field.'; end if;
   if field in ('images','versions') and jsonb_typeof(value) <> 'array' then raise exception 'Invalid edit list.'; end if;
   if field = 'entry_type' and (value #>> '{}') not in ('addon','dll') then raise exception 'Invalid entry type.'; end if;
   if field = 'name' and (char_length(input ->> field) not between 2 and 60 or public.addon_name_key(input ->> field) = '') then raise exception 'Invalid addon name.'; end if;
   if field = 'similar_addons' and char_length(value #>> '{}') > 500 then raise exception 'Similar addons can be at most 500 characters.'; end if;
   if field = 'description' and char_length(input ->> field) > 5000 then raise exception 'The description is too long.'; end if;
   if field in ('entry_type','category','author') and char_length(input ->> field) > 60 then raise exception 'That field is too long.'; end if;
   if field = 'images' and (jsonb_array_length(value) > 5 or exists(select 1 from jsonb_array_elements(value) image where jsonb_typeof(image) <> 'string' or (image #>> '{}') !~ '^https://\S+$' or char_length(image #>> '{}') > 500)) then raise exception 'Invalid screenshot links.'; end if;
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
