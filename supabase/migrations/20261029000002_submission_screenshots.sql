-- Five screenshots for new content. Existing six-image entries and their recovery
-- snapshots remain intact; ordinary edits cannot add or replace a sixth image.
create function public.screenshot_url(link text) returns text
language sql immutable set search_path = '' as $$
 select case when link ~* '^https://private-user-images\.githubusercontent\.com/[0-9]+/[0-9]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]+([?#].*)?$'
 then 'https://github.com/user-attachments/assets/' || lower(substring(link from '(?i)/[0-9]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.'))
 else link end;
$$;
revoke all on function public.screenshot_url(text) from public, anon, authenticated, service_role;

create function public.screenshot_candidates(input jsonb) returns text[]
language plpgsql set search_path = '' as $$
declare images text[];
begin
 if jsonb_typeof(input) is distinct from 'array' or jsonb_array_length(input) > 5 or exists(
  select 1 from jsonb_array_elements(input) v where jsonb_typeof(v) <> 'string'
 ) then raise exception 'Use at most 5 screenshot links.'; end if;
 select coalesce(array_agg(image order by position), '{}') into images from (
  select public.screenshot_url(btrim(v)) as image, min(n) as position
  from jsonb_array_elements_text(input) with ordinality x(v,n) group by public.screenshot_url(btrim(v))
 ) shots;
 if exists(select 1 from unnest(images) image where image !~ '^https://\S+$' or char_length(image) > 500) then
  raise exception 'Invalid screenshot links.';
 end if;
 return images;
end;
$$;
revoke all on function public.screenshot_candidates(jsonb) from public, anon, authenticated, service_role;

create function public.append_screenshots(kept text[], candidates text[]) returns text[]
language sql immutable set search_path = '' as $$
 select coalesce(array_agg(image order by position),'{}') from (
  select image, min(n) as position from unnest(kept || candidates) with ordinality x(image,n)
  group by image order by min(n) limit greatest(5,cardinality(kept))
 ) shots;
$$;
revoke all on function public.append_screenshots(text[],text[]) from public, anon, authenticated, service_role;

create function public.addons_screenshots() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 -- Preserve old six-image rows on unrelated edits and during 90-day recovery.
 if cardinality(new.images) > 5 and not public.doing('restore') and not public.doing('revert') then
  if tg_op = 'INSERT' then raise exception 'Use at most 5 screenshot links.'; end if;
  if new.images is distinct from old.images then raise exception 'Use at most 5 screenshot links.'; end if;
 end if;
 select coalesce(array_agg(public.screenshot_url(image) order by n),'{}') into new.images
 from unnest(new.images) with ordinality x(image,n);
 return new;
end;
$$;
revoke all on function public.addons_screenshots() from public, anon, authenticated, service_role;
-- Before freshness, length and host validation.
create trigger addons_aa_screenshots before insert or update on public.addons
 for each row execute function public.addons_screenshots();

alter table public.addon_link_requests add column images text[] not null default '{}'
 check(cardinality(images) <= 5);

create or replace function public.request_addon_link(target bigint, link text, screenshots jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare normalized text; a public.addons; shots text[];
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot suggest links.'; end if;
 shots := public.screenshot_candidates(coalesce(screenshots,'[]'::jsonb));
 if not public.is_admin() and exists(select 1 from unnest(shots) image where not public.host_allowed(image,'image')) then
  raise exception 'That screenshot host is not allowed.';
 end if;
 link := btrim(link);
 if link is null or char_length(link) > 300 or link !~ '^https://\S+$' then raise exception 'A valid HTTPS addon link is required.'; end if;
 if not public.is_admin() and not public.host_allowed(link, 'link') then raise exception 'That link host is not allowed.'; end if;
 select * into a from public.addons where id = target for update;
 if a.id is null then raise exception 'That addon no longer exists.'; end if;
 normalized := public.link_key(link);
 if exists(select 1 from public.addons where link_keys @> array[normalized]) then raise exception 'This link is already listed.'; end if;
 if jsonb_array_length(a.versions) >= 100 then raise exception 'This addon already has the maximum number of links.'; end if;
 if public.is_admin() then
  perform public.add_addon_link(target, link);
  update public.addons set images = public.append_screenshots(a.images, shots) where id = target;
  return target;
 end if;
 if exists(select 1 from public.addon_link_requests where key = normalized and status = 'pending') then raise exception 'This link is already waiting for admin review.'; end if;
 -- Serialize the daily allowance across submissions to different addons.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 27));
 if (select count(*) from public.addon_link_requests where proposed_by = auth.uid() and created_at > now() - interval '1 day') >= 20 then
  raise exception 'You can suggest at most 20 links a day.' using errcode = 'LIMIT';
 end if;
 insert into public.addon_link_requests(addon_id, proposed_by, url, key, images) values(target, auth.uid(), link, normalized, shots);
 return target;
end;
$$;
revoke all on function public.request_addon_link(bigint,text,jsonb) from public, anon, service_role;
grant execute on function public.request_addon_link(bigint,text,jsonb) to authenticated;
create or replace function public.request_addon_link(target bigint, link text) returns bigint
language sql security definer set search_path = '' as $$
 select public.request_addon_link(target, link, '[]'::jsonb);
$$;

create or replace function public.submit_addon(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot submit addons.'; end if;
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
create or replace function public.decide_addon_link(request_id bigint, accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.addon_link_requests;
begin
 if not public.is_admin() then raise exception 'Only admins can review links.'; end if;
 select * into r from public.addon_link_requests where id = request_id and status = 'pending' for update;
 if r.id is null then raise exception 'That link is no longer pending.'; end if;
 if accept then
  if exists(select 1 from public.profiles where id = r.proposed_by and banned) then raise exception 'This contributor is banned. Reject the suggestion.'; end if;
  perform public.add_addon_link(r.addon_id, r.url);
  update public.addons set images = public.append_screenshots(images, r.images) where id = r.addon_id;
  update public.addon_link_contributions set submitted_by = r.proposed_by where addon_id = r.addon_id and url = r.url;
  insert into public.addon_contributors(addon_id,user_id) values(r.addon_id,r.proposed_by) on conflict do nothing;
 end if;
 update public.addon_link_requests set status = case when accept then 'accepted' else 'rejected' end,
  decided_by = auth.uid(), decided_at = now() where id = r.id;
end;
$$;
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
  kept := public.append_screenshots(kept, candidates);
  perform public.add_addon_link(target, q.url);
  update public.addons set images = kept where id = target and images is distinct from kept;
 else
  draft := coalesce(input, jsonb_build_object('name', title, 'description', btrim(q.description), 'category', q.category,
   'author', public.link_author(q.url), 'images', to_jsonb(q.images[1:5])));
  insert into public.addons(name, description, category, author, versions, images, source)
  values(title, coalesce(draft ->> 'description', ''), draft ->> 'category', coalesce(draft ->> 'author', ''),
   jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
   array(select jsonb_array_elements_text(coalesce(draft -> 'images', '[]'))), q.source) returning id into target;
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
   if field = 'images' then value := to_jsonb(public.screenshot_candidates(value)); end if;
   if value = 'null'::jsonb then raise exception 'An edit field cannot be null.'; end if;
   if field in ('name','description','category','author') and jsonb_typeof(value) <> 'string' then raise exception 'Invalid edit field.'; end if;
   if field in ('images','versions') and jsonb_typeof(value) <> 'array' then raise exception 'Invalid edit list.'; end if;
   if field = 'name' and (char_length(input ->> field) not between 2 and 60 or public.addon_name_key(input ->> field) = '') then raise exception 'Invalid addon name.'; end if;
   if field = 'description' and char_length(input ->> field) > 5000 then raise exception 'The description is too long.'; end if;
   if field in ('category','author') and char_length(input ->> field) > 60 then raise exception 'That field is too long.'; end if;
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
			-- At most five, each an https address of a sane length, like an addon's own.
			coalesce(
				(
					select array_agg(image order by place)
					from (
						select image, place
						from jsonb_array_elements_text(coalesce(i -> 'images', '[]')) with ordinality as listed(image, place)
						where image ~ '^https://\S+$' and char_length(image) <= 500
						order by place
						limit 5
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
create or replace function public.split_addon_link(target bigint, link text, new_name text default null) returns bigint
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
  jsonb_build_array(moved), coalesce(q.images[1:5], '{}'::text[]), coalesce(q.source, ''), false, true)
 returning id into made;
 update public.addon_link_contributions set submitted_by = contributor where addon_id = made and url = link;
 insert into public.addon_contributors(addon_id, user_id)
 select made, submitted_by from public.addon_link_contributions where addon_id = made and submitted_by is not null
 on conflict do nothing;
 update public.import_queue set addon_id = made where id = q.id and status = 'approved';
 return made;
end;
$$;
notify pgrst, 'reload schema';
