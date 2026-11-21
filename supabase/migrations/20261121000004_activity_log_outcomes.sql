-- Keep the direction of a pin change after nightly retention removes edit snapshots.
create function private.log_pin_change(details jsonb) returns text
language sql immutable set search_path = '' as $$
 select case
  when details -> 'changed' ? 'pinned_link' then
   case
    when details #> '{before,pinned_link}' = 'null'::jsonb
     and jsonb_typeof(details #> '{after,pinned_link}') = 'string' then 'pinned'
    when details #> '{after,pinned_link}' = 'null'::jsonb
     and jsonb_typeof(details #> '{before,pinned_link}') = 'string' then 'unpinned'
    when jsonb_typeof(details #> '{before,pinned_link}') = 'string'
     and jsonb_typeof(details #> '{after,pinned_link}') = 'string'
     and details #> '{before,pinned_link}' <> details #> '{after,pinned_link}' then 'repinned'
   end
 end;
$$;
revoke all on function private.log_pin_change(jsonb) from public, anon, authenticated, service_role;

update public.activity_log
set details = details || jsonb_build_object('pin_change', private.log_pin_change(details))
where action in ('addon.update', 'addon.revert') and private.log_pin_change(details) is not null;

create or replace function public.log_action(action text, subject text, addon bigint, details jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare pin_change text;
begin
 if action in ('group.add','group.remove','group.main','group.undo') and jsonb_typeof(details->'groups_before')='array' then
  details:=details||jsonb_build_object('groups_after',public.groups_of(array(select (v->>'id')::bigint from jsonb_array_elements(details->'groups_before') v)));
 end if;
 if action in ('addon.update', 'addon.revert') then
  pin_change := private.log_pin_change(details);
  if pin_change is not null then
   details := details || jsonb_build_object('pin_change', pin_change);
  end if;
 end if;
 if action = 'import.approve' and public.doing('split') then action := 'addon.create'; end if;
 if action = 'import.approve' and details is null then
  select jsonb_build_object('url', a.versions #>> '{0,url}') into details
  from public.addons a where a.id = addon and jsonb_array_length(a.versions) = 1;
 end if;
 insert into public.activity_log(actor,actor_name,action,subject,addon_id,details)
 values(auth.uid(),(select username from public.profiles where id=auth.uid()),action,subject,addon,details);
end;
$$;

-- Review outcomes are distinct from any resulting edit to published content.
create function private.log_addon_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
 item jsonb := to_jsonb(new);
 kind text := case tg_table_name when 'addon_edit_requests' then 'edit' else 'link' end;
 event text;
begin
 if tg_op = 'INSERT' then
  event := 'proposed';
 elsif old.status is distinct from new.status then
  event := new.status;
 elsif new.status = 'pending' and
   (to_jsonb(old) - 'updated_at') is distinct from (item - 'updated_at') then
  event := 'revised';
 else
  return null;
 end if;

 perform public.log_action(
  'review.' || kind || '.' || event,
  (select name from public.addons where id = new.addon_id),
  new.addon_id,
  jsonb_strip_nulls(jsonb_build_object(
   'request_id', new.id,
   'url', item ->> 'url',
   'fields', case when kind = 'edit' then
    case when event = 'accepted' then item -> 'accepted_fields'
     else to_jsonb(array(select jsonb_object_keys(item -> 'changes') order by 1))
    end
   end
  ))
 );
 return null;
end;
$$;
revoke all on function private.log_addon_review() from public, anon, authenticated, service_role;

create trigger addon_edit_requests_audit after insert or update on public.addon_edit_requests
for each row execute function private.log_addon_review();
create trigger addon_link_requests_audit after insert or update on public.addon_link_requests
for each row execute function private.log_addon_review();

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
 target := coalesce(destination, target);
 if target is not null then
  -- Lock the destination while filling its remaining screenshot slots.
  select images into kept from public.addons where id = target for update;
  candidates := case when input ? 'images' then
   array(select jsonb_array_elements_text(input -> 'images')) else q.images end;
  kept := public.append_screenshots(kept, candidates);
  perform public.add_addon_link(target, q.url);
  update public.addons set images = kept where id = target and images is distinct from kept;
  perform public.log_action('import.attach', (select name from public.addons where id = target), target,
   jsonb_build_object('url', q.url, 'import_id', q.id));
 else
  draft := coalesce(input, jsonb_build_object('name', title, 'description', btrim(q.description), 'category', q.category,
   'author', public.link_author(q.url), 'images', to_jsonb(q.images[1:5])));
  insert into public.addons(name, description, entry_type, category, author, versions, images, source)
  values(title, coalesce(draft ->> 'description', ''), coalesce(draft ->> 'entry_type', q.entry_type), draft ->> 'category', coalesce(draft ->> 'author', ''),
   jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
   array(select jsonb_array_elements_text(coalesce(draft -> 'images', '[]'))), q.source) returning id into target;
 end if;
 update public.import_queue set entry_type = (select entry_type from public.addons where id = target), status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null where id = queue_id;
 return target;
end;
$$;

-- A log entry identifies one approval. A newer import on the same page must
-- never be requeued in its place.
create function public.requeue_import_approval(log_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.activity_log; q public.import_queue; a public.addons;
begin
 if not public.is_admin() then raise exception 'Only admins can review imports.'; end if;
 select * into e from public.activity_log where id = log_id and action in ('import.approve', 'import.attach');
 if e.id is null then raise exception 'That log entry does not record an import approval.'; end if;
 begin
  select * into strict q from public.import_queue
  where status = 'approved' and addon_id = e.addon_id and decided_at = e.at
   and decided_by is not distinct from e.actor
   and (e.details ->> 'import_id' is null or id::text = e.details ->> 'import_id')
   and (e.details ->> 'url' is null or key = public.link_key(e.details ->> 'url'))
  for update;
 exception
  when no_data_found then return false;
  when too_many_rows then raise exception 'This older approval cannot be matched to one import safely.';
 end;
 select * into a from public.addons where id = e.addon_id for update;
 if a.id is null or not (a.link_keys @> array[q.key]) then return false; end if;
 if not a.shared and jsonb_array_length(a.versions) = 1 then
  delete from public.addons where id = a.id;
 else
  update public.addons set versions = (
   select coalesce(jsonb_agg(v order by n), '[]')
   from jsonb_array_elements(a.versions) with ordinality as versions(v, n)
   where public.link_key(v ->> 'url') <> q.key
  ) where id = a.id;
 end if;
 update public.import_queue set status = 'pending', decided_at = null, decided_by = null, addon_id = null, problem = null
 where id = q.id;
 perform public.log_action('import.requeue', q.name, a.id,
  jsonb_build_object('url', q.url, 'import_id', q.id, 'undid', e.id));
 return true;
end;
$$;
revoke all on function public.requeue_import_approval(bigint) from public, anon, service_role;
grant execute on function public.requeue_import_approval(bigint) to authenticated;

create index activity_log_related_addon_idx on public.activity_log ((details ->> 'related_addon_id'), id desc)
where details ->> 'related_addon_id' is not null;

create or replace function public.split_addon_link(target bigint, link text, new_name text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; q public.import_queue; made bigint; kept jsonb; moved jsonb; contributor uuid; title text;
 prior_action text := current_setting('app.doing', true);
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
 perform set_config('app.doing', 'split', true);
 insert into public.addons(name, description, entry_type, category, author, versions, images, source, separate_name, shared)
 values(title, coalesce(q.description, ''),
  a.entry_type, coalesce(nullif(q.category, ''), 'Miscellaneous'), public.link_author(link),
  jsonb_build_array(moved), coalesce(q.images[1:5], '{}'::text[]), coalesce(q.source, ''), false, true)
 returning id into made;
 perform set_config('app.doing', coalesce(prior_action, ''), true);
 update public.addon_link_contributions set submitted_by = contributor where addon_id = made and url = link;
 insert into public.addon_contributors(addon_id, user_id)
 select made, submitted_by from public.addon_link_contributions where addon_id = made and submitted_by is not null
 on conflict do nothing;
 update public.import_queue set addon_id = made where id = q.id and status = 'approved';
 perform public.log_action('addon.split', a.name, a.id,
  jsonb_build_object('url', link, 'related_addon_id', made, 'target', title));
 return made;
end;
$$;

create or replace function public.merge_addon_links(source_id bigint, target_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.addons; t public.addons;
begin
 if source_id = target_id then raise exception 'Pick two different addons.'; end if;
 perform id from public.addons where id in(source_id, target_id) order by id for update;
 select * into s from public.addons where id = source_id;
 select * into t from public.addons where id = target_id;
 if s.id is null or t.id is null then raise exception 'An addon no longer exists.'; end if;
 insert into public.addon_contributors select target_id, user_id from public.addon_contributors where addon_id = source_id on conflict do nothing;
 update public.addon_link_contributions set addon_id = target_id where addon_id = source_id;
 update public.import_queue set addon_id = target_id where addon_id = source_id;
 delete from public.addons where id = source_id;
 update public.addons set versions = versions || s.versions, aliases = aliases || s.slug || s.aliases,
  group_id = null, is_main = false where id = target_id;
 perform public.log_action('addon.merge', s.name, s.id,
  jsonb_build_object('related_addon_id', t.id, 'target', t.name,
   'urls', array(select v ->> 'url' from jsonb_array_elements(s.versions) v)));
end;
$$;

create or replace function public.queue_discord_imports(items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare added integer; total integer;
begin
 if not public.is_owner() or public.is_banned() then raise exception 'Only the owner can upload Discord exports.'; end if;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) > 2000 then
  raise exception 'Expected at most 2000 repository links.';
 end if;
 if exists (
  select 1 from jsonb_array_elements(items) i
  where jsonb_typeof(i) is distinct from 'object'
   or not coalesce(public.host_allowed(i ->> 'url', 'link'), false)
   or coalesce(i ->> 'url', '') !~ '^https://[^/]+/[^/?#[:space:]]+/[^?#[:space:]]+'
   or ((i ->> 'url') ~ '^https://(www\.)?octowow\.st/' and (i ->> 'url') !~ '^https://(www\.)?octowow\.st/git/[^/?#[:space:]]+/[^/?#[:space:]]+')
   or btrim(coalesce(i ->> 'name', '')) = ''
 ) then raise exception 'Invalid repository candidate.'; end if;
 with entries as materialized (
  select distinct on (public.link_key(i ->> 'url')) i, public.link_key(i ->> 'url') as key
  from jsonb_array_elements(items) i
 ), live as materialized (
  select unnest(link_keys) as key from public.addons
 ), taken as (
  select key from live
  union select s.key from public.repo_stats s where s.canonical in (select key from live)
  union select s.canonical from public.repo_stats s where s.key in (select key from live)
 ), inserted as (
  insert into public.import_queue(key, url, name, description, source, category)
  select e.key, e.i ->> 'url', left(btrim(e.i ->> 'name'),120),
   left(coalesce(e.i ->> 'description',''),5000), 'Discord', ''
  from entries e where not exists (select 1 from taken t where t.key = e.key)
  on conflict (key) do nothing returning id
 ) select count(*) into added from inserted;
 select count(distinct public.link_key(i ->> 'url')) into total from jsonb_array_elements(items) i;
 perform public.log_action('import.discord_upload', 'Discord imports', null,
  jsonb_build_object('added', added, 'skipped', total - added));
 return jsonb_build_object('added',added,'skipped',total-added);
end;
$$;

create or replace function public.clear_pending_discord_imports() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
 if not public.is_owner() or public.is_banned() then
  raise exception 'Only the owner can clear Discord imports.';
 end if;
 delete from public.import_queue where source = 'Discord' and status = 'pending';
 get diagnostics removed = row_count;
 perform public.log_action('import.discord_clear', 'Discord imports', null,
  jsonb_build_object('removed', removed));
 return removed;
end;
$$;

create or replace function public.report_addon(addon bigint, reason text, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
	label text;
	made bigint;
begin
	if auth.uid() is null or public.is_banned() then
		raise exception 'You need to be logged in to report an addon.';
	end if;
	select name into label from public.addons where id = addon;
	if label is null then
		raise exception 'That addon no longer exists.';
	end if;
	if (
		select count(*) from public.reports where reported_by = auth.uid() and created_at > now() - interval '1 day'
	) >= 10 then
		raise exception 'You can send at most 10 reports a day.';
	end if;

	insert into public.reports (addon_id, reason, note, reported_by, reported_by_name)
	values (
		addon,
		reason,
		btrim(coalesce(note, '')),
		auth.uid(),
		(select username from public.profiles where id = auth.uid())
	)
	on conflict (addon_id, reported_by) where status = 'open' do nothing returning id into made;
	if found then
		perform public.log_action('report.create', label, addon, jsonb_build_object('reason', reason, 'report_id', made));
	end if;
end;
$$;

create or replace function public.retire_dead_links(token text, keys text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 dead_keys text[];
 a public.addons;
 v jsonb;
 kept jsonb;
 removed integer := 0;
 retired integer := 0;
 queued integer := 0;
 q record;
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can retire dead links.'; end if;
 select coalesce(array_agg(s.key), '{}') into dead_keys
 from public.repo_stats s join public.repo_stats_checks c using (key)
 join public.repo_missing_since m using (key)
 where s.key = any(keys) and s.missing and c.checked_at >= now() - interval '1 hour'
  and m.since <= now() - interval '14 days';

 for q in
  update public.import_queue i set status = 'dead', decided_by = null,
   decided_at = now(), problem = null
  where i.key = any(dead_keys) and i.status in ('pending', 'rejected')
  returning i.id, i.name, i.url
 loop
  queued := queued + 1;
  perform public.log_action('import.dead', q.name, null, jsonb_build_object('url', q.url, 'import_id', q.id));
 end loop;

 for a in select * from public.addons where link_keys && dead_keys order by id for update loop
  for v in select value from jsonb_array_elements(a.versions) where public.link_key(value ->> 'url') = any(dead_keys) loop
   insert into public.import_queue (key, url, name, description, category, images, status, decided_at, dead_snapshot)
   values (public.link_key(v ->> 'url'), v ->> 'url', a.name, a.description, a.category, a.images, 'dead', now(),
    to_jsonb(a) || jsonb_build_object('removed_link', v))
   on conflict (key) do update set status = 'dead', decided_by = null, decided_at = now(), problem = null,
    dead_snapshot = excluded.dead_snapshot;
   perform public.log_action('addon.retire_link', a.name, a.id, jsonb_build_object('url', v ->> 'url'));
   removed := removed + 1;
  end loop;
  select coalesce(jsonb_agg(value order by n), '[]') into kept
  from jsonb_array_elements(a.versions) with ordinality x(value, n)
  where not (public.link_key(value ->> 'url') = any(dead_keys));
  if jsonb_array_length(kept) = 0 then
   delete from public.addons where id = a.id;
   retired := retired + 1;
  else
   perform set_config('app.doing', 'remove_link', true);
   update public.addons set versions = kept,
    pinned_link = case when public.link_key(pinned_link) = any(dead_keys) then null else pinned_link end
   where id = a.id;
   perform set_config('app.doing', '', true);
  end if;
 end loop;
 return jsonb_build_object('queued', queued, 'links_removed', removed, 'addons_removed', retired);
end;
$$;

notify pgrst, 'reload schema';
