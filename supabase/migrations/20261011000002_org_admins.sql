-- Public members of the GitHub organization become admins automatically when they
-- log in with GitHub. The member list is fetched from GitHub at most every 10 minutes
-- and stops granting access when it is more than 2 hours old, so leaving the
-- organization removes the access.

create extension if not exists http with schema extensions;

-- Single-row cache of the organization's public member ids. Not readable by clients.
create table if not exists public.org_cache (
	id boolean primary key default true check (id),
	member_ids bigint[] not null default '{}',
	-- Last successful fetch, and last attempt.
	fetched_at timestamptz not null default 'epoch',
	checked_at timestamptz not null default 'epoch'
);
insert into public.org_cache default values on conflict do nothing;
alter table public.org_cache enable row level security;
revoke all on public.org_cache from anon, authenticated;

-- The GitHub id comes from auth.identities, which is written by Supabase at login
-- and cannot be edited by the user.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.profiles where id = auth.uid() and is_admin)
		or exists (
			select 1
			from public.org_cache c
			join auth.identities i on i.user_id = auth.uid() and i.provider = 'github'
			where c.fetched_at > now() - interval '2 hours'
				and i.provider_id::bigint = any (c.member_ids)
		);
$$;

-- Called by the site after login. Refreshes the member list if it is stale.
create or replace function public.refresh_admin() returns boolean
language plpgsql security definer set search_path = '' as $$
declare
	stale boolean;
	fresh bigint[];
	res extensions.http_response;
begin
	if auth.uid() is null then
		return false;
	end if;

	select checked_at < now() - interval '10 minutes' into stale from public.org_cache where id for update;
	if stale then
		begin
			select * into res from extensions.http((
				'GET',
				'https://api.github.com/orgs/vanilla-addon-index/public_members?per_page=100',
				array[extensions.http_header('User-Agent', 'vanilla-addon-index')],
				null,
				null
			)::extensions.http_request);
			if res.status = 200 then
				select coalesce(array_agg((m ->> 'id')::bigint), '{}') into fresh
				from jsonb_array_elements(res.content::jsonb) m;
			end if;
		exception when others then
			-- GitHub unreachable: keep the previous list, which expires on its own.
			null;
		end;
		-- A failed attempt still counts, so GitHub is never asked more than every 10 minutes.
		update public.org_cache
		set member_ids = coalesce(fresh, member_ids),
			fetched_at = case when fresh is null then fetched_at else now() end,
			checked_at = now()
		where id;
	end if;

	return public.is_admin();
end;
$$;

revoke all on function public.refresh_admin() from public, anon;
grant execute on function public.refresh_admin() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
