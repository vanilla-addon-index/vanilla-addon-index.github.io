-- Evidence also covers published links that never passed through the import queue.
create table public.repository_mirrors (
 url text primary key,
 source text not null check (url <> source)
);
alter table public.repository_mirrors enable row level security;
revoke all on public.repository_mirrors from public, anon, authenticated, service_role;
grant select on public.repository_mirrors to authenticated;
create policy "admins read repository mirrors" on public.repository_mirrors
 for select to authenticated using (public.is_admin());

create function public.mirror_repository_root(url text) returns text
language sql immutable strict set search_path = '' as $$
 select case
  when url ~ '^https://(github\.com|codeberg\.org|gitea\.com)/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
    or url ~ '^https://octowow\.st/git/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
    or url ~ '^https://gitlab\.com/([A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+/?$'
  then case when substr(candidate, 9) !~ '/(\.{0,2}|-)(/|$)' then candidate end
 end
 from (select regexp_replace(rtrim(url, '/'), '\.git$', '') as candidate) normalized;
$$;

alter function public.queue_octowow_imports(text, jsonb) rename to queue_octowow_candidates;
revoke execute on function public.queue_octowow_candidates(text, jsonb) from anon;

create function public.store_repository_mirrors(token text, items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can store mirror evidence.'; end if;
 with evidence as materialized (
  select url, case when count(*) = 1 and min(source) <> url then min(source) end as source
  from (
   select public.mirror_repository_root(i->>'url') as url,
    public.mirror_repository_root(i->>'mirror_source') as source
   from jsonb_array_elements(items) i where i ? 'mirror_source'
  ) incoming where url is not null group by url
 ), cleared as (
  delete from public.repository_mirrors m using evidence e
  where m.url = e.url and e.source is null
 )
 insert into public.repository_mirrors as m (url, source)
 select url, source from evidence where source is not null
 on conflict (url) do update set source = excluded.source
 where m.source is distinct from excluded.source;
end;
$$;
revoke all on function public.store_repository_mirrors(text, jsonb) from public, authenticated, service_role;
grant execute on function public.store_repository_mirrors(text, jsonb) to anon;

create function public.queue_octowow_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer;
begin
 added := public.queue_octowow_candidates(token, items);
 perform public.store_repository_mirrors(token, items);
 return added;
end;
$$;
revoke all on function public.queue_octowow_imports(text, jsonb) from public, authenticated, service_role;
grant execute on function public.queue_octowow_imports(text, jsonb) to anon;

create view public.pending_imports with (security_invoker = true) as
select q.id, q.key, q.url, q.name, q.description, q.images, q.alts, q.category,
 q.obsolete, q.parent, q.group_key, q.status, q.problem, q.readme_checked_at,
 q.rejected_by_owner, q.wiki_source, q.wiki_recommended, q.source, q.entry_type
from public.import_queue q
left join public.repository_mirrors m on m.url = public.mirror_repository_root(q.url)
where q.status = 'pending'
 and (
  m.source is null
  or not exists (
   select 1 from public.addons a
   cross join lateral jsonb_array_elements(a.versions) v
   where a.link_keys @> array[public.link_key(m.source)]
    and public.mirror_repository_root(v->>'url') = m.source
    and not exists (
     select 1 from public.repo_stats r where r.key = public.link_key(m.source) and r.missing
    )
  )
 );
revoke all on public.pending_imports from public, anon, authenticated, service_role;
grant select on public.pending_imports to authenticated;

-- Retire a reviewed version only when its exact source remains on the same page.
create function public.retire_repository_mirror(target bigint, mirror_url text, source_url text) returns void
language plpgsql security definer set search_path = '' as $$
declare
 a public.addons;
 kept jsonb;
 mirror_key text := public.mirror_repository_root(mirror_url);
 source_key text := public.mirror_repository_root(source_url);
 retained_url text;
begin
 if not public.is_admin() then raise exception 'Only admins can retire mirror links.'; end if;
 select * into a from public.addons where id = target for update;
 if a.id is null then raise exception 'That addon is no longer published.'; end if;
 perform 1 from public.repository_mirrors m where m.url = mirror_key and m.source = source_key for share;
 if not found then raise exception 'The mirror and source relationship could not be confirmed.'; end if;
 if exists (select 1 from public.repository_mirrors m where m.url = source_key)
  or exists (select 1 from public.repo_stats r where r.key = public.link_key(source_key) and r.missing) then
  raise exception 'The source needs review before retiring the mirror.';
 end if;
 select v->>'url' into retained_url from jsonb_array_elements(a.versions) v
 where public.mirror_repository_root(v->>'url') = source_key;
 if retained_url is null then raise exception 'The exact source must be published on this addon page.'; end if;
 if not exists (select 1 from jsonb_array_elements(a.versions) v where v->>'url' = mirror_url) then
  raise exception 'That mirror link is no longer listed on this addon page.';
 end if;
 select jsonb_agg(value order by n) into kept
 from jsonb_array_elements(a.versions) with ordinality x(value, n)
 where value->>'url' <> mirror_url;

 perform set_config('app.doing', 'remove_link', true);
 update public.addons set versions = kept,
  pinned_link = case when pinned_link = mirror_url then retained_url else pinned_link end
 where id = target;
 perform set_config('app.doing', '', true);

 -- Keep the mirror reviewable if this source is ever removed from the index.
 insert into public.import_queue as q (key, url, name, description, category, images, source, entry_type)
 values (public.link_key(mirror_url), mirror_url, a.name, a.description, a.category, a.images,
  case when mirror_key like 'https://octowow.st/%' then 'OctoWoW' else a.source end, a.entry_type)
 on conflict (key) do update set status = 'pending', decided_at = null, decided_by = null, addon_id = null, problem = null
 where q.status = 'approved' and q.addon_id = target and public.mirror_repository_root(q.url) = mirror_key;
end;
$$;
revoke all on function public.retire_repository_mirror(bigint, text, text) from public, anon, service_role;
grant execute on function public.retire_repository_mirror(bigint, text, text) to authenticated;

create or replace function public.nightly_waiting(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can ask what is waiting.'; end if;
 return jsonb_build_object(
  'reports',(select count(*) from public.reports where status='open'),
  'suggestions',(select count(*) from public.group_suggestions where status='pending' and kind='user')
   +(select count(*) from public.addon_edit_requests where status='pending'),
  'imports',(select count(*) from public.pending_imports)
 );
end;
$$;

notify pgrst, 'reload schema';
