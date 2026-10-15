-- Public dates for each exact link, derived from the private nightly cache.
alter table public.addons add column link_code_updates jsonb not null default '{}';
grant select (link_code_updates) on public.addons to anon;

create or replace function public.addons_code_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if not exists(select 1 from jsonb_array_elements(new.versions) v where v ->> 'url' = new.pinned_link) then new.pinned_link := null; end if;
 select coalesce(jsonb_agg(v order by (v ->> 'url' = new.pinned_link) desc nulls last, r.committed_at desc nulls last, position), '[]'::jsonb)
 into new.versions from jsonb_array_elements(new.versions) with ordinality each(v, position)
 left join public.repo_code_updates r on r.url = v ->> 'url';
 select jsonb_build_object('date', r.committed_at, 'url', r.history_url) into new.code_update
 from public.repo_code_updates r where r.url = new.versions -> 0 ->> 'url';
 select coalesce(jsonb_object_agg(r.url, jsonb_build_object('date', r.committed_at, 'url', r.history_url)), '{}'::jsonb)
 into new.link_code_updates from public.repo_code_updates r
 where exists(select 1 from jsonb_array_elements(new.versions) v where v ->> 'url' = r.url);
 return new;
end;
$$;


select set_config('app.doing', 'code_refresh', true);
update public.addons set versions = versions;
select set_config('app.doing', '', true);
