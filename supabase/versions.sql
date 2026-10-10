-- Run once in the Supabase SQL editor, after schema.sql and org-admins.sql. Safe to run again.
--
-- One addon can list several versions (forks) of itself, in an order its owner or an
-- admin chooses. The first one is the main link. No link can be listed under two addons.

-- Canonical form of a link, so different spellings of one repository compare equal.
-- src/lib/links.ts has the same rules for the browser; keep the two in step.
create or replace function public.link_key(url text) returns text
language sql immutable set search_path = '' as $$
	select case
		when u ~ '^github\.com/[^/?#]+/[^/?#]+' then
			regexp_replace(substring(u from '^github\.com/[^/?#]+/[^/?#]+'), '\.git$', '')
		else
			regexp_replace(
				regexp_replace(regexp_replace(regexp_replace(u, '[?#].*$', ''), '/-/.*$', ''), '/+$', ''),
				'\.git$', ''
			)
	end
	from (select regexp_replace(lower(btrim(url)), '^https?://(www\.)?', '') as u) cleaned;
$$;

-- versions: [{ "url": "https://…", "note": "…", "added_by": "username" }, …]
alter table public.addons add column if not exists versions jsonb;
update public.addons
	set versions = jsonb_build_array(jsonb_build_object('url', repo_url, 'note', ''))
	where versions is null;
alter table public.addons alter column versions set not null;

-- repo_url stays readable as the main link, but is now derived from the first version.
alter table public.addons drop constraint if exists addons_repo_url_check;
alter table public.addons drop column if exists repo_url;
alter table public.addons add column repo_url text generated always as (versions -> 0 ->> 'url') stored;

-- Keys of every listed version, kept by the trigger below.
alter table public.addons add column if not exists link_keys text[] not null default '{}';
-- Addresses of addons merged into this one, so their old links keep working.
alter table public.addons add column if not exists aliases text[] not null default '{}';
create index if not exists addons_link_keys_idx on public.addons using gin (link_keys);

create or replace function public.addons_links() returns trigger
language plpgsql set search_path = '' as $$
declare
	item jsonb;
	clash text;
begin
	if jsonb_typeof(new.versions) is distinct from 'array'
		or jsonb_array_length(new.versions) not between 1 and 10 then
		raise exception 'An addon needs between 1 and 10 links.';
	end if;

	for item in select * from jsonb_array_elements(new.versions) loop
		if coalesce(item ->> 'url', '') !~ '^https://\S+$' then
			raise exception 'Every link must start with https://';
		end if;
		if char_length(coalesce(item ->> 'note', '')) > 80 then
			raise exception 'A version note can be at most 80 characters.';
		end if;
	end loop;

	select array_agg(distinct public.link_key(v ->> 'url')) into new.link_keys
	from jsonb_array_elements(new.versions) v;
	if cardinality(new.link_keys) <> jsonb_array_length(new.versions) then
		raise exception 'The same link is listed twice.';
	end if;

	select a.name into clash
	from public.addons a
	where a.id is distinct from new.id and a.link_keys && new.link_keys
	limit 1;
	if clash is not null then
		raise exception 'This link is already listed under "%".', clash;
	end if;

	return new;
end;
$$;

drop trigger if exists addons_links on public.addons;
create trigger addons_links
	before insert or update on public.addons
	for each row execute function public.addons_links();

-- Existing rows get their keys.
update public.addons set versions = versions;

-- Moves every version of one addon under another and removes the first. Admins only.
create or replace function public.merge_addons(source_id bigint, target_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	merged public.addons;
	poster text;
	moved jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can merge addons.';
	end if;
	if source_id = target_id then
		raise exception 'Pick a different addon to merge into.';
	end if;

	-- Removed first, so its links are free to be listed under the target.
	delete from public.addons where id = source_id returning * into merged;
	if merged.id is null then
		raise exception 'The addon to merge no longer exists.';
	end if;

	select username into poster from public.profiles where id = merged.owner;
	select jsonb_agg(v || jsonb_build_object('added_by', coalesce(v ->> 'added_by', poster, '')))
	into moved
	from jsonb_array_elements(merged.versions) v;

	update public.addons t
	set versions = t.versions || moved,
		aliases = t.aliases || merged.slug || merged.aliases
	where t.id = target_id;
	if not found then
		raise exception 'The addon to merge into no longer exists.';
	end if;
end;
$$;

grant insert (versions) on public.addons to authenticated;
grant update (versions) on public.addons to authenticated;
grant execute on function public.link_key(text) to anon, authenticated;
revoke all on function public.merge_addons(bigint, bigint) from public, anon;
grant execute on function public.merge_addons(bigint, bigint) to authenticated;
