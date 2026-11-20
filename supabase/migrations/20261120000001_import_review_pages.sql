-- Classify before paging so filters and counts cover the whole queue. A new
-- page needs a manually chosen category, even when the source guessed one.
create view public.import_waiting_reviews with (security_invoker = true) as
select q.id,q.key,q.url,q.name,q.description,q.images,q.alts,q.category,
 q.obsolete,q.parent,q.group_key,q.status,q.problem,q.readme_checked_at,
 q.rejected_by_owner,q.wiki_source,q.wiki_recommended,q.source,q.entry_type,
 lower(q.name) as sort_name,
 lower(concat_ws(' ', q.name, q.description, q.url, q.category)) as search_document,
 (select count(*) from public.import_queue siblings where siblings.status = 'pending'
  and public.addon_name_key(siblings.name) = public.addon_name_key(q.name)) as same_name_count,
 m.source as mirror_source,
 case
  when coalesce(facts.missing, false) then 'dead'
  when btrim(q.url) ~* '^https?://(www\.)?turtle-wow\.fandom\.com(:[0-9]+)?/'
   and btrim(q.url) ~ '^[^:]+://[^/]+/wiki/' then 'wiki'
  when exists (select 1 from public.addons a where public.addon_name_key(a.name) = public.addon_name_key(q.name))
   or (facts.fork_of is not null and (
    select count(*) from (
     select 1 from public.addons a
     where a.link_keys @> array[public.link_key(facts.fork_of)]
     limit 2
    ) matches
   ) = 1)
  then case
   when facts.canonical <> q.key and exists (select 1 from public.addons a where a.link_keys @> array[facts.canonical])
   then 'duplicate' else 'fine' end
  else 'incomplete'
 end as review_bucket,
 case when facts.key is not null then jsonb_build_object(
  'key', facts.key, 'stars', facts.stars, 'pushed_at', facts.pushed_at,
  'archived', facts.archived, 'fork_of', facts.fork_of, 'missing', facts.missing,
  'interface', facts.interface, 'canonical', facts.canonical
 ) end as review_stats,
 coalesce(facts.missing, false) as repository_missing
from public.import_queue q
left join public.repo_stats facts on facts.key = q.key
left join public.addon_mirror_decisions d on d.url = public.mirror_repository_root(q.url)
left join public.repository_mirrors m on m.url = public.mirror_repository_root(q.url) and d.url is null
where q.status = 'pending';

create or replace view public.pending_imports with (security_invoker = true) as
select q.id,q.key,q.url,q.name,q.description,q.images,q.alts,q.category,
 q.obsolete,q.parent,q.group_key,q.status,q.problem,q.readme_checked_at,
 q.rejected_by_owner,q.wiki_source,q.wiki_recommended,q.source,q.entry_type,
 q.mirror_source,destination.id as mirror_addon_id,
 coalesce(unavailable.missing,false) as mirror_source_unavailable,
 q.sort_name,q.search_document,q.same_name_count,q.review_bucket,q.review_stats,q.repository_missing
from public.import_waiting_reviews q
left join public.repo_stats unavailable on unavailable.key = public.link_key(q.mirror_source)
left join lateral (
 select a.id from public.addons a
 where a.entry_type = q.entry_type and not coalesce(unavailable.missing,false)
  and a.link_keys @> array[public.link_key(q.mirror_source)]
  and exists (select 1 from jsonb_array_elements(a.versions) v where public.mirror_repository_root(v->>'url') = q.mirror_source)
 order by a.id limit 1
) destination on true;

-- Confirmed missing repositories can appear here before the nightly job files
-- them. Each entry appears once, regardless of which path brought it here.
create view public.decided_imports with (security_invoker = true) as
select q.id,q.key,q.url,q.name,q.description,q.images,q.alts,q.category,
 q.obsolete,q.parent,q.group_key,q.status,q.problem,q.readme_checked_at,
 q.rejected_by_owner,q.wiki_source,q.wiki_recommended,q.source,q.entry_type,
 lower(q.name) as sort_name,
 lower(concat_ws(' ',q.name,q.description,q.url,q.category)) as search_document,
 case when q.status = 'rejected' then 'rejected' else 'dead' end as review_bucket
from public.import_queue q
where q.status in ('rejected','dead')
 or (q.status = 'pending' and exists (select 1 from public.repo_stats r where r.key = q.key and r.missing));

create index import_queue_page_idx on public.import_queue (status, lower(name), id);
create index import_queue_pending_name_idx on public.import_queue (public.addon_name_key(name)) where status = 'pending';
revoke all on public.import_waiting_reviews, public.decided_imports from public, anon, authenticated, service_role;
grant select on public.import_waiting_reviews, public.decided_imports to authenticated;

create function public.import_review_counts() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can review imports.' using errcode = '42501'; end if;
 return (
  with waiting as (
   select count(*) as pending,
    count(*) filter (where review_bucket = 'fine') as fine,
    count(*) filter (where review_bucket = 'duplicate') as duplicate,
    count(*) filter (where review_bucket = 'incomplete') as incomplete,
    count(*) filter (where review_bucket = 'wiki') as wiki,
    count(*) filter (where review_bucket = 'dead') as missing,
    count(*) filter (where review_bucket <> 'dead' and mirror_source is not null) as mirrors,
    count(*) filter (where source = 'Discord') as discord
   from public.import_waiting_reviews
  ), decided as (
   select count(*) filter (where status = 'approved' and not wiki_expanded) as approved,
    count(*) filter (where status = 'submitted') as submitted,
    count(*) filter (where status = 'rejected') as rejected,
    count(*) filter (where status = 'dead') as dead
   from public.import_queue where status <> 'pending'
  )
  select to_jsonb(w) - 'missing' || (to_jsonb(d) - 'dead') ||
   jsonb_build_object('dead', w.missing + d.dead, 'waiting', w.pending - w.missing)
  from waiting w cross join decided d
 );
end;
$$;
revoke all on function public.import_review_counts() from public, anon, authenticated, service_role;
grant execute on function public.import_review_counts() to authenticated;
