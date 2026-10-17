-- Dead repositories are an automatic outcome, not an admin rejection.
alter table public.import_queue drop constraint import_queue_status_check;
alter table public.import_queue add constraint import_queue_status_check
 check (status in ('pending', 'approved', 'rejected', 'submitted', 'dead'));
-- Preserve the full published entry even when its last link leaves the public list.
alter table public.import_queue add column dead_snapshot jsonb;

update public.import_queue q set status = 'dead', decided_by = null,
 decided_at = now(), problem = null
from public.repo_stats s where s.key = q.key and s.missing
 and q.status in ('pending', 'rejected');

-- Called after saving this run's successful checks. Never act on an unanswered
-- repository's retained facts, or on an archived-but-still-available repository.
create function public.retire_dead_links(token text, keys text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 dead_keys text[];
 a public.addons;
 v jsonb;
 kept jsonb;
 removed integer := 0;
 retired integer := 0;
 queued integer;
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can retire dead links.'; end if;
 select coalesce(array_agg(s.key), '{}') into dead_keys
 from public.repo_stats s join public.repo_stats_checks c using (key)
 where s.key = any(keys) and s.missing and c.checked_at >= now() - interval '1 hour';

 update public.import_queue q set status = 'dead', decided_by = null,
  decided_at = now(), problem = null
 where q.key = any(dead_keys) and q.status in ('pending', 'rejected');
 get diagnostics queued = row_count;

 for a in select * from public.addons where link_keys && dead_keys order by id for update loop
  for v in select value from jsonb_array_elements(a.versions) where public.link_key(value ->> 'url') = any(dead_keys) loop
   insert into public.import_queue (key, url, name, description, category, images, status, decided_at, dead_snapshot)
   values (public.link_key(v ->> 'url'), v ->> 'url', a.name, a.description, a.category, a.images, 'dead', now(),
    to_jsonb(a) || jsonb_build_object('removed_link', v))
   on conflict (key) do update set status = 'dead', decided_by = null, decided_at = now(), problem = null,
    dead_snapshot = excluded.dead_snapshot;
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
revoke all on function public.retire_dead_links(text, text[]) from public, authenticated, service_role;
grant execute on function public.retire_dead_links(text, text[]) to anon;
notify pgrst, 'reload schema';
