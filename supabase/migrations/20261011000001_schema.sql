-- What a new table, function or sequence may be used for by the API's roles before anything
-- is granted. A hosted Supabase project starts out this strict; the copy of the backend
-- that runs on a developer's computer starts out giving these roles everything. Setting it
-- here makes both the same, so a missing grant shows up in the tests and not on the site.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
	grant maintain, references, trigger, truncate on tables to anon, authenticated, service_role;

-- Profiles: one row per account, created automatically on sign-up.
create table public.profiles (
	id uuid primary key references auth.users on delete cascade,
	username text not null unique check (username ~ '^[A-Za-z0-9_-]{3,24}$'),
	is_admin boolean not null default false,
	created_at timestamptz not null default now()
);

create table public.addons (
	id bigint generated always as identity primary key,
	-- Made from the name by a trigger in the slugs migration; whatever the client sends is replaced.
	slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	name text not null check (char_length(name) between 2 and 60),
	-- The 15 character minimum for non-admins is enforced by a trigger in the import migration.
	description text not null default '' check (char_length(description) <= 5000),
	category text not null check (category <> ''),
	author text not null default '' check (char_length(author) <= 60),
	repo_url text not null check (repo_url ~ '^https://'),
	-- Screenshot links. Every entry must be an https URL.
	images text[] not null default '{}' constraint addons_images_check
		check (cardinality(images) <= 5 and array_to_string(images, ' ') ~ '^(https://\S+( |$))*$'),
	owner uuid not null default auth.uid() references public.profiles on delete cascade,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index addons_owner_idx on public.addons (owner);

-- Sign-up creates the profile. A taken or invalid username gets a random suffix instead of failing.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	wanted text := coalesce(
		new.raw_user_meta_data ->> 'username',
		new.raw_user_meta_data ->> 'user_name',
		-- Discord reports the name as "name#0".
		regexp_replace(new.raw_user_meta_data ->> 'name', '#\d+$', ''),
		''
	);
begin
	wanted := left(regexp_replace(wanted, '[^A-Za-z0-9_-]', '', 'g'), 24);
	if char_length(wanted) < 3 or exists (select 1 from public.profiles where lower(username) = lower(wanted)) then
		wanted := left(coalesce(nullif(wanted, ''), 'user'), 17) || '-' || substr(md5(new.id::text), 1, 6);
	end if;
	insert into public.profiles (id, username) values (new.id, wanted);
	return new;
end;
$$;

create trigger on_auth_user_created
	after insert on auth.users
	for each row execute function public.handle_new_user();

-- Ownership and timestamps cannot be changed by the client.
create function public.addons_before_update() returns trigger
language plpgsql as $$
begin
	new.owner := old.owner;
	new.created_at := old.created_at;
	new.updated_at := now();
	return new;
end;
$$;

create trigger addons_before_update
	before update on public.addons
	for each row execute function public.addons_before_update();

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.profiles where id = auth.uid() and is_admin);
$$;

alter table public.profiles enable row level security;
alter table public.addons enable row level security;

-- Usernames are not public: an account sees its own, and admins see everyone's.
create policy "own profile, and admins read all" on public.profiles for select
	using (id = auth.uid() or public.is_admin());

create policy "addons are public" on public.addons for select using (true);
create policy "signed-in users can post" on public.addons for insert to authenticated
	with check (owner = auth.uid());
create policy "owners and admins can edit" on public.addons for update to authenticated
	using (owner = auth.uid() or public.is_admin());
create policy "owners and admins can delete" on public.addons for delete to authenticated
	using (owner = auth.uid() or public.is_admin());

-- Clients may read everything but only write addon content; profiles are written by the trigger only.
revoke all on public.profiles, public.addons from anon, authenticated;
grant select on public.profiles, public.addons to anon, authenticated;
grant insert (slug, name, description, category, author, repo_url, images)
	on public.addons to authenticated;
grant update (name, description, category, author, repo_url, images)
	on public.addons to authenticated;
grant delete on public.addons to authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- To make yourself an admin after your first login, run:
--   update public.profiles set is_admin = true where username = 'your-username';
