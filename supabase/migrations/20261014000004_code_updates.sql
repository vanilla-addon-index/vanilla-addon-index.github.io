-- Commit dates belong to the exact link, including its branch and addon folder. A
-- repository key deliberately ignores some of those details and is not sufficient.
create table public.repo_code_updates (
	url text primary key,
	committed_at timestamptz not null,
	history_url text not null check (history_url ~ '^https://(github\.com|gitlab\.com|codeberg\.org|gitea\.com)/'),
	checked_at timestamptz not null default now()
);
alter table public.repo_code_updates enable row level security;
revoke all on public.repo_code_updates from public, anon, authenticated, service_role;

-- Included in the ordinary addon response and public snapshot. Clients cannot set it:
-- it always comes from the latest successful check of the primary link.
alter table public.addons add column code_update jsonb;
grant select (code_update) on public.addons to anon;

create function public.addons_code_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	select jsonb_build_object('date', r.committed_at, 'url', r.history_url)
	into new.code_update
	from public.repo_code_updates r
	where r.url = new.versions -> 0 ->> 'url';
	return new;
end;
$$;
-- Before timestamp and audit checks, so a client's attempt to change it is a no-op.
create trigger addons_aa_code_update
	before insert or update on public.addons
	for each row execute function public.addons_code_update();
revoke all on function public.addons_code_update() from public, anon, authenticated, service_role;

create function public.store_code_updates(token text, updates jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	stored integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store code updates.';
	end if;
	insert into public.repo_code_updates (url, committed_at, history_url)
	select u.url, u.date, u.history_url
	from jsonb_to_recordset(updates) as u(url text, date timestamptz, history_url text)
	where u.date is not null and u.history_url is not null
		and u.url in (
			select q.url from public.import_queue q where q.status = 'pending'
			union
			select v ->> 'url' from public.addons a, jsonb_array_elements(a.versions) v
		)
	on conflict (url) do update set
		committed_at = excluded.committed_at,
		history_url = excluded.history_url,
		checked_at = now();
	get diagnostics stored = row_count;

	-- Only an actual change advances the freshness stamp. This lets the normal public
	-- list and snapshot pick it up without treating each nightly check as a new edit.
	update public.addons a
	set code_update = jsonb_build_object('date', r.committed_at, 'url', r.history_url)
	from public.repo_code_updates r
	where r.url = a.versions -> 0 ->> 'url'
		and a.code_update is distinct from jsonb_build_object('date', r.committed_at, 'url', r.history_url);
	return stored;
end;
$$;
revoke all on function public.store_code_updates(text, jsonb) from public, authenticated, service_role;
grant execute on function public.store_code_updates(text, jsonb) to anon;

-- Repository metadata is refreshed automatically, never a listing edit in History.
-- Keep the existing audit function, excluding only the new automatic field.
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
		where n.key not in ('updated_at', 'link_keys', 'repo_url', 'group_id', 'is_main', 'source', 'owner', 'approved_by', 'code_update')
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

notify pgrst, 'reload schema';
