-- Run once in the Supabase SQL editor, after validation.sql. Safe to run again.
--
-- How much one account can do in an hour or a day. Reaching a limit never suspends
-- anyone: the action is refused with the reason, and works again once time has passed.
--
--                      member            admin              owner
--   posting            10 a day          50 a day           no limit
--   editing            10 an hour,       100 an hour        no limit
--                      50 a day
--   deleting           20 an hour        20 an hour         no limit
--
-- Approving imports is not posting and has no limit. The limits are there so that a
-- script, or an admin account in the wrong hands, cannot flood the list, rewrite it, empty
-- it, or fill the database through the log, faster than someone can notice and step in.
-- Everything within them is logged and can be undone from the log and the trash.
--
-- A refusal carries the code LIMIT, which the site shows as a pop-up.

-- Replaced by the limits below: the brake suspended an admin who deleted or rewrote too
-- much, where these only refuse.
drop trigger if exists addons_brake on public.addons;
drop function if exists public.addons_brake();

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
	) >= cap then
		raise exception 'You can post at most % addons a day. Try again tomorrow.', cap using errcode = 'LIMIT';
	end if;
	return new;
end;
$$;

drop trigger if exists addons_post_limit on public.addons;
create trigger addons_post_limit
	before insert on public.addons
	for each row execute function public.addons_post_limit();

-- Every edit is written to the log with the addon as it was before, so that it can be
-- reverted. That makes edits the one thing that grows the database without adding to
-- the list, and the reason members get a daily limit as well.
create or replace function public.addons_edit_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	hourly integer;
	in_hour integer;
	in_day integer;
begin
	if auth.uid() is null or public.is_owner() or public.doing('revert') then
		return new;
	end if;
	-- Grouping, and the credit an import gets, are not edits of the addon.
	if (new.name, new.description, new.category, new.author, new.versions, new.images)
		is not distinct from (old.name, old.description, old.category, old.author, old.versions, old.images) then
		return new;
	end if;

	hourly := case when public.is_admin() then 100 else 10 end;
	-- Counted from the log, so a save that changed nothing does not count.
	select count(*) filter (where at > now() - interval '1 hour'), count(*)
	into in_hour, in_day
	from public.activity_log
	where actor = auth.uid() and action = 'addon.update' and at > now() - interval '1 day';
	if in_hour >= hourly then
		raise exception 'You can make at most % edits an hour. Try again later.', hourly using errcode = 'LIMIT';
	end if;
	if in_day >= 50 and not public.is_admin() then
		raise exception 'You can make at most 50 edits a day. Try again tomorrow.' using errcode = 'LIMIT';
	end if;
	return new;
end;
$$;

drop trigger if exists addons_edit_limit on public.addons;
create trigger addons_edit_limit
	before update on public.addons
	for each row execute function public.addons_edit_limit();

create or replace function public.addons_delete_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if auth.uid() is null or public.is_owner() then
		return old;
	end if;
	if (
		select count(*)
		from public.activity_log
		where actor = auth.uid() and action = 'addon.delete' and at > now() - interval '1 hour'
	) >= 20 then
		raise exception 'You can delete at most 20 addons an hour. Try again later.' using errcode = 'LIMIT';
	end if;
	return old;
end;
$$;

drop trigger if exists addons_delete_limit on public.addons;
create trigger addons_delete_limit
	before delete on public.addons
	for each row execute function public.addons_delete_limit();
