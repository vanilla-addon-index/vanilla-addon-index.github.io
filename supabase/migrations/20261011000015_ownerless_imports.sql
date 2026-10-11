-- An addon imported from the wiki belongs to nobody. It used to belong to the admin who
-- approved it, exactly like something that admin had written, so deleting that account
-- deleted every import it had approved, and an admin who was no longer one could still
-- edit and delete them all. Now only admins can change an import, and no account's
-- deletion or demotion touches it.
--
-- Who approved it is still kept, in "approved_by": for the admin's profile, nothing else.
-- It is deliberately not tied to the profiles table: a second link between the two tables
-- would make "the addon's profile" ambiguous to the API, and an id that no longer leads
-- anywhere does no harm.

alter table public.addons alter column owner drop not null;
alter table public.addons add column if not exists approved_by uuid;

-- Keeps the two columns to that rule, whichever function writes the row: an import has no
-- owner and remembers who approved it; anything else has an owner and no approver.
-- Runs after addons_before_update (triggers fire in name order), which pins the owner.
create or replace function public.addons_import_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
	if new.source <> '' then
		-- The functions that publish an import write the row as the admin calling them.
		new.approved_by := case
			when tg_op = 'INSERT' then coalesce(new.approved_by, new.owner)
			else coalesce(old.approved_by, old.owner)
		end;
		new.owner := null;
	else
		new.approved_by := null;
	end if;
	return new;
end;
$$;

drop trigger if exists addons_import_owner on public.addons;
create trigger addons_import_owner
	before insert or update on public.addons
	for each row execute function public.addons_import_owner();

-- The imports that are already live. Nothing about them changed for a reader, so this
-- is no edit: not in the log, and "updated" stays as it was.
alter table public.addons disable trigger user;
update public.addons set approved_by = owner, owner = null where source <> '';
alter table public.addons enable trigger user;

-- Replaces the version in the groups migration: an addon nobody owns is nobody's to
-- suggest a group for, except an admin's. ("owner <> auth.uid()" is neither true nor
-- false without an owner, which let anyone through.)
create or replace function public.suggest_group(addon bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	mine public.addons;
	theirs public.addons;
begin
	if auth.uid() is null or public.is_banned() then
		raise exception 'You cannot suggest a group.';
	end if;
	select * into mine from public.addons where id = addon;
	select * into theirs from public.addons where id = target;
	if mine.id is null or theirs.id is null or addon = target then
		raise exception 'Pick two different addons.';
	end if;
	if mine.owner is distinct from auth.uid() and not public.is_admin() then
		raise exception 'You can only suggest a group for an addon you posted.';
	end if;
	if mine.group_id is not null and mine.group_id = theirs.group_id then
		return;
	end if;

	insert into public.group_suggestions (addon_id, target_id, kind, suggested_by, suggested_by_name)
	values (addon, target, 'user', auth.uid(), (select username from public.profiles where id = auth.uid()))
	on conflict (pair) do nothing;
	if found then
		perform public.log_action('group.suggest', mine.name, addon, jsonb_build_object('target', theirs.name));
	end if;
end;
$$;

-- Replaces the version in the groups migration: an addon becoming an import, which moves
-- it from its owner to nobody, is not an edit either.
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
		where n.key not in ('updated_at', 'link_keys', 'repo_url', 'group_id', 'is_main', 'source', 'owner', 'approved_by')
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
			-- With the others in its group, so a restore can put it back among them. This
			-- runs before addons_group_cleanup, while a group of two is still a group.
			to_jsonb(old) - 'link_keys' || jsonb_build_object(
				'group_members',
				(select coalesce(jsonb_agg(g.id), '[]') from public.addons g where g.group_id = old.group_id)
			),
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
