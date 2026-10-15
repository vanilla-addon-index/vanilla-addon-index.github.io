-- A canonical page holds links, never the content or ownership of a contributed fork.
alter table public.addons add column shared boolean not null default false;
alter table public.addons add column pinned_link text;
-- Admin-only exceptions permit the rare unrelated projects with the same name.
alter table public.addons add column separate_name boolean not null default false;
grant select (shared, pinned_link, separate_name) on public.addons to anon;

create function public.addon_name_key(value text) returns text
language sql immutable set search_path = '' as $$
 select regexp_replace(lower(value), '[^a-z0-9]', '', 'g');
$$;
grant execute on function public.addon_name_key(text) to anon, authenticated;

-- Private provenance survives reordering; account deletion forgets the contributor.
create table public.addon_link_contributions (
 url text primary key,
 addon_id bigint not null references public.addons on delete cascade,
 submitted_by uuid references public.profiles on delete set null
);
alter table public.addon_link_contributions enable row level security;
revoke all on public.addon_link_contributions from public, anon, authenticated, service_role;
insert into public.addon_link_contributions
 select v ->> 'url', a.id, a.owner from public.addons a, jsonb_array_elements(a.versions) v;

-- Permanent participation is distinct from the removable active-link ledger.
create table public.addon_contributors (
 addon_id bigint not null references public.addons on delete cascade,
 -- Reference the account directly so the private join does not make the API owner/profile relationship ambiguous.
 user_id uuid not null references auth.users on delete cascade,
 primary key(addon_id, user_id)
);
alter table public.addon_contributors enable row level security;
revoke all on public.addon_contributors from public, anon, authenticated, service_role;
insert into public.addon_contributors select distinct addon_id, submitted_by from public.addon_link_contributions where submitted_by is not null;

create or replace function public.addons_code_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if not exists (select 1 from jsonb_array_elements(new.versions) v where v ->> 'url' = new.pinned_link) then
  new.pinned_link := null;
 end if;
 select jsonb_agg(v order by (v ->> 'url' = new.pinned_link) desc nulls last,
  r.committed_at desc nulls last, position)
 into new.versions
 from jsonb_array_elements(new.versions) with ordinality each(v, position)
 left join public.repo_code_updates r on r.url = v ->> 'url';
 select jsonb_build_object('date', r.committed_at, 'url', r.history_url)
 into new.code_update from public.repo_code_updates r where r.url = new.versions -> 0 ->> 'url';
 return new;
end;
$$;

create or replace function public.addons_import_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
 if jsonb_array_length(new.versions) > 1 then new.shared := true; end if;
 if tg_op = 'UPDATE' and old.shared then new.shared := true; end if;
 if new.source <> '' then
  new.approved_by := case when tg_op = 'INSERT' then coalesce(new.approved_by, new.owner)
   when public.doing('leave') then new.approved_by else coalesce(old.approved_by, old.owner) end;
  new.owner := null;
 else new.approved_by := null;
 end if;
 if new.shared then new.owner := null; end if;
 return new;
end;
$$;

-- Reject bypasses through direct inserts/renames, and serialize concurrent name claims.
create function public.addons_name_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(new.name), 0));
 if not new.separate_name and exists (select 1 from public.addons a where a.id is distinct from new.id
  and not a.separate_name and public.addon_name_key(a.name) = public.addon_name_key(new.name)) then
  raise exception 'An addon with this name already exists. Add a link to its page instead.';
 end if;
 return new;
end;
$$;
revoke all on function public.addons_name_claim() from public, anon, authenticated, service_role;

-- Internal function: only the narrow public RPCs below may call this with elevated rights.
create function public.add_addon_link(target bigint, link text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; previous text := coalesce(current_setting('app.doing', true), '');
begin
 select * into a from public.addons where id = target for update;
 if a.id is null then raise exception 'That addon no longer exists.'; end if;
 if link is null or char_length(link) > 300 or link !~ '^https://\S+$' then raise exception 'A valid HTTPS addon link is required.'; end if;
 if not public.is_admin() and not public.host_allowed(link, 'link') then raise exception 'That link host is not allowed.'; end if;
 if public.link_key(link) = any(a.link_keys) then raise exception 'This link is already listed.'; end if;
 perform set_config('app.doing', 'add_link', true);
 update public.addons set versions = versions || jsonb_build_array(jsonb_build_object('url', link, 'note', '')) where id = target;
 perform set_config('app.doing', previous, true);
 return target;
end;
$$;
revoke all on function public.add_addon_link(bigint, text) from public, anon, authenticated, service_role;

create function public.submit_addon(input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare target bigint; title text := btrim(input ->> 'name');
begin
 if auth.uid() is null or public.is_banned() then raise exception 'You cannot submit addons.'; end if;
 if title is null or char_length(title) not between 2 and 60 or public.addon_name_key(title) = '' then raise exception 'The name needs 2 to 60 characters.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 if target is not null then
  if jsonb_array_length(input -> 'versions') is distinct from 1 then raise exception 'Submit one link at a time.'; end if;
  return public.add_addon_link(target, btrim(input -> 'versions' -> 0 ->> 'url'));
 end if;
 insert into public.addons(name, description, category, author, versions, images)
 values(title, coalesce(input ->> 'description', ''), input ->> 'category', coalesce(input ->> 'author', ''),
  input -> 'versions', array(select jsonb_array_elements_text(coalesce(input -> 'images', '[]')))) returning id into target;
 return target;
end;
$$;
revoke all on function public.submit_addon(jsonb) from public, anon, service_role;
grant execute on function public.submit_addon(jsonb) to authenticated;

create function public.pin_addon_link(target bigint, link text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can pin links.'; end if;
 perform 1 from public.addons where id = target for update;
 if not found then raise exception 'That addon no longer exists.'; end if;
 if link is not null and not exists(select 1 from public.addons a, jsonb_array_elements(a.versions) v where a.id = target and v ->> 'url' = link) then
  raise exception 'That link is not on this addon.';
 end if;
 update public.addons set pinned_link = link where id = target;
end;
$$;
revoke all on function public.pin_addon_link(bigint, text) from public, anon, service_role;
grant execute on function public.pin_addon_link(bigint, text) to authenticated;

-- Import decisions and any edited fields are committed atomically.
create function public.publish_import(queue_id bigint, input jsonb default null, destination bigint default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare q public.import_queue; target bigint; title text; draft jsonb;
begin
 if not public.is_admin() then raise exception 'Only admins can approve imports.'; end if;
 select * into q from public.import_queue where id = queue_id and status = 'pending' for update;
 if q.id is null then raise exception 'That import is no longer pending.'; end if;
 title := left(coalesce(input ->> 'name', q.name), 60);
 perform pg_advisory_xact_lock(hashtextextended(public.addon_name_key(title), 0));
 select id into target from public.addons where public.addon_name_key(name) = public.addon_name_key(title)
 order by separate_name, created_at, id limit 1;
 target := coalesce(target, destination);
 if target is not null then
  perform public.add_addon_link(target, q.url);
 else
  draft := coalesce(input, jsonb_build_object('name', title, 'description', btrim(q.description), 'category', q.category,
   'author', public.link_author(q.url), 'images', to_jsonb(q.images[1:5])));
  insert into public.addons(name, description, category, author, versions, images, source)
  values(title, coalesce(draft ->> 'description', ''), draft ->> 'category', coalesce(draft ->> 'author', ''),
   jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
   array(select jsonb_array_elements_text(coalesce(draft -> 'images', '[]'))), 'Turtle WoW Wiki') returning id into target;
 end if;
 update public.import_queue set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = target, problem = null where id = queue_id;
 return target;
end;
$$;
revoke all on function public.publish_import(bigint, jsonb, bigint) from public, anon, service_role;
grant execute on function public.publish_import(bigint, jsonb, bigint) to authenticated;

create or replace function public.approve_imports(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare q record; published integer := 0;
begin
 if not public.is_admin() then raise exception 'Only admins can approve imports.'; end if;
 for q in select id from public.import_queue where id = any(ids) and status = 'pending' order by id loop
  begin
   perform public.publish_import(q.id); published := published + 1;
  exception when others then update public.import_queue set problem = sqlerrm where id = q.id;
  end;
 end loop;
 return published;
end;
$$;

create or replace function public.approve_into(queue_id bigint, target bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin perform public.publish_import(queue_id, null, target); end;
$$;

-- Manual name-collision cleanup creates a distinct entry and moves only this link.
create function public.split_addon_link(target bigint, link text, input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.addons; made bigint; kept jsonb;
begin
 if not public.is_admin() then raise exception 'Only admins can separate links.'; end if;
 select * into a from public.addons where id = target for update;
 if a.id is null or not exists(select 1 from jsonb_array_elements(a.versions) v where v ->> 'url' = link) then raise exception 'That link no longer exists.'; end if;
 select jsonb_agg(v) into kept from jsonb_array_elements(a.versions) v where v ->> 'url' <> link;
 if kept is null and not a.shared then raise exception 'The only link cannot be separated.'; end if;
 kept := coalesce(kept, '[]');
 update public.addons set versions = kept where id = target;
 insert into public.addons(name, description, category, author, versions, images, separate_name, shared)
 values(input ->> 'name', coalesce(input ->> 'description', ''), input ->> 'category', coalesce(input ->> 'author', ''),
  jsonb_build_array(jsonb_build_object('url', link, 'note', '')), array(select jsonb_array_elements_text(coalesce(input -> 'images', '[]'))), true, true)
 returning id into made;
 update public.addon_link_contributions set addon_id = made where url = link;
 return made;
end;
$$;
revoke all on function public.split_addon_link(bigint, text, jsonb) from public, anon, service_role;
grant execute on function public.split_addon_link(bigint, text, jsonb) to authenticated;

create or replace function public.addons_links_member() returns trigger
language plpgsql set search_path = '' as $$
declare
	main_key text := public.link_key(new.versions -> 0 ->> 'url');
begin
	-- The database's own work (auth.uid() is empty), an admin, and a restore from the trash.
	if auth.uid() is null or public.is_admin() or public.doing('restore') or public.doing('add_link') then
		return new;
	end if;
	if tg_op = 'INSERT' then
		if cardinality(new.link_keys) > 1 then
			raise exception 'An addon is posted with one link. Post another version as an addon of its own.';
		end if;
	elsif exists (
		select 1 from unnest(new.link_keys) k where k <> main_key and not k = any (old.link_keys)
	) then
		raise exception 'Only an admin can add another link to an addon. Post another version as an addon of its own.';
	end if;
	return new;
end;
$$;
create or replace function public.addons_links() returns trigger
language plpgsql set search_path = '' as $$
declare
	item jsonb;
	clash text;
begin
	if jsonb_typeof(new.versions) is distinct from 'array'
		or jsonb_array_length(new.versions) not between 1 and 100 then
		raise exception 'An addon needs between 1 and 100 links.';
	end if;

	for item in select * from jsonb_array_elements(new.versions) loop
		if coalesce(item ->> 'url', '') !~ '^https://\S+$' then
			raise exception 'Every link must start with https://';
		end if;
		if char_length(coalesce(item ->> 'note', '')) > 80 then
			raise exception 'A version note can be at most 80 characters.';
		end if;
	end loop;

	select array_agg(distinct public.link_key(v ->> 'url')) into new.link_keys
	from jsonb_array_elements(new.versions) v;
	if cardinality(new.link_keys) <> jsonb_array_length(new.versions) then
		raise exception 'The same link is listed twice.';
	end if;

	perform pg_advisory_xact_lock(hashtextextended(k, 1)) from unnest(new.link_keys) k order by k;
	select a.name into clash
	from public.addons a
	where a.id is distinct from new.id and a.link_keys && new.link_keys
	limit 1;
	if clash is not null then
		raise exception 'This link is already listed under "%".', clash;
	end if;

	return new;
end;
$$;
create or replace function public.addons_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	changed text[];
	trashed bigint;
begin
	if tg_op = 'UPDATE' and public.doing('code_refresh') then return null; end if;
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
				(jsonb_build_object(
					'removed_links', case when public.doing('remove_link') then (select jsonb_agg(v) from jsonb_array_elements(old.versions) v where not exists(select 1 from jsonb_array_elements(new.versions) n where n ->> 'url' = v ->> 'url')) else null end,
                    'added_links', case when public.doing('add_link') then (select jsonb_agg(v ->> 'url') from jsonb_array_elements(new.versions) v where not exists(select 1 from jsonb_array_elements(old.versions) o where o ->> 'url' = v ->> 'url')) else null end,
                    'changed', to_jsonb(changed),
					'before', to_jsonb(old) - 'link_keys',
					'after', (select jsonb_object_agg(field, to_jsonb(new) -> field) from unnest(changed) field)
				) - case when public.doing('add_link') then '__none__' else 'added_links' end - case when public.doing('remove_link') then '__none__' else 'removed_links' end)
			);
		end if;
	else
		insert into public.addon_trash (addon, name, reason, deleted_by, deleted_by_name)
		values (
			-- With the others in its group, so a restore can put it back among them. This
			-- runs before addons_group_cleanup, while a group of two is still a group.
			to_jsonb(old) - 'link_keys' || jsonb_build_object(
				'contributors', (select coalesce(jsonb_agg(c.user_id), '[]') from public.addon_contributors c where c.addon_id = old.id),
                'link_contributors', (select coalesce(jsonb_object_agg(c.url,c.submitted_by),'{}') from public.addon_link_contributions c where exists(select 1 from jsonb_array_elements(old.versions) v where v ->> 'url' = c.url)),
                'group_members',
				(select coalesce(jsonb_agg(g.id), '[]') from public.addons g where g.group_id = old.group_id and g.id <> old.id)
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
	if tg_op = 'DELETE' then return old; end if;
	return null;
end;
$$;
-- Capture child provenance before ON DELETE CASCADE removes it. The deletion brake
-- runs first; normal create/edit audit remains an AFTER trigger.
drop trigger addons_audit on public.addons;
create trigger addons_audit after insert or update on public.addons for each row execute function public.addons_audit();
create trigger addons_zz_audit_delete before delete on public.addons for each row execute function public.addons_audit();

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

 if jsonb_typeof(entry.details -> 'added_links') = 'array' then
  perform set_config('app.doing', 'revert', true);
  update public.addons a set versions = (select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(a.versions) v where not (entry.details -> 'added_links') ? (v ->> 'url')),
   shared = case when a.versions = entry.details -> 'after' -> 'versions' then coalesce((b ->> 'shared')::boolean, false) else a.shared end,
   owner = case when a.versions = entry.details -> 'after' -> 'versions' then (select id from public.profiles where id = (b ->> 'owner')::uuid) else a.owner end
  where a.id = entry.addon_id;
  perform set_config('app.doing', '', true);
  return;
 end if;

	perform set_config('app.doing', 'revert', true);
	update public.addons
	set name = b ->> 'name',
		description = coalesce(b ->> 'description', ''),
		category = b ->> 'category',
		author = coalesce(b ->> 'author', ''),
		versions = b -> 'versions',
		images = array(select jsonb_array_elements_text(coalesce(b -> 'images', '[]'))),
        owner = (select id from public.profiles where id = (b ->> 'owner')::uuid), shared = coalesce((b ->> 'shared')::boolean, false), pinned_link = b ->> 'pinned_link'
	where id = entry.addon_id;
	if not found then
		raise exception 'That addon no longer exists. Look for it in the trash.';
	end if;
	perform set_config('app.doing', '', true);
end;
$$;
create or replace function public.addons_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
	if not public.doing('leave') and not public.doing('revert') then
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
create or replace function public.store_code_updates(token text, updates jsonb) returns integer
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
 perform set_config('app.doing', 'code_refresh', true);
 update public.addons a set versions = a.versions
 where exists(select 1 from jsonb_array_elements(a.versions) v, jsonb_array_elements(updates) u where v ->> 'url' = u ->> 'url');
 perform set_config('app.doing', '', true);
 return stored;
end;
$$;
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
	approver uuid;
	made bigint;
	gid bigint;
	others bigint[];
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
	for holder in select id, versions, shared from public.addons where link_keys && keys loop
		select jsonb_agg(v) into kept
		from jsonb_array_elements(holder.versions) v
		where not public.link_key(v ->> 'url') = any (keys);
		if kept is null and not holder.shared then
			raise exception 'Another addon now lists only these links. Edit or delete it first.';
		end if;
        kept := coalesce(kept,'[]');
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

	-- Back to whoever posted it, if that account still exists; to nobody otherwise, and
	-- never to whoever restores it. The same goes for who approved an import.
	select id into poster from public.profiles where id = (a ->> 'owner')::uuid;
	select id into approver from public.profiles where id = (a ->> 'approved_by')::uuid;

	made := (a ->> 'id')::bigint;
	if made is null or exists (select 1 from public.addons where id = made) then
		made := nextval(pg_get_serial_sequence('public.addons', 'id'));
	end if;

	perform set_config('app.doing', 'restore', true);
	insert into public.addons (
		id, slug, name, description, category, author, versions, images, source, aliases, owner, approved_by, created_at, updated_at, shared, pinned_link, separate_name
	)
	overriding system value
	values (
		made,
		new_slug,
		a ->> 'name',
		coalesce(a ->> 'description', ''),
		a ->> 'category',
		coalesce(a ->> 'author', ''),
		a -> 'versions',
		array(select jsonb_array_elements_text(coalesce(a -> 'images', '[]'))),
		coalesce(a ->> 'source', ''),
		array(select jsonb_array_elements_text(coalesce(a -> 'aliases', '[]'))),
		poster,
		approver,
		(a ->> 'created_at')::timestamptz,
		coalesce((a ->> 'updated_at')::timestamptz, now()), coalesce((a ->> 'shared')::boolean, false), a ->> 'pinned_link', true
	);
 if a ? 'contributors' then
  delete from public.addon_contributors where addon_id = made;
  insert into public.addon_contributors select made,p.id from public.profiles p
   where p.id::text in(select jsonb_array_elements_text(a -> 'contributors'));
 elsif poster is not null then
  insert into public.addon_contributors values(made,poster) on conflict do nothing;
 end if;
 if a ? 'link_contributors' then
  update public.addon_link_contributions c set submitted_by = (select p.id from public.profiles p where p.id::text = a -> 'link_contributors' ->> c.url) where c.addon_id = made;
 end if;

	perform set_config('app.doing', '', true);

	-- Back in its group: the one it left if that still exists, or the group of two that
	-- fell apart when it was deleted. See the groups migration.
	gid := (a ->> 'group_id')::bigint;
	if gid is not null then
		others := array(select jsonb_array_elements_text(coalesce(a -> 'group_members', '[]'))::bigint);
		if exists (select 1 from public.addons where group_id = gid) then
			update public.addons set group_id = gid, is_main = false where id = made;
		elsif cardinality(others) = 1 and exists (select 1 from public.addons where id = others[1] and group_id is null) then
			update public.addons set group_id = gid, is_main = (id <> made) where id in (made, others[1]);
		else
			gid := null;
		end if;
		if gid is not null then
			if coalesce((a ->> 'is_main')::boolean, false) then
				update public.addons set is_main = (id = made) where group_id = gid and is_main is distinct from (id = made);
			end if;
			perform public.tidy_group(gid);
		end if;
	end if;

	-- An approved import points at its addon again.
	update public.import_queue set addon_id = made where addon_id is null and status = 'approved' and key = any (keys);

	delete from public.addon_trash where id = trash_id;
	perform public.log_action('addon.restore', a ->> 'name', made, jsonb_build_object('reason', t.reason));
	return new_slug;
end;
$$;

create or replace function public.rollback_account(target uuid, since timestamptz, preview boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	who text;
	target_is_owner boolean;
	line public.activity_log;
	steps jsonb := '[]';
	skipped jsonb := '[]';
	first_edit bigint;
	later integer;
	found_id bigint;
	found_user uuid;
begin
	if not public.is_admin() then
		raise exception 'Only admins can roll an account back.';
	end if;
	if target = auth.uid() then
		raise exception 'You cannot roll yourself back.';
	end if;
	select username, is_owner into who, target_is_owner from public.profiles where id = target;
	if who is null then
		raise exception 'That account does not exist.';
	end if;
	if target_is_owner then
		raise exception 'The owner cannot be rolled back.';
	end if;
	if public.is_staff(target) and not public.is_owner() then
		raise exception 'Only the owner can roll an admin back.';
	end if;

	begin
		for line in
			select * from public.activity_log where actor = target and at >= since order by id desc
		loop
			begin
				if line.action = 'addon.delete' then
					found_id := (line.details ->> 'trash_id')::bigint;
					if exists (select 1 from public.addon_trash where id = found_id) then
						perform public.restore_addon(found_id);
						steps := steps || jsonb_build_object('kind', 'restore', 'subject', line.subject);
					end if;

				elsif line.action = 'addon.update' and (jsonb_typeof(line.details -> 'added_links') = 'array' or jsonb_typeof(line.details -> 'removed_links') = 'array') then
     if exists(select 1 from public.addons where id = line.addon_id) then
      perform public.revert_addon(line.id);
      steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject);
     end if;
    elsif line.action in ('addon.update', 'addon.revert') then
					-- One revert per addon, to before the account first touched it. An addon the
					-- account itself posted or imported in this time is dealt with as a whole below.
					select min(id) into first_edit
					from public.activity_log
					where actor = target and at >= since and addon_id = line.addon_id
						and action in ('addon.update', 'addon.revert');
					if line.id = first_edit
						and exists (select 1 from public.addons where id = line.addon_id)
						and not exists (
							select 1 from public.activity_log
							where actor = target and at >= since and addon_id = line.addon_id
								and action in ('addon.create', 'import.approve')
						)
						-- Nothing to do when it already reads as it did before that edit.
						and exists (
							select 1
							from public.addons a, jsonb_each(line.details -> 'before') b
							where a.id = line.addon_id
								and b.key in ('name', 'description', 'category', 'author', 'versions', 'images')
								and to_jsonb(a) -> b.key is distinct from b.value
						) then
						select count(*) into later
						from public.activity_log
						where addon_id = line.addon_id and id > first_edit and actor is distinct from target
							and action in ('addon.update', 'addon.revert');
						perform public.revert_addon(line.id);
						steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject, 'others', later);
					end if;

				elsif line.action = 'import.approve' then
					if exists (select 1 from public.addons where id = line.addon_id) then
						perform set_config('app.doing', 'rollback', true);
						if exists(select 1 from public.addons where id = line.addon_id and shared) then
        perform public.remove_contributor_links(line.addon_id, target);
        steps := steps || jsonb_build_object('kind', 'revert', 'subject', line.subject);
       elsif exists (select 1 from public.import_queue where addon_id = line.addon_id and status = 'approved') then
							perform public.unapprove_import(line.addon_id);
							steps := steps || jsonb_build_object('kind', 'unapprove', 'subject', line.subject);
						else
							delete from public.addons where id = line.addon_id;
							steps := steps || jsonb_build_object('kind', 'delete', 'subject', line.subject);
						end if;
					end if;

				elsif line.action = 'addon.create' then
					if exists (select 1 from public.addons where id = line.addon_id) then
						perform set_config('app.doing', 'rollback', true);
						if exists(select 1 from public.addons where id = line.addon_id and shared) then
       perform public.remove_contributor_links(line.addon_id, target);
      else delete from public.addons where id = line.addon_id;
      end if;
      steps := steps || jsonb_build_object('kind', 'delete', 'subject', line.subject);
					end if;

				elsif line.action = 'import.reject' then
					select id into found_id
					from public.import_queue
					where url = line.details ->> 'url' and status = 'rejected';
					if found_id is not null then
						perform public.decide_imports(array[found_id], 'pending');
						steps := steps || jsonb_build_object('kind', 'requeue', 'subject', line.subject);
					end if;

				elsif line.action in ('group.add', 'group.remove', 'group.main', 'group.undo') then
					if jsonb_array_length(coalesce(line.details -> 'groups_before', '[]')) > 0
						and not exists (
							select 1 from public.activity_log u
							where u.action = 'group.undo' and (u.details ->> 'undid')::bigint = line.id
						) then
						perform set_config('app.doing', 'rollback', true);
						perform public.undo_grouping(line.id);
						steps := steps || jsonb_build_object('kind', 'ungroup', 'subject', line.subject);
					end if;

				elsif line.action = 'user.ban' then
					select id into found_user from public.profiles where username = line.subject and banned;
					if found_user is not null then
						perform public.set_banned(found_user, false);
						steps := steps || jsonb_build_object('kind', 'unban', 'subject', line.subject);
					end if;

				elsif line.action = 'group.suggest' then
					delete from public.group_suggestions s
					using public.addons t
					where s.suggested_by = target and s.kind = 'user' and s.status = 'pending'
						and s.addon_id = line.addon_id
						and t.id = s.target_id and t.name = line.details ->> 'target';
					if found then
						steps := steps || jsonb_build_object('kind', 'withdraw', 'subject', line.subject || ' as a version of ' || (line.details ->> 'target'));
					end if;

				elsif line.action = 'report.create' then
					select id into found_id
					from public.reports
					where reported_by = target and addon_id = line.addon_id and status = 'open';
					if found_id is not null then
						perform public.decide_report(found_id, 'dismissed');
						steps := steps || jsonb_build_object('kind', 'dismiss', 'subject', line.subject);
					end if;
				end if;
			exception when others then
				skipped := skipped || jsonb_build_object('action', line.action, 'subject', line.subject, 'why', sqlerrm);
			end;
		end loop;
		perform set_config('app.doing', '', true);

		if preview then
			-- Takes back everything done in this block; what was noted down stays.
			raise exception 'preview only' using errcode = 'RBACK';
		end if;
		perform public.log_action(
			'user.rollback',
			who,
			null,
			jsonb_build_object('since', since, 'steps', jsonb_array_length(steps), 'skipped', jsonb_array_length(skipped))
		);
	exception when sqlstate 'RBACK' then
		null;
	end;

	return jsonb_build_object('steps', steps, 'skipped', skipped);
end;
$$;
create function public.sync_addon_contributions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 delete from public.addon_link_contributions c where c.addon_id = new.id
  and not exists(select 1 from jsonb_array_elements(new.versions) v where v ->> 'url' = c.url);
 insert into public.addon_link_contributions
 select v ->> 'url', new.id, auth.uid() from jsonb_array_elements(new.versions) v
 on conflict(url) do nothing;
 insert into public.addon_contributors select new.id, auth.uid() where auth.uid() is not null on conflict do nothing;
 return null;
end;
$$;
revoke all on function public.sync_addon_contributions() from public, anon, authenticated, service_role;
create trigger addons_zz_contributions after insert or update on public.addons for each row execute function public.sync_addon_contributions();

create function public.merge_addon_links(source_id bigint, target_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.addons; t public.addons;
begin
 if source_id = target_id then raise exception 'Pick two different addons.'; end if;
 perform id from public.addons where id in(source_id, target_id) order by id for update;
 select * into s from public.addons where id = source_id;
 select * into t from public.addons where id = target_id;
 if s.id is null or t.id is null then raise exception 'An addon no longer exists.'; end if;
 insert into public.addon_contributors select target_id, user_id from public.addon_contributors where addon_id = source_id on conflict do nothing;
 update public.addon_link_contributions set addon_id = target_id where addon_id = source_id;
 update public.import_queue set addon_id = target_id where addon_id = source_id;
 delete from public.addons where id = source_id;
 update public.addons set versions = versions || s.versions, aliases = aliases || s.slug || s.aliases,
  group_id = null, is_main = false where id = target_id;
end;
$$;
revoke all on function public.merge_addon_links(bigint, bigint) from public, anon, authenticated, service_role;
create or replace function public.merge_addons(source_id bigint, target_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can merge addons.'; end if;
 perform public.merge_addon_links(source_id, target_id);
end;
$$;

-- Existing groups choose their former main page; same-name entries keep the oldest.
-- Removed rows are preserved by the existing trash/audit triggers, including their text.
do $$
declare g record; s record; target bigint;
begin
 for g in select distinct group_id from public.addons where group_id is not null loop
  select id into target from public.addons where group_id = g.group_id order by is_main desc, created_at, id limit 1;
  for s in select id from public.addons where group_id = g.group_id and id <> target order by id loop
   perform public.merge_addon_links(s.id, target);
  end loop;
 end loop;
 for g in select public.addon_name_key(name) as key from public.addons group by 1 having count(*) > 1 loop
  select id into target from public.addons where public.addon_name_key(name) = g.key order by created_at, id limit 1;
  for s in select id from public.addons where public.addon_name_key(name) = g.key and id <> target order by id loop
   perform public.merge_addon_links(s.id, target);
  end loop;
 end loop;
end;
$$;
create unique index addons_canonical_name on public.addons(public.addon_name_key(name)) where not separate_name;
create trigger addons_ab_name_claim before insert or update of name, separate_name on public.addons for each row execute function public.addons_name_claim();
-- Converts existing multi-link entries too, without inventing code dates.
update public.addons set versions = versions;

-- Requeue only the imported link when its destination is now a shared page.
create or replace function public.unapprove_import(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.import_queue; a public.addons;
begin
 if not public.is_admin() then raise exception 'Only admins can review imports.'; end if;
 select * into q from public.import_queue where addon_id = target and status = 'approved' order by decided_at desc, id desc limit 1;
 if q.id is null then raise exception 'That addon did not come from the import queue.'; end if;
 select * into a from public.addons where id = target for update;
 if jsonb_array_length(a.versions) > 1 then
  update public.addons set versions = (select jsonb_agg(v) from jsonb_array_elements(versions) v where public.link_key(v ->> 'url') <> q.key) where id = target;
 else delete from public.addons where id = target;
 end if;
 update public.import_queue set status = 'pending', decided_by = null, decided_at = null, addon_id = null, problem = null where id = q.id;
 perform public.log_action('import.requeue', q.name, null, jsonb_build_object('url', q.url));
end;
$$;
notify pgrst, 'reload schema';

-- Direct legacy admin inserts can create ownerless shared entries too.
drop policy "signed-in users can post" on public.addons;
create policy "signed-in users can post" on public.addons for insert to authenticated
 with check ((owner = auth.uid() and not public.is_banned()) or public.is_admin());

create function public.remove_contributor_links(target_id bigint, contributor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare kept jsonb;
begin
 select jsonb_agg(v) into kept from public.addons a, jsonb_array_elements(a.versions) v
 where a.id = target_id and not exists(select 1 from public.addon_link_contributions c where c.url = v ->> 'url' and c.submitted_by = contributor);
 update public.import_queue set status = 'pending', decided_by = null, decided_at = null, addon_id = null, problem = null
 where addon_id = target_id and decided_by = contributor and status = 'approved';
 if kept is null then delete from public.addons where id = target_id;
 else update public.addons set versions = kept where id = target_id;
 end if;
end;
$$;
revoke all on function public.remove_contributor_links(bigint, uuid) from public, anon, authenticated, service_role;

create or replace function public.nightly_tidy(token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	trimmed integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can tidy up.';
	end if;
	update public.activity_log
	set details = details - 'before' - 'after' - 'added_links' - 'removed_links'
	where at < now() - interval '90 days'
		and action in ('addon.update', 'addon.revert')
		and details ? 'before';
	get diagnostics trimmed = row_count;
	delete from public.addon_trash where deleted_at < now() - interval '90 days';
	delete from public.left_posts where posted_at < now() - interval '1 day';
	return trimmed;
end;
$$;
