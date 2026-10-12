-- Admins are appointed by the owner, on the site. They used to be the public members of
-- the GitHub organization, which the nightly job read and stored. That made every admin
-- public on GitHub, left it to each member whether they were one (by showing or hiding
-- their membership), shut out anyone who logs in with Discord, took effect a night late,
-- took every admin's rights away when the job stopped for three days, and meant that
-- whoever held the job's token could make an admin of anyone.
--
-- Now an account is an admin when the owner says so, at once, and nothing outside the
-- database has a say. The nightly job's token is good for the import queue, the facts
-- about repositories and the tidying up, and nothing else.

-- Whoever is an admin through the organization at this moment stays one.
update public.profiles p
set is_admin = true
from auth.identities i, public.org_cache c
where i.user_id = p.id and i.provider = 'github' and i.provider_id::bigint = any (c.member_ids)
	and not p.is_admin and not p.is_owner;

-- Replaces the version in the delete account migration.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.profiles p
		where p.id = auth.uid() and not public.is_banned() and (p.is_owner or p.is_admin)
	);
$$;

-- Replaces the version in the moderation migration. Admin or owner, whether or not suspended.
create or replace function public.is_staff(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.profiles p where p.id = uid and (p.is_owner or p.is_admin));
$$;

-- Makes an account an admin, or an ordinary member again. Owner only.
create or replace function public.set_admin(target uuid, value boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
	was boolean;
begin
	if not public.is_owner() then
		raise exception 'Only the owner can appoint admins.';
	end if;
	select username, is_owner, is_admin into who, target_is_owner, was from public.profiles where id = target;
	if who is null then
		raise exception 'That account does not exist.';
	end if;
	if target_is_owner then
		raise exception 'The owner is an admin already, and stays one.';
	end if;
	if was = value then
		return;
	end if;
	update public.profiles set is_admin = value where id = target;
	perform public.log_action(case when value then 'user.admin' else 'user.unadmin' end, who, null, null);
end;
$$;

revoke all on function public.set_admin(uuid, boolean) from public, anon;
grant execute on function public.set_admin(uuid, boolean) to authenticated;

drop function if exists public.store_org_members(text, bigint[]);
drop table if exists public.org_cache;
