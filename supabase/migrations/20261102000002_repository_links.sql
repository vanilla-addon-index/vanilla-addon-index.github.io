-- Known Git release and archive routes become repository links. Source paths stay intact.
create function public.repository_link(value text) returns text
language sql immutable strict set search_path = '' as $$
 select case when cleaned <> btrim(value) then regexp_replace(cleaned, '(?i)\.git$', '') else cleaned end from (select coalesce(
  substring(btrim(value) from '(?i)^(https://(?:www\.)?(?:github\.com|codeberg\.org|gitea\.com)/[^/?#]+/[^/?#]+)/(?:releases|archive)(?:[/?#]|$)'),
  substring(btrim(value) from '(?i)^(https://(?:www\.)?octowow\.st/git/[^/?#]+/[^/?#]+)/(?:releases|archive)(?:[/?#]|$)'),
  substring(btrim(value) from '(?i)^(https://(?:www\.)?gitlab\.com/(?:[^/?#]+/)+[^/?#]+)/-/(?:releases|archive)(?:[/?#]|$)'),
  btrim(value)) as cleaned) normalized;
$$;

create or replace function public.link_key(url text) returns text
language sql immutable set search_path = '' as $$
	select case
		when u ~ '^github\.com/[^/]+/[^/]+' then
			regexp_replace(substring(u from '^github\.com/[^/]+/[^/]+'), '\.git$', '')
				|| coalesce('/' || substring(u from '^github\.com/[^/]+/[^/]+/(?:tree|blob)/[^/]+/(.*[^/])/*$'), '')
		else
			regexp_replace(regexp_replace(regexp_replace(u, '/-/.*$', ''), '/+$', ''), '\.git$', '')
	end
	from (
		select regexp_replace(regexp_replace(lower(btrim(public.repository_link(url))), '^https?://(www\.)?', ''), '[?#].*$', '') as u
	) cleaned;
$$;


create function public.normalize_addon_repository_links() returns trigger
language plpgsql set search_path = '' as $$
begin
 select coalesce(jsonb_agg(v || jsonb_build_object('url', public.repository_link(v->>'url')) order by ord), '[]'::jsonb)
 into new.versions from jsonb_array_elements(new.versions) with ordinality entries(v, ord);
 if new.pinned_link is not null then new.pinned_link := public.repository_link(new.pinned_link); end if;
 return new;
end;
$$;
create trigger addons_aaa_repository_links before insert or update on public.addons
for each row execute function public.normalize_addon_repository_links();

-- Refuse ambiguous historical collisions rather than silently merge addons or versions.
do $$
begin
 if exists (
  select public.link_key(v->>'url') from public.addons a,
   lateral jsonb_array_elements(a.versions) v
  group by public.link_key(v->>'url') having count(*) > 1
 ) then
  raise exception 'Repository URL cleanup found multiple listed links for one repository. Resolve those links before applying this migration.';
 end if;
end;
$$;

-- Mechanical cleanup: retain timestamps, history, ownership and review decisions.
alter table public.addons disable trigger user;
update public.addons a set versions = (
 select jsonb_agg(v || jsonb_build_object('url', public.repository_link(v->>'url')) order by ord)
 from jsonb_array_elements(a.versions) with ordinality entries(v, ord)
), pinned_link = public.repository_link(pinned_link)
where exists(select 1 from jsonb_array_elements(a.versions) v where v->>'url' <> public.repository_link(v->>'url'));
update public.addons a set link_keys = coalesce((select array_agg(distinct public.link_key(v->>'url')) from jsonb_array_elements(a.versions) v), '{}');
alter table public.addons enable trigger user;

-- Preserve all queue decisions, including older entries sharing a normalized identity.
-- Only move a legacy key when it is free; the canonical row blocks repeat imports.
update public.import_queue set url = public.repository_link(url);
update public.import_queue q set key = public.link_key(q.url)
where key <> public.link_key(url)
 and not exists(select 1 from public.import_queue other where other.id <> q.id and other.key = public.link_key(q.url))
 and q.id = (select min(other.id) from public.import_queue other where public.link_key(other.url) = public.link_key(q.url));

create function public.normalize_import_repository_link() returns trigger
language plpgsql set search_path = '' as $$
begin
 new.url := public.repository_link(new.url);
 new.key := public.link_key(new.url);
 return new;
end;
$$;
create trigger normalize_import_repository_link before insert on public.import_queue
for each row execute function public.normalize_import_repository_link();
