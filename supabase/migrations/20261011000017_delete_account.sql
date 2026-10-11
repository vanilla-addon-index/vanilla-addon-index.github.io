-- An account can delete itself, from its own account page.
--
--   * Its login, email address, username and sessions are removed.
--   * The addons it posted stay in the list, belonging to nobody. They describe other
--     people's work, and the list is poorer without. Whoever wants theirs gone deletes
--     them first, one by one like any other delete, where an admin can still restore them.
--   * What it did stays in the admin log, as the work of "deleted account".
--   * A banned account stays banned: a fingerprint of the login it was banned under is
--     kept, and whoever logs in with that login again is banned from the start.
--   * The owner cannot: the site would be left with nobody to look after its admins.

-- Logins that were banned when their account was deleted. Only the fingerprint is kept:
-- the SHA-256 of "provider:id", which says nothing by itself.
create table if not exists public.banned_identities (
	fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{64}$'),
	banned_at timestamptz not null default now()
);
alter table public.banned_identities enable row level security;
revoke all on public.banned_identities from anon, authenticated, service_role;

create or replace function public.identity_fingerprint(provider text, provider_id text) returns text
language sql immutable set search_path = '' as $$
	select encode(sha256(convert_to(provider || ':' || provider_id, 'UTF8')), 'hex');
$$;
revoke all on function public.identity_fingerprint(text, text) from public, anon, authenticated, service_role;

-- True for an account whose login was banned under an earlier account, too.
create or replace function public.returned_banned() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from auth.identities i
		join public.banned_identities b on b.fingerprint = public.identity_fingerprint(i.provider, i.provider_id)
		where i.user_id = auth.uid()
	);
$$;
revoke all on function public.returned_banned() from public, anon, authenticated, service_role;

-- Replaces the version in the moderation migration.
create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce((select banned from public.profiles where id = auth.uid()), false) or public.returned_banned();
$$;

-- Replaces the version in the org members migration: banned by either route.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.profiles p
		where p.id = auth.uid()
			and not public.is_banned()
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

-- Replaces the version in the org members migration. The site asks this after every
-- login, which is when a returning banned login gets its ban written onto its new
-- account: from then on it shows as banned to the admins, and they can lift it as usual.
-- Until then is_banned() above already holds it back.
create or replace function public.my_role() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	if public.returned_banned() then
		update public.profiles set banned = true where id = auth.uid();
		delete from public.banned_identities b
		using auth.identities i
		where i.user_id = auth.uid() and b.fingerprint = public.identity_fingerprint(i.provider, i.provider_id);
		insert into public.activity_log (actor_name, action, subject, details)
		values (
			null,
			'user.ban',
			(select username from public.profiles where id = auth.uid()),
			jsonb_build_object('reason', 'This login was banned under an account that has since been deleted.')
		);
	end if;
	return jsonb_build_object('admin', public.is_admin(), 'owner', public.is_owner(), 'banned', public.is_banned());
end;
$$;

-- Replaces the version in the groups migration: an account that leaves hands its addons
-- to nobody, which is the one time an owner changes, and is no edit of them.
create or replace function public.addons_before_update() returns trigger
language plpgsql as $$
begin
	if not public.doing('leave') then
		new.owner := old.owner;
	end if;
	new.created_at := old.created_at;
	-- repo_url is derived by the database after this trigger, so it is still empty here.
	if to_jsonb(new) - '{group_id,is_main,repo_url,owner,approved_by}'::text[] is distinct from to_jsonb(old) - '{group_id,is_main,repo_url,owner,approved_by}'::text[] then
		new.updated_at := now();
	else
		new.updated_at := old.updated_at;
	end if;
	return new;
end;
$$;

-- Replaces the version in the ownerless imports migration: an account that leaves is also
-- forgotten as the one who approved an import.
create or replace function public.addons_import_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
	if new.source <> '' then
		-- The functions that publish an import write the row as the admin calling them.
		new.approved_by := case
			when tg_op = 'INSERT' then coalesce(new.approved_by, new.owner)
			when public.doing('leave') then new.approved_by
			else coalesce(old.approved_by, old.owner)
		end;
		new.owner := null;
	else
		new.approved_by := null;
	end if;
	return new;
end;
$$;

create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
	me uuid := auth.uid();
	who text;
	was_banned boolean;
	posted integer;
begin
	if me is null then
		raise exception 'You are not logged in.';
	end if;
	if public.is_owner() then
		raise exception 'The owner''s account cannot be deleted. Make someone else the owner first.';
	end if;
	select username into who from public.profiles where id = me;
	was_banned := public.is_banned();

	perform set_config('app.doing', 'leave', true);
	select count(*) into posted from public.addons where owner = me;
	update public.addons set owner = null where owner = me;
	update public.addons set approved_by = null where approved_by = me;

	if was_banned then
		insert into public.banned_identities (fingerprint)
		select public.identity_fingerprint(i.provider, i.provider_id) from auth.identities i where i.user_id = me
		on conflict do nothing;
	end if;

	-- The records of what the account did stay, without its name.
	update public.activity_log set actor_name = 'deleted account' where actor = me;
	update public.activity_log set subject = 'deleted account' where action like 'user.%' and subject = who;
	update public.addon_trash set deleted_by_name = 'deleted account' where deleted_by = me;
	update public.group_suggestions set suggested_by_name = 'deleted account' where suggested_by = me;
	update public.reports set reported_by_name = 'deleted account' where reported_by = me;
	insert into public.activity_log (actor_name, action, subject, details)
	values (
		'deleted account',
		'account.delete',
		'their account',
		jsonb_build_object('addons', posted, 'banned', was_banned)
	);

	-- The profile, the logins and the sessions go with it.
	delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
