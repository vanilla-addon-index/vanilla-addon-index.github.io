-- Optional search comparisons, kept separate from the readable description.
alter table public.addons add column similar_addons text not null default ''
 check (char_length(similar_addons) <= 500);
grant select (similar_addons) on public.addons to anon;
grant insert (similar_addons), update (similar_addons) on public.addons to authenticated;

create function public.addons_similar_clean() returns trigger
language plpgsql set search_path = '' as $$
begin
 select coalesce(string_agg(name, ', ' order by position), '') into new.similar_addons
 from (
  select btrim(regexp_replace(value, '\s+', ' ', 'g')) as name, min(position) as position
  from unnest(string_to_array(new.similar_addons, ',')) with ordinality x(value, position)
  where btrim(value) <> '' group by btrim(regexp_replace(value, '\s+', ' ', 'g'))
 ) names;
 return new;
end;
$$;
create trigger addons_aa_similar_clean before insert or update on public.addons
 for each row execute function public.addons_similar_clean();

-- Preserve the field across submissions, review, recovery, and trash restoration.
create or replace function public.submit_addon_before_link_reviews(input jsonb) returns bigint
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
  return public.add_addon_link(target, btrim(input -> 'versions' -> 0 ->> 'url'));
 end if;
 insert into public.addons(name, description, similar_addons, category, author, versions, images)
 values(title, coalesce(input ->> 'description', ''), coalesce(input ->> 'similar_addons', ''), input ->> 'category', coalesce(input ->> 'author', ''),
  input -> 'versions', array(select jsonb_array_elements_text(coalesce(input -> 'images', '[]')))) returning id into target;
 return target;
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
	approver uuid;
	made bigint;
	gid bigint;
	others bigint[];
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
	for holder in select id, versions, shared from public.addons where link_keys && keys loop
		select jsonb_agg(v) into kept
		from jsonb_array_elements(holder.versions) v
		where not public.link_key(v ->> 'url') = any (keys);
		if kept is null and not holder.shared then
			raise exception 'Another addon now lists only these links. Edit or delete it first.';
		end if;
        kept := coalesce(kept,'[]');
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

	-- Back to whoever posted it, if that account still exists; to nobody otherwise, and
	-- never to whoever restores it. The same goes for who approved an import.
	select id into poster from public.profiles where id = (a ->> 'owner')::uuid;
	select id into approver from public.profiles where id = (a ->> 'approved_by')::uuid;

	made := (a ->> 'id')::bigint;
	if made is null or exists (select 1 from public.addons where id = made) then
		made := nextval(pg_get_serial_sequence('public.addons', 'id'));
	end if;

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		id, slug, name, description, similar_addons, category, author, versions, images, source, aliases, owner, approved_by, created_at, updated_at, shared, pinned_link, separate_name
	)
	overriding system value
	values (
		made,
		new_slug,
		a ->> 'name',
		coalesce(a ->> 'description', ''), coalesce(a ->> 'similar_addons', ''),
		a ->> 'category',
		coalesce(a ->> 'author', ''),
		a -> 'versions',
		array(select jsonb_array_elements_text(coalesce(a -> 'images', '[]'))),
		coalesce(a ->> 'source', ''),
		array(select jsonb_array_elements_text(coalesce(a -> 'aliases', '[]'))),
		poster,
		approver,
		(a ->> 'created_at')::timestamptz,
		coalesce((a ->> 'updated_at')::timestamptz, now()), coalesce((a ->> 'shared')::boolean, false), a ->> 'pinned_link', true
	);
 if a ? 'contributors' then
  delete from public.addon_contributors where addon_id = made;
  insert into public.addon_contributors select made,p.id from public.profiles p
   where p.id::text in(select jsonb_array_elements_text(a -> 'contributors'));
 elsif poster is not null then
  insert into public.addon_contributors values(made,poster) on conflict do nothing;
 end if;
 if a ? 'link_contributors' then
  update public.addon_link_contributions c set submitted_by = (select p.id from public.profiles p where p.id::text = a -> 'link_contributors' ->> c.url) where c.addon_id = made;
 end if;

	perform set_config('app.doing', '', true);

	-- Back in its group: the one it left if that still exists, or the group of two that
	-- fell apart when it was deleted. See the groups migration.
	gid := (a ->> 'group_id')::bigint;
	if gid is not null then
		others := array(select jsonb_array_elements_text(coalesce(a -> 'group_members', '[]'))::bigint);
		if exists (select 1 from public.addons where group_id = gid) then
			update public.addons set group_id = gid, is_main = false where id = made;
		elsif cardinality(others) = 1 and exists (select 1 from public.addons where id = others[1] and group_id is null) then
			update public.addons set group_id = gid, is_main = (id <> made) where id in (made, others[1]);
		else
			gid := null;
		end if;
		if gid is not null then
			if coalesce((a ->> 'is_main')::boolean, false) then
				update public.addons set is_main = (id = made) where group_id = gid and is_main is distinct from (id = made);
			end if;
			perform public.tidy_group(gid);
		end if;
	end if;

	-- An approved import points at its addon again.
	update public.import_queue set addon_id = made where addon_id is null and status = 'approved' and key = any (keys);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

create or replace function public.propose_addon_edit(target bigint, input jsonb, base jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; patch jsonb := '{}'; prior jsonb := '{}'; field text; made bigint; value jsonb;
begin
 if not coalesce((public.addon_contribution_access(target) ->> 'can_propose')::boolean, false) then raise exception 'Only contributors can propose edits to this shared page.'; end if;
 if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(base) is distinct from 'object' or octet_length(input::text) > 65536 then raise exception 'Invalid edit proposal.'; end if;
 select * into a from public.addons where id = target for update;
 foreach field in array array['name','description','similar_addons','category','author','images','versions'] loop
  if input ? field and input -> field is distinct from base -> field then
   if base -> field is distinct from to_jsonb(a) -> field then raise exception 'The page changed while you were editing. Reload it before proposing changes.'; end if;
   value := input -> field;
   if field = 'images' then value := to_jsonb(public.screenshot_candidates(value)); end if;
   if value = 'null'::jsonb then raise exception 'An edit field cannot be null.'; end if;
   if field in ('name','description','similar_addons','category','author') and jsonb_typeof(value) <> 'string' then raise exception 'Invalid edit field.'; end if;
   if field in ('images','versions') and jsonb_typeof(value) <> 'array' then raise exception 'Invalid edit list.'; end if;
   if field = 'name' and (char_length(input ->> field) not between 2 and 60 or public.addon_name_key(input ->> field) = '') then raise exception 'Invalid addon name.'; end if;
   if field = 'similar_addons' and char_length(value #>> '{}') > 500 then raise exception 'Similar addons can be at most 500 characters.'; end if;
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

create or replace function public.decide_addon_edit(request_id bigint, accept boolean, fields text[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.addon_edit_requests; a public.addons; changed public.addons; patch jsonb := '{}'; field text;
begin
 if not public.is_admin() then raise exception 'Only admins can review edits.'; end if;
 select * into r from public.addon_edit_requests where id = request_id and status = 'pending' for update;
 if r.id is null then raise exception 'That edit is no longer pending.'; end if;
 if accept then
  if exists(select 1 from public.profiles where id = r.proposed_by and banned) then raise exception 'This contributor is banned. Reject the proposal.'; end if;
  select * into a from public.addons where id = r.addon_id for update;
  if fields is null then fields := array(select jsonb_object_keys(r.changes)); end if;
  if cardinality(fields) = 0 then raise exception 'Select at least one field to accept.'; end if;
  foreach field in array fields loop
   if not (r.changes ? field) then raise exception 'That field was not proposed.'; end if;
   if to_jsonb(a) -> field is distinct from r.base -> field then raise exception 'The % field changed since this proposal. Ask the contributor to revise it.', field; end if;
   patch := patch || jsonb_build_object(field,r.changes -> field);
  end loop;
  changed := jsonb_populate_record(a,patch);
  update public.addons set name = changed.name, description = changed.description, similar_addons = changed.similar_addons, category = changed.category,
   author = changed.author, images = changed.images, versions = changed.versions where id = a.id;
  -- New destinations are new contributions, credited to the proposer after review.
  update public.addon_link_contributions c set submitted_by = r.proposed_by where c.addon_id = a.id
   and not exists(select 1 from jsonb_array_elements(a.versions) v where v ->> 'url' = c.url);
 end if;
 update public.addon_edit_requests set status = case when accept then 'accepted' else 'rejected' end,
  accepted_fields = case when accept then fields else null end, decided_by = auth.uid(), decided_at = now(), updated_at = now() where id = r.id;
end;
$$;

create or replace function public.addons_edit_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
 hourly integer;
 daily integer;
 in_hour integer;
 in_day integer;
begin
 if auth.uid() is null or public.is_owner() or public.doing('remove_link') then
  return new;
 end if;
 -- Include pinned links and shared status: reverting only this metadata also
 -- writes a full before-image to History and must not bypass the budget.
 if (new.name, new.description, new.similar_addons, new.category, new.author, new.versions, new.images, new.pinned_link, new.shared)
  is not distinct from (old.name, old.description, old.similar_addons, old.category, old.author, old.versions, old.images, old.pinned_link, old.shared) then
  return new;
 end if;

 -- Serialize each account's budget check across concurrent requests, including
 -- requests updating different addons. Held until the audit entry is committed.
 perform pg_advisory_xact_lock(hashtextextended('addon-edit-budget:' || auth.uid()::text, 0));
 hourly := case when public.is_admin() then 30 else 10 end;
 daily := case when public.is_admin() then 90 else 30 end;
 select count(*) filter (where at > now() - interval '1 hour'), count(*)
 into in_hour, in_day
 from public.activity_log
 where actor = auth.uid() and action in ('addon.update', 'addon.revert')
  and at > now() - interval '1 day';
 if in_hour >= hourly then
  raise exception 'You can make at most % edits an hour. Try again later.', hourly using errcode = 'LIMIT';
 end if;
 if in_day >= daily then
  raise exception 'You can make at most % edits a day. Try again tomorrow.', daily using errcode = 'LIMIT';
 end if;
 return new;
end;
$$;

create or replace function private.edit_recovery_plan(source_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; f text; fields text[]; patch jsonb := '{}'; conflicts jsonb := '[]'; link jsonb; expected jsonb; current_link jsonb;
begin
 select * into e from public.activity_log where id=source_id;
 select * into a from public.addons where id=e.addon_id;
 fields := array(select jsonb_array_elements_text(coalesce(e.details->'changed','[]')));
 if a.id is null then return jsonb_build_object('conflicts',jsonb_build_array('addon'),'patch','{}','current','{}'); end if;
 if not coalesce(e.details ? 'after',false) or cardinality(fields)=0 then
  return jsonb_build_object('conflicts',jsonb_build_array('unrecorded changes'),'patch','{}','current',to_jsonb(a));
 end if;
 foreach f in array fields loop
  -- Availability is derived from the links by a trigger, never restored from History.
  if f in ('unavailable_links','slug','aliases','link_code_updates') then continue; end if;
  if f not in ('name','description','similar_addons','category','author','versions','images','pinned_link','shared','separate_name') then conflicts:=conflicts||to_jsonb(f); continue; end if;
  if f='versions' and (jsonb_typeof(e.details->'added_links')='array' or jsonb_typeof(e.details->'removed_links')='array') then
   for link in select value from jsonb_array_elements(coalesce(e.details->'added_links',e.details->'removed_links')) loop
    if jsonb_typeof(link)='string' then
     select v into expected from jsonb_array_elements(e.details->'after'->'versions') v where v->>'url'=link#>>'{}';
    else expected:=link; end if;
    select v into current_link from jsonb_array_elements(a.versions) v where v->>'url'=expected->>'url';
    if current_link is not null and current_link is distinct from expected then conflicts:=conflicts||to_jsonb(f); end if;
   end loop;
  elsif to_jsonb(a)->f is distinct from e.details->'before'->f and to_jsonb(a)->f is distinct from e.details->'after'->f then
   conflicts:=conflicts||to_jsonb(f);
  elsif not (e.details->'before' ? f) or not(e.details->'after' ? f) then
   conflicts:=conflicts||to_jsonb(f);
  else patch:=patch||jsonb_build_object(f,e.details->'before'->f);
  end if;
 end loop;
 return jsonb_build_object('conflicts',conflicts,'patch',patch,'current',to_jsonb(a));
end;
$$;

create or replace function public.recover_edit(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; changed public.addons; plan jsonb; newest_before bigint;
begin
 if not public.is_admin() then raise exception 'Only admins can revert edits.'; end if;
 select * into e from public.activity_log where id=log_id and action in ('addon.update','addon.revert') for update;
 if e.id is null then raise exception 'That log line is not an edit.'; end if;
 if e.details->'before' is null then raise exception 'That edit is too old to revert: what an addon looked like before an edit is kept for 90 days.'; end if;
 if exists(select 1 from public.activity_log where details->>'undid'=e.id::text and action in ('addon.update','addon.revert','addon.recovery')) then raise exception 'This edit has already been recovered.'; end if;
 select * into a from public.addons where id=e.addon_id for update;
 if a.id is null then raise exception 'That addon no longer exists. Look for it in the trash.'; end if;
 plan:=private.edit_recovery_plan(e.id);
 if jsonb_array_length(plan->'conflicts')>0 then raise exception 'Conflicts with later changes—review manually.'; end if;
 select coalesce(max(id),0) into newest_before from public.activity_log;
 if jsonb_typeof(e.details->'added_links')='array' or jsonb_typeof(e.details->'removed_links')='array' then
  perform private.apply_edit_recovery(e.id);
 else
  changed:=jsonb_populate_record(a,plan->'patch');
  perform set_config('app.doing','revert',true);
  update public.addons set name=changed.name,description=changed.description,similar_addons=changed.similar_addons,category=changed.category,author=changed.author,
   versions=changed.versions,images=changed.images,pinned_link=changed.pinned_link,shared=changed.shared,separate_name=changed.separate_name where id=a.id;
  perform set_config('app.doing','',true);
 end if;
 perform private.finish_edit_recovery(e,newest_before,false);
end;
$$;

create or replace function public.resolve_log_edit(log_id bigint, input jsonb, expected_updated timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; a public.addons; changed public.addons; patch jsonb; newest_before bigint;
begin
 if not public.is_admin() then raise exception 'Only admins can resolve edits.'; end if;
 select * into e from public.activity_log where id=log_id and action in ('addon.update','addon.revert') for update;
 if e.id is null then raise exception 'That log line is not an edit.'; end if;
 if exists(select 1 from public.activity_log where details->>'undid'=e.id::text and action in ('addon.update','addon.revert','addon.recovery')) then raise exception 'This edit has already been recovered.'; end if;
 select * into a from public.addons where id=e.addon_id for update;
 if a.id is null or a.updated_at is distinct from expected_updated then raise exception 'This addon changed while you were reviewing it. Reload before saving; nothing was overwritten.'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into patch from jsonb_each(input) where key in ('name','description','similar_addons','category','author','versions','images');
 changed:=jsonb_populate_record(a,patch);
 select coalesce(max(id),0) into newest_before from public.activity_log;
 update public.addons set name=changed.name,description=changed.description,similar_addons=changed.similar_addons,category=changed.category,author=changed.author,versions=changed.versions,images=changed.images where id=a.id;
 perform private.finish_edit_recovery(e,newest_before,true);
end;
$$;
