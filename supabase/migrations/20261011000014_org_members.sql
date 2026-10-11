-- The list of organization members now comes from the nightly job instead of being
-- fetched by the database when someone logs in. That fetch went out unsigned from
-- addresses shared with other Supabase projects, so GitHub could refuse it; it held a row
-- lock while it waited; and two hours of refusals took every organization admin's rights
-- away. The database no longer calls anything outside itself.
--
-- The price is that joining or leaving the organization takes effect at the next nightly
-- run, or when that workflow is started by hand. The owner can suspend an admin at once.

-- Stores the organization's public members. Returns how many there are.
create or replace function public.store_org_members(token text, ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store the organization''s members.';
	end if;
	-- An empty list means the organization has no public members; no list is a mistake.
	if ids is null then
		raise exception 'The list of members is missing.';
	end if;
	update public.org_cache set member_ids = ids, fetched_at = now(), checked_at = now() where id;
	return cardinality(ids);
end;
$$;

revoke all on function public.store_org_members(text, bigint[]) from public, authenticated, service_role;
grant execute on function public.store_org_members(text, bigint[]) to anon;

-- Replaces the version in the moderation migration: the list counts for three days, not
-- two hours, so a night or two without a run changes nothing. After that it stops
-- granting access, so a job that has stopped for good fails towards fewer admins. The
-- owner and hand-ticked admins do not depend on it.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.profiles p
		where p.id = auth.uid()
			and not p.banned
			and (
				p.is_owner
				or p.is_admin
				or exists (
					select 1
					from public.org_cache c
					join auth.identities i on i.user_id = auth.uid() and i.provider = 'github'
					where c.fetched_at > now() - interval '3 days'
						and i.provider_id::bigint = any (c.member_ids)
				)
			)
	);
$$;

-- Replaces the version in the moderation migration: it only answers now.
create or replace function public.my_role() returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('admin', public.is_admin(), 'owner', public.is_owner(), 'banned', public.is_banned());
$$;

drop function if exists public.refresh_admin();
-- Only refresh_admin used it.
drop extension if exists http;
