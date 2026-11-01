-- Only the owner may submit an export. Admins review its ordinary queue entries.
create function public.queue_discord_imports(items jsonb) returns jsonb
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
 return jsonb_build_object('added',added,'skipped',total-added);
end;
$$;
revoke all on function public.queue_discord_imports(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.queue_discord_imports(jsonb) to authenticated;
