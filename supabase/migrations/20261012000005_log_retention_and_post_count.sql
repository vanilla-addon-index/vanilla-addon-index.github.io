-- Two things that let the database grow without the list growing.
--
-- 1. The log was never trimmed. Every edit is logged with the whole addon as it was
--    before, so that it can be reverted, and those copies were kept for good. They are
--    now kept for 90 days, like the trash: after that the line stays and still says who
--    changed which fields, but the edit can no longer be reverted from it. The nightly
--    job does the trimming, and empties the trash of what is older than 90 days, which
--    until now only happened when the next addon was deleted.
--
-- 2. Deleting an addon gave the day's post back, so one account could post and delete
--    in a circle, each round leaving lines in the log and a copy in the trash. The daily
--    posting limit now counts what the account posted, from the log, whether or not it
--    is still there.

-- Called by the nightly job. Returns how many log lines were trimmed.
create or replace function public.nightly_tidy(token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	trimmed integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can tidy up.';
	end if;
	update public.activity_log
	set details = details - 'before' - 'after'
	where at < now() - interval '90 days'
		and action in ('addon.update', 'addon.revert')
		and details ? 'before';
	get diagnostics trimmed = row_count;
	delete from public.addon_trash where deleted_at < now() - interval '90 days';
	delete from public.left_posts where posted_at < now() - interval '1 day';
	return trimmed;
end;
$$;

revoke all on function public.nightly_tidy(text) from public, authenticated, service_role;
grant execute on function public.nightly_tidy(text) to anon;

-- Replaces the version in the moderation migration: a line that no longer says what the
-- addon looked like before cannot be reverted.
create or replace function public.revert_addon(log_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	entry public.activity_log;
	b jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can revert edits.';
	end if;
	select * into entry from public.activity_log where id = log_id and action in ('addon.update', 'addon.revert');
	if entry.id is null then
		raise exception 'That log line is not an edit.';
	end if;
	b := entry.details -> 'before';
	if b is null then
		raise exception 'That edit is too old to revert: what an addon looked like before an edit is kept for 90 days.';
	end if;

	perform set_config('app.doing', 'revert', true);
	update public.addons
	set name = b ->> 'name',
		description = coalesce(b ->> 'description', ''),
		category = b ->> 'category',
		author = coalesce(b ->> 'author', ''),
		versions = b -> 'versions',
		images = array(select jsonb_array_elements_text(coalesce(b -> 'images', '[]')))
	where id = entry.addon_id;
	if not found then
		raise exception 'That addon no longer exists. Look for it in the trash.';
	end if;
	perform set_config('app.doing', '', true);
end;
$$;

-- Replaces the version in the post limit survives leaving migration: counted from the
-- log, so a post that was deleted again still counts.
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
	if (
		select count(*)
		from public.activity_log l
		where l.actor = auth.uid() and l.action = 'addon.create' and l.at > now() - interval '1 day'
			-- An import an admin changed before publishing is posted first and marked as an
			-- import after; it is not one of the admin's posts.
			and not exists (select 1 from public.addons a where a.id = l.addon_id and a.source <> '')
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

-- Replaces the version in the post limit survives leaving migration: what is noted down
-- for a login that leaves is what the limit above counts.
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
	select public.identity_fingerprint(i.provider, i.provider_id), l.addon_id, l.at
	from public.activity_log l, auth.identities i
	where l.actor = me and l.action = 'addon.create' and l.at > now() - interval '1 day' and l.addon_id is not null
		and not exists (select 1 from public.addons a where a.id = l.addon_id and a.source <> '')
		and i.user_id = me
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
