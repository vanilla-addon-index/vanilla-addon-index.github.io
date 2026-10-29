-- A missing response starts a grace period, not an immediate retirement.
-- Kept separately from mutable facts so unchanged NOT_FOUND results retain the start.
create table public.repo_missing_since (
 key text primary key references public.repo_stats(key) on delete cascade,
 since timestamptz not null default now()
);
alter table public.repo_missing_since enable row level security;
revoke all on public.repo_missing_since from public, anon, authenticated, service_role;

alter table public.addons add column unavailable_links text[] not null default '{}';
grant select (unavailable_links) on public.addons to anon;

-- Keep the existing fact accounting and partial-result handling in one implementation.
alter function public.store_repo_stats(text, jsonb, boolean) rename to store_repo_stats_facts;
revoke all on function public.store_repo_stats_facts(text, jsonb, boolean) from public, anon, authenticated, service_role;
create function public.store_repo_stats(token text, stats jsonb, report boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; previous_action text;
begin
 result := public.store_repo_stats_facts(token, stats, report);
 insert into public.repo_missing_since(key)
 select s.key from public.repo_stats s
 where s.missing and s.key in (select value ->> 'key' from jsonb_array_elements(stats))
  and s.key in (select public.nightly_keys())
 on conflict (key) do nothing;
 delete from public.repo_missing_since m using public.repo_stats s
 where m.key = s.key and not s.missing
  and s.key in (select value ->> 'key' from jsonb_array_elements(stats));

 -- Availability is system metadata, not a contributor edit in the activity log.
 previous_action := current_setting('app.doing', true);
 perform set_config('app.doing', 'code_refresh', true);
 update public.addons a set unavailable_links = (
  select coalesce(array_agg(v ->> 'url' order by n), '{}')
  from jsonb_array_elements(a.versions) with ordinality x(v,n)
  where exists(select 1 from public.repo_missing_since m where m.key = public.link_key(v ->> 'url'))
 ) where a.link_keys && array(select value ->> 'key' from jsonb_array_elements(stats))
 and a.unavailable_links is distinct from (
  select coalesce(array_agg(v ->> 'url' order by n), '{}')
  from jsonb_array_elements(a.versions) with ordinality x(v,n)
  where exists(select 1 from public.repo_missing_since m where m.key = public.link_key(v ->> 'url'))
 );
 perform set_config('app.doing', coalesce(previous_action, ''), true);
 return result;
end;
$$;
revoke all on function public.store_repo_stats(text, jsonb, boolean) from public, authenticated, service_role;
grant execute on function public.store_repo_stats(text, jsonb, boolean) to anon;
create or replace function public.store_repo_stats(token text, stats jsonb) returns integer
language sql security definer set search_path = '' as $$
 select (public.store_repo_stats(token, stats, true) ->> 'accepted')::integer;
$$;

-- Restored/reverted links get a fresh chance. Ordinary edits to an existing link
-- do not extend its grace period. Derive the public label rather than trusting input.
create function public.addons_link_availability() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if tg_op = 'INSERT' then
  delete from public.repo_missing_since m where m.key in (
   select public.link_key(v ->> 'url') from jsonb_array_elements(new.versions) v
  );
 elsif new.versions is distinct from old.versions then
  delete from public.repo_missing_since m where m.key in (
   select public.link_key(v ->> 'url') from jsonb_array_elements(new.versions) v
   except select public.link_key(v ->> 'url') from jsonb_array_elements(old.versions) v
  );
 end if;
 select coalesce(array_agg(v ->> 'url' order by n), '{}') into new.unavailable_links
 from jsonb_array_elements(new.versions) with ordinality x(v,n)
 where exists(select 1 from public.repo_missing_since m where m.key = public.link_key(v ->> 'url'));
 return new;
end;
$$;
revoke all on function public.addons_link_availability() from public, anon, authenticated, service_role;
create trigger addons_link_availability before insert or update on public.addons
 for each row execute function public.addons_link_availability();

create or replace function public.retire_dead_links(token text, keys text[]) returns jsonb
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
 join public.repo_missing_since m using (key)
 where s.key = any(keys) and s.missing and c.checked_at >= now() - interval '1 hour'
  and m.since <= now() - interval '14 days';

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
