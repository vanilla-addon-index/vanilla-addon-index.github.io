-- Run once in the Supabase SQL editor, after import.sql. Safe to run again.
--
-- Guards against abuse:
--   * owner and admin are separate levels; only the owner can suspend an admin
--   * every change is written to a log that nobody can edit
--   * deleted and merged addons go to a trash for 90 days, and edits can be reverted
--   * an account can only post, edit and delete so much in an hour or a day (limits.sql)
--   * banned accounts can browse but not post or edit
--
-- After running it, make yourself the owner once:
--   update public.profiles set is_owner = true where username = 'your-username';

alter table public.profiles add column if not exists is_owner boolean not null default false;
alter table public.profiles add column if not exists banned boolean not null default false;

-- Role and ban flags are read through the functions below, not from the table.
revoke select on public.profiles from anon, authenticated;
grant select (id, username, created_at) on public.profiles to anon, authenticated;

-- Admin by any route (owner, hand-ticked, or organization member), whether or not suspended.
create or replace function public.is_staff(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.profiles p
		where p.id = uid
			and (
				p.is_owner
				or p.is_admin
				or exists (
					select 1
					from public.org_cache c
					join auth.identities i on i.user_id = uid and i.provider = 'github'
					where i.provider_id::bigint = any (c.member_ids)
				)
			)
	);
$$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce((select banned from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.profiles where id = auth.uid() and is_owner);
$$;

-- Replaces the version in org-admins.sql: a suspended admin has no admin rights.
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
					where c.fetched_at > now() - interval '2 hours'
						and i.provider_id::bigint = any (c.member_ids)
				)
			)
	);
$$;

-- What the site asks after login.
create or replace function public.my_role() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	perform public.refresh_admin();
	return jsonb_build_object('admin', public.is_admin(), 'owner', public.is_owner(), 'banned', public.is_banned());
end;
$$;

-- Banned accounts keep their login but cannot post or change anything.
drop policy if exists "signed-in users can post" on public.addons;
create policy "signed-in users can post" on public.addons for insert to authenticated
	with check (owner = auth.uid() and not public.is_banned());
drop policy if exists "owners and admins can edit" on public.addons;
create policy "owners and admins can edit" on public.addons for update to authenticated
	using ((owner = auth.uid() and not public.is_banned()) or public.is_admin());
drop policy if exists "owners and admins can delete" on public.addons;
create policy "owners and admins can delete" on public.addons for delete to authenticated
	using ((owner = auth.uid() and not public.is_banned()) or public.is_admin());

-- The log. Written by triggers and functions only; nobody can change or remove a line.
create table if not exists public.activity_log (
	id bigint generated always as identity primary key,
	at timestamptz not null default now(),
	actor uuid references public.profiles on delete set null,
	actor_name text,
	-- addon.create, addon.update, addon.delete, addon.merge, addon.restore, addon.revert,
	-- import.approve, import.reject, import.requeue, user.ban, user.unban,
	-- user.autosuspend
	action text not null,
	-- The addon or account the line is about.
	subject text,
	addon_id bigint,
	details jsonb
);
create index if not exists activity_log_at_idx on public.activity_log (at desc);
create index if not exists activity_log_actor_idx on public.activity_log (actor, at desc);

-- Deleted and merged addons, kept for 90 days.
create table if not exists public.addon_trash (
	id bigint generated always as identity primary key,
	-- The whole row as it was.
	addon jsonb not null,
	name text not null,
	reason text not null,
	deleted_by uuid references public.profiles on delete set null,
	deleted_by_name text,
	deleted_at timestamptz not null default now()
);

alter table public.activity_log enable row level security;
alter table public.addon_trash enable row level security;
drop policy if exists "admins read the log" on public.activity_log;
create policy "admins read the log" on public.activity_log for select to authenticated using (public.is_admin());
drop policy if exists "admins read the trash" on public.addon_trash;
create policy "admins read the trash" on public.addon_trash for select to authenticated using (public.is_admin());
revoke all on public.activity_log, public.addon_trash from anon, authenticated;
grant select on public.activity_log, public.addon_trash to authenticated;

create or replace function public.log_action(action text, subject text, addon bigint, details jsonb) returns void
language sql security definer set search_path = '' as $$
	insert into public.activity_log (actor, actor_name, action, subject, addon_id, details)
	values (auth.uid(), (select username from public.profiles where id = auth.uid()), action, subject, addon, details);
$$;

-- True while a function below is doing the named kind of work, so the triggers can tell
-- a merge from a plain delete, and so on. Set for the current transaction only.
create or replace function public.doing(what text) returns boolean
language sql stable set search_path = '' as $$
	select coalesce(current_setting('app.doing', true), '') = what;
$$;

-- Records every change to an addon, and moves deleted ones to the trash.
create or replace function public.addons_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	changed text[];
	kind text;
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
		where n.key not in ('updated_at', 'link_keys', 'repo_url')
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
		kind := case when public.doing('merge') then 'merge' else 'delete' end;
		insert into public.addon_trash (addon, name, reason, deleted_by, deleted_by_name)
		values (
			to_jsonb(old) - 'link_keys',
			old.name,
			kind,
			auth.uid(),
			(select username from public.profiles where id = auth.uid())
		)
		returning id into trashed;
		perform public.log_action(
			case kind when 'merge' then 'addon.merge' else 'addon.delete' end,
			old.name,
			old.id,
			jsonb_build_object('trash_id', trashed)
		);
		delete from public.addon_trash where deleted_at < now() - interval '90 days';
	end if;
	return null;
end;
$$;

drop trigger if exists addons_audit on public.addons;
create trigger addons_audit
	after insert or update or delete on public.addons
	for each row execute function public.addons_audit();

-- How much one account can post, edit and delete in an hour or a day is in limits.sql.

-- Replaces the version in versions.sql: the delete is marked as a merge for the log, and a
-- merge stopped by the brake ends quietly.
create or replace function public.merge_addons(source_id bigint, target_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	merged public.addons;
	poster text;
	moved jsonb;
begin
	if not public.is_admin() then
		raise exception 'Only admins can merge addons.';
	end if;
	if source_id = target_id then
		raise exception 'Pick a different addon to merge into.';
	end if;
	if not exists (select 1 from public.addons where id = target_id) then
		raise exception 'The addon to merge into no longer exists.';
	end if;

	perform set_config('app.doing', 'merge', true);
	delete from public.addons where id = source_id returning * into merged;
	perform set_config('app.doing', '', true);
	if merged.id is null then
		return;
	end if;

	select username into poster from public.profiles where id = merged.owner;
	select jsonb_agg(v || jsonb_build_object('added_by', coalesce(v ->> 'added_by', poster, '')))
	into moved
	from jsonb_array_elements(merged.versions) v;

	update public.addons t
	set versions = t.versions || moved,
		aliases = t.aliases || merged.slug || merged.aliases
	where t.id = target_id;
end;
$$;

-- Puts a deleted or merged addon back. Returns its address.
create or replace function public.restore_addon(trash_id bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
	t public.addon_trash;
	a jsonb;
	keys text[];
	holder record;
	kept jsonb;
	base text;
	new_slug text;
	n integer := 1;
	poster uuid;
	made bigint;
begin
	if not public.is_admin() then
		raise exception 'Only admins can restore addons.';
	end if;
	select * into t from public.addon_trash where id = trash_id;
	if t.id is null then
		raise exception 'That addon is no longer in the trash.';
	end if;
	a := t.addon;
	select array_agg(public.link_key(v ->> 'url')) into keys from jsonb_array_elements(a -> 'versions') v;

	-- A merge moved these links under another addon; they move back.
	for holder in select id, versions from public.addons where link_keys && keys loop
		select jsonb_agg(v) into kept
		from jsonb_array_elements(holder.versions) v
		where not public.link_key(v ->> 'url') = any (keys);
		if kept is null then
			raise exception 'Another addon now lists only these links. Edit or delete it first.';
		end if;
		update public.addons
		set versions = kept, aliases = array_remove(aliases, a ->> 'slug')
		where id = holder.id;
	end loop;

	base := a ->> 'slug';
	new_slug := base;
	while exists (select 1 from public.addons x where x.slug = new_slug) loop
		n := n + 1;
		new_slug := base || '-' || n;
	end loop;

	-- Back to whoever posted it, if that account still exists.
	select id into poster from public.profiles where id = (a ->> 'owner')::uuid;

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		slug, name, description, category, author, versions, images, source, aliases, owner, created_at
	)
	values (
		new_slug,
		a ->> 'name',
		coalesce(a ->> 'description', ''),
		a ->> 'category',
		coalesce(a ->> 'author', ''),
		a -> 'versions',
		array(select jsonb_array_elements_text(coalesce(a -> 'images', '[]'))),
		coalesce(a ->> 'source', ''),
		array(select jsonb_array_elements_text(coalesce(a -> 'aliases', '[]'))),
		coalesce(poster, auth.uid()),
		(a ->> 'created_at')::timestamptz
	)
	returning id into made;
	perform set_config('app.doing', '', true);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

-- Sets an addon back to how it was before one logged edit.
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

-- Removes trashed addons for good. Owner only.
create or replace function public.purge_trash(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	gone integer;
begin
	if not public.is_owner() then
		raise exception 'Only the owner can empty the trash.';
	end if;
	delete from public.addon_trash where id = any (ids);
	get diagnostics gone = row_count;
	return gone;
end;
$$;

-- Bans or unbans an account. Admins can ban members; only the owner can suspend an admin.
-- What the account posted or imported stays up: taking any of it down is a separate
-- decision, made addon by addon.
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

-- Accounts for the admin panel. Staff first.
-- Dropped first because "create or replace" cannot change the columns a function returns.
drop function if exists public.list_users(text);
create function public.list_users(search text)
returns table (id uuid, username text, joined timestamptz, banned boolean, role text, addons bigint, providers text[])
language sql stable security definer set search_path = '' as $$
	select
		p.id,
		p.username,
		p.created_at,
		p.banned,
		case when p.is_owner then 'owner' when public.is_staff(p.id) then 'admin' else 'member' end,
		(select count(*) from public.addons a where a.owner = p.id),
		-- What the account logs in with: 'github', 'discord', or both once linked.
		coalesce((select array_agg(i.provider order by i.provider) from auth.identities i where i.user_id = p.id), '{}')
	from public.profiles p
	where public.is_admin()
		and (coalesce(search, '') = '' or p.username ilike '%' || search || '%')
	order by public.is_staff(p.id) desc, p.username
	limit 200;
$$;

-- Replaces the version in import.sql: decisions on the queue are logged.
create or replace function public.decide_imports(ids bigint[], decision text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	changed integer;
	q record;
begin
	if not public.is_admin() then
		raise exception 'Only admins can review imports.';
	end if;
	if decision not in ('rejected', 'pending') then
		raise exception 'Unknown decision.';
	end if;
	for q in
		update public.import_queue
		set status = decision,
			decided_by = case when decision = 'rejected' then auth.uid() end,
			decided_at = case when decision = 'rejected' then now() end
		where id = any (ids) and status in ('pending', 'rejected') and status <> decision
		returning name, url
	loop
		perform public.log_action(
			case decision when 'rejected' then 'import.reject' else 'import.requeue' end,
			q.name,
			null,
			jsonb_build_object('url', q.url)
		);
		changed := coalesce(changed, 0) + 1;
	end loop;
	return coalesce(changed, 0);
end;
$$;

revoke all on function public.log_action(text, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.restore_addon(bigint) from public, anon;
revoke all on function public.revert_addon(bigint) from public, anon;
revoke all on function public.purge_trash(bigint[]) from public, anon;
revoke all on function public.set_banned(uuid, boolean) from public, anon;
revoke all on function public.list_users(text) from public, anon;
revoke all on function public.my_role() from public, anon;
grant execute on function public.is_staff(uuid) to anon, authenticated;
grant execute on function public.is_banned() to anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;
grant execute on function public.doing(text) to anon, authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.restore_addon(bigint) to authenticated;
grant execute on function public.revert_addon(bigint) to authenticated;
grant execute on function public.purge_trash(bigint[]) to authenticated;
grant execute on function public.set_banned(uuid, boolean) to authenticated;
grant execute on function public.list_users(text) to authenticated;
