-- The daily posting limit now follows the login, not the account. An account could post
-- its 10 addons, delete itself and log in again as a new account with a count of zero, as
-- often as it liked. The addons stay behind belonging to nobody, where no rollback reaches
-- them, so the limit was the only thing holding such a flood back.
--
-- When an account is deleted, what it posted in its last day is noted down against a
-- fingerprint of the login it used: the SHA-256 of "provider:id", the same one a ban
-- leaves behind. Whoever logs in with that login again starts with those posts already
-- counted. A note is of no use after a day, and is removed the next time anyone leaves.

create table if not exists public.left_posts (
	fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
	addon_id bigint not null,
	posted_at timestamptz not null,
	primary key (fingerprint, addon_id)
);
alter table public.left_posts enable row level security;
revoke all on public.left_posts from anon, authenticated, service_role;

-- Replaces the version in the limits migration: posts made under an account this login
-- has since deleted count too.
create or replace function public.addons_post_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	cap integer;
begin
	-- An approved import arrives with its source set, and a restored addon is not new.
	if auth.uid() is null or public.is_owner() or new.source <> '' or public.doing('restore') then
		return new;
	end if;
	cap := case when public.is_admin() then 50 else 10 end;
	-- Imports the account approved are not its posts.
	if (
		select count(*)
		from public.addons
		where owner = auth.uid() and source = '' and created_at > now() - interval '1 day'
	) + (
		-- An account with two logins leaves a note under each; the addon counts once.
		select count(distinct l.addon_id)
		from public.left_posts l
		join auth.identities i on l.fingerprint = public.identity_fingerprint(i.provider, i.provider_id)
		where i.user_id = auth.uid() and l.posted_at > now() - interval '1 day'
	) >= cap then
		raise exception 'You can post at most % addons a day. Try again tomorrow.', cap using errcode = 'LIMIT';
	end if;
	return new;
end;
$$;

-- Replaces the version in the delete account migration: the posts of its last day are
-- noted down before the addons are handed to nobody.
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

	delete from public.left_posts where posted_at < now() - interval '1 day';
	insert into public.left_posts (fingerprint, addon_id, posted_at)
	select public.identity_fingerprint(i.provider, i.provider_id), a.id, a.created_at
	from public.addons a, auth.identities i
	where a.owner = me and a.source = '' and a.created_at > now() - interval '1 day' and i.user_id = me
	on conflict do nothing;

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
