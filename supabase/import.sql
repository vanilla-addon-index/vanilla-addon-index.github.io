-- Run once in the Supabase SQL editor, after versions.sql. Safe to run again.
--
-- The import queue: addons read from the Turtle WoW wiki wait here until an admin
-- approves, rejects or merges them. A link that is live or was ever queued is never
-- queued again.

-- Where an entry came from, shown as a credit on its page. Set by the functions below only.
alter table public.addons add column if not exists source text not null default '';

create table if not exists public.import_queue (
	id bigint generated always as identity primary key,
	-- public.link_key(url). Unique, so every link is reviewed at most once.
	key text not null unique,
	url text not null,
	name text not null,
	description text not null default '',
	images text[] not null default '{}',
	-- Other versions (forks) the wiki lists for the same addon.
	alts text[] not null default '{}',
	category text not null default 'Miscellaneous',
	obsolete boolean not null default false,
	-- Name of the addon this one extends, for nested wiki entries.
	parent text,
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	decided_by uuid references public.profiles on delete set null,
	decided_at timestamptz,
	-- The live addon an approved entry became, or was added to as a version.
	addon_id bigint references public.addons on delete set null,
	-- Why the last approval attempt failed, if it did.
	problem text,
	created_at timestamptz not null default now()
);
create index if not exists import_queue_status_idx on public.import_queue (status);

-- What GitHub says about a repository, refreshed by the nightly job.
create table if not exists public.repo_stats (
	key text primary key,
	stars integer not null default 0,
	pushed_at timestamptz,
	archived boolean not null default false,
	-- Key of the repository this one was forked from.
	fork_of text,
	-- The repository no longer exists.
	missing boolean not null default false,
	checked_at timestamptz not null default now()
);
-- The number in the addon's .toc file; 11200 means 1.12.
alter table public.repo_stats add column if not exists interface integer;
-- The repository's current key, which differs from "key" after a rename or transfer.
alter table public.repo_stats add column if not exists canonical text;

alter table public.import_queue enable row level security;
alter table public.repo_stats enable row level security;

drop policy if exists "admins read the import queue" on public.import_queue;
create policy "admins read the import queue" on public.import_queue for select to authenticated
	using (public.is_admin());
drop policy if exists "repo stats are public" on public.repo_stats;
create policy "repo stats are public" on public.repo_stats for select using (true);

-- The queue is changed through the functions below only.
revoke all on public.import_queue, public.repo_stats from anon, authenticated;
grant select on public.import_queue to authenticated;
grant select on public.repo_stats to anon, authenticated;
-- The nightly job signs in with the project's secret key, which still needs table rights.
grant select on public.addons, public.import_queue to service_role;
grant select, insert, update on public.repo_stats to service_role;

-- A description needs 15 characters, except when an admin writes it: a terse line from
-- the wiki is still better than none.
alter table public.addons drop constraint if exists addons_description_required;
alter table public.addons alter column description set default '';

create or replace function public.addons_description() returns trigger
language plpgsql set search_path = '' as $$
begin
	if (tg_op = 'INSERT' or new.description is distinct from old.description)
		and char_length(btrim(new.description)) < 15
		and not public.is_admin() then
		raise exception 'The description needs at least 15 characters.';
	end if;
	return new;
end;
$$;

drop trigger if exists addons_description on public.addons;
create trigger addons_description
	before insert or update on public.addons
	for each row execute function public.addons_description();

-- Admins, and the nightly job with the project's secret key.
create or replace function public.may_import() returns boolean
language sql stable security definer set search_path = '' as $$
	select public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

-- Adds candidates whose link is neither live nor already in the queue. Returns how many.
create or replace function public.queue_imports(items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	added integer;
begin
	if not public.may_import() then
		raise exception 'Only admins can import addons.';
	end if;

	insert into public.import_queue (key, url, name, description, images, alts, category, obsolete, parent)
	select
		public.link_key(i ->> 'url'),
		i ->> 'url',
		left(btrim(i ->> 'name'), 120),
		coalesce(i ->> 'description', ''),
		array(select jsonb_array_elements_text(coalesce(i -> 'images', '[]'))),
		array(select jsonb_array_elements_text(coalesce(i -> 'alts', '[]'))),
		coalesce(i ->> 'category', 'Miscellaneous'),
		coalesce((i ->> 'obsolete')::boolean, false),
		i ->> 'parent'
	from jsonb_array_elements(items) i
	where (i ->> 'url') ~ '^https://\S+$'
		and btrim(coalesce(i ->> 'name', '')) <> ''
		and not exists (
			select 1 from public.addons a where a.link_keys @> array[public.link_key(i ->> 'url')]
		)
		-- A renamed repository is the same addon under either address.
		and not exists (
			select 1
			from public.repo_stats s
			join public.addons a on a.link_keys @> array[s.key] or a.link_keys @> array[s.canonical]
			where public.link_key(i ->> 'url') in (s.key, s.canonical)
		)
	on conflict (key) do nothing;

	get diagnostics added = row_count;
	return added;
end;
$$;

-- Publishes queued entries as they are. Returns how many were published; an entry that
-- cannot be published stays pending with the reason in its "problem" column.
create or replace function public.approve_imports(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
	base text;
	new_slug text;
	n integer;
	links jsonb;
	keys text[];
	alt text;
	made bigint;
	published integer := 0;
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;

	for q in select * from public.import_queue where id = any (ids) and status = 'pending' order by id loop
		begin
			base := btrim(regexp_replace(lower(q.name), '[^a-z0-9]+', '-', 'g'), '-');
			if base = '' then
				base := 'addon';
			end if;
			new_slug := base;
			n := 1;
			while exists (select 1 from public.addons a where a.slug = new_slug) loop
				n := n + 1;
				new_slug := base || '-' || n;
			end loop;

			-- The wiki's other versions come along, unless they are listed elsewhere already.
			links := jsonb_build_array(jsonb_build_object('url', q.url, 'note', ''));
			keys := array[q.key];
			foreach alt in array q.alts loop
				if jsonb_array_length(links) < 10
					and alt ~ '^https://\S+$'
					and not public.link_key(alt) = any (keys)
					and not exists (select 1 from public.addons a where a.link_keys @> array[public.link_key(alt)]) then
					links := links || jsonb_build_object('url', alt, 'note', '');
					keys := keys || public.link_key(alt);
				end if;
			end loop;

			insert into public.addons (slug, name, description, category, author, versions, images, source)
			values (
				new_slug,
				left(q.name, 60),
				btrim(q.description),
				q.category,
				case when q.key like 'github.com/%' then split_part(q.url, '/', 4) else '' end,
				links,
				q.images[1:5],
				'Turtle WoW Wiki'
			)
			returning id into made;

			update public.import_queue
			set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = made, problem = null
			where id = q.id;
			published := published + 1;
		exception when others then
			update public.import_queue set problem = sqlerrm where id = q.id;
		end;
	end loop;

	return published;
end;
$$;

-- Records that a queued entry was handled by hand: published through the form (credit the
-- wiki) or added to an existing addon as a version (no credit).
create or replace function public.mark_imported(queue_id bigint, target bigint, credit boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;
	update public.import_queue
	set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null
	where id = queue_id;
	if credit then
		update public.addons set source = 'Turtle WoW Wiki' where id = target;
	end if;
end;
$$;

-- Rejects pending entries, or puts rejected ones back in the queue.
create or replace function public.decide_imports(ids bigint[], decision text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	changed integer;
begin
	if not public.is_admin() then
		raise exception 'Only admins can review imports.';
	end if;
	if decision not in ('rejected', 'pending') then
		raise exception 'Unknown decision.';
	end if;
	update public.import_queue
	set status = decision,
		decided_by = case when decision = 'rejected' then auth.uid() end,
		decided_at = case when decision = 'rejected' then now() end
	where id = any (ids) and status in ('pending', 'rejected');
	get diagnostics changed = row_count;
	return changed;
end;
$$;

revoke all on function public.queue_imports(jsonb) from public, anon;
revoke all on function public.approve_imports(bigint[]) from public, anon;
revoke all on function public.mark_imported(bigint, bigint, boolean) from public, anon;
revoke all on function public.decide_imports(bigint[], text) from public, anon;
grant execute on function public.may_import() to anon, authenticated, service_role;
grant execute on function public.queue_imports(jsonb) to authenticated, service_role;
grant execute on function public.approve_imports(bigint[]) to authenticated;
grant execute on function public.mark_imported(bigint, bigint, boolean) to authenticated;
grant execute on function public.decide_imports(bigint[], text) to authenticated;
