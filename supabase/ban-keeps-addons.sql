-- One-off, for a database that was set up while a ban could also move everything the
-- account had posted to the trash. A database built from the other files as they are now
-- does not need this.
--
-- A ban now only stops the account from posting and editing. What it posted or imported
-- stays up; taking any of it down is a separate decision, made addon by addon.

drop function if exists public.set_banned(uuid, boolean, boolean);
create or replace function public.set_banned(target uuid, value boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
begin
	if not public.is_admin() then
		raise exception 'Only admins can ban accounts.';
	end if;
	if target = auth.uid() then
		raise exception 'You cannot ban yourself.';
	end if;
	select username, is_owner into who, target_is_owner from public.profiles where id = target;
	if who is null then
		raise exception 'That account does not exist.';
	end if;
	if target_is_owner then
		raise exception 'The owner cannot be banned.';
	end if;
	if public.is_staff(target) and not public.is_owner() then
		raise exception 'Only the owner can suspend an admin.';
	end if;

	update public.profiles set banned = value where id = target;
	perform public.log_action(case when value then 'user.ban' else 'user.unban' end, who, null, null);
end;
$$;

revoke all on function public.set_banned(uuid, boolean) from public, anon;
grant execute on function public.set_banned(uuid, boolean) to authenticated;

-- The two triggers that made an exception for addons trashed with a ban.
create or replace function public.addons_brake() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	me uuid := auth.uid();
	recent integer;
	why text;
begin
	if me is null or public.is_owner() then
		if tg_op = 'DELETE' then
			return old;
		end if;
		return new;
	end if;

	if tg_op = 'DELETE' then
		select count(*) into recent
		from public.activity_log
		where actor = me and action in ('addon.delete', 'addon.merge') and at > now() - interval '1 hour';
		if recent >= 20 then
			why := 'Deleted or merged 20 addons within an hour.';
		end if;
	elsif old.owner <> me then
		select count(*) into recent
		from public.activity_log
		where actor = me
			and action = 'addon.update'
			and details -> 'before' ->> 'owner' <> me::text
			and at > now() - interval '1 hour';
		if recent >= 100 then
			why := 'Edited 100 addons posted by others within an hour.';
		end if;
	end if;

	if why is null then
		if tg_op = 'DELETE' then
			return old;
		end if;
		return new;
	end if;
	update public.profiles set banned = true where id = me;
	perform public.log_action(
		'user.autosuspend', (select username from public.profiles where id = me), null, jsonb_build_object('reason', why)
	);
	return null;
end;
$$;

create or replace function public.addons_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	changed text[];
	trashed bigint;
begin
	if tg_op = 'INSERT' then
		if not public.doing('restore') then
			perform public.log_action(
				case when new.source <> '' then 'import.approve' else 'addon.create' end, new.name, new.id, null
			);
		end if;
	elsif tg_op = 'UPDATE' then
		select array_agg(n.key) into changed
		from jsonb_each(to_jsonb(new)) n
		where n.key not in ('updated_at', 'link_keys', 'repo_url', 'group_id', 'is_main')
			and n.value is distinct from to_jsonb(old) -> n.key;
		if changed is not null then
			perform public.log_action(
				case when public.doing('revert') then 'addon.revert' else 'addon.update' end,
				new.name,
				new.id,
				jsonb_build_object(
					'changed', to_jsonb(changed),
					'before', to_jsonb(old) - 'link_keys',
					'after', (select jsonb_object_agg(field, to_jsonb(new) -> field) from unnest(changed) field)
				)
			);
		end if;
	else
		insert into public.addon_trash (addon, name, reason, deleted_by, deleted_by_name)
		values (
			to_jsonb(old) - 'link_keys',
			old.name,
			'delete',
			auth.uid(),
			(select username from public.profiles where id = auth.uid())
		)
		returning id into trashed;
		perform public.log_action('addon.delete', old.name, old.id, jsonb_build_object('trash_id', trashed));
		delete from public.addon_trash where deleted_at < now() - interval '90 days';
	end if;
	return null;
end;
$$;
