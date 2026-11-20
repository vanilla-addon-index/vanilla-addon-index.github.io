-- The same active mirror links used on addon pages, available in bulk for the snapshot.
create view public.published_addon_mirrors with (security_barrier = true) as
select d.addon_id, d.url,
 (select v->>'url' from jsonb_array_elements(a.versions) v
  where public.mirror_repository_root(v->>'url') = d.source limit 1) as source
from public.addon_mirror_decisions d join public.addons a on a.id = d.addon_id
where d.decision = 'mirror';

revoke all on public.published_addon_mirrors from public, anon, authenticated, service_role;
grant select on public.published_addon_mirrors to anon, authenticated;

create or replace function public.addon_mirrors(target bigint) returns table(url text, source text)
language sql stable security definer set search_path = '' as $$
 select m.url, m.source from public.published_addon_mirrors m where m.addon_id = target;
$$;

notify pgrst, 'reload schema';
