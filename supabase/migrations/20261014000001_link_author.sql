-- An imported addon is credited to whoever owns its repository. Until now only a GitHub
-- link was read for that, so an entry kept on GitLab or any other allowed site was
-- published with no author, though its link names one just the same.
--
-- link_author() reads the owner from a link on every site whose links are
-- host/owner/repository:
--   https://github.com/shagu/pfQuest             -> shagu
--   https://gitlab.com/Artur91425/Automaton      -> Artur91425
--   https://gitlab.com/group/sub/addon           -> group
--   https://octowow.st/git/ShempError/Bulwark    -> ShempError   (repositories are under /git)
--   https://example.com/addons/thing.zip         -> ''           (some other site)
--   https://github.com/someone                   -> ''           (no repository)
-- linkAuthor() in src/lib/links.ts has the same rules, and a test compares the two.

create function public.link_author(url text) returns text
language sql immutable set search_path = '' as $$
	with link as (
		select regexp_match(btrim(url), '^(?:https?://)?(?:www\.)?([^/?#]+)/([^?#]*)', 'i') as m
	),
	parts as (
		select lower(m[1]) as host, array_remove(string_to_array(m[2], '/'), '') as path from link
	),
	owned as (
		select host,
			case
				when host <> 'octowow.st' then path
				when lower(path[1]) = 'git' then path[2:]
				else '{}'::text[]
			end as path
		from parts
	)
	select coalesce(
		(
			select path[1] from owned
			where host in ('github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'gitea.com', 'octowow.st')
				and cardinality(path) >= 2
		),
		''
	);
$$;

-- The same function as before, but for where the author comes from.
create or replace function public.approve_imports(ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	q public.import_queue;
	made bigint;
	published integer := 0;
begin
	if not public.is_admin() then
		raise exception 'Only admins can approve imports.';
	end if;

	for q in select * from public.import_queue where id = any (ids) and status = 'pending' order by id loop
		begin
			-- The address is made from the name by the database; see the slugs migration.
			insert into public.addons (name, description, category, author, versions, images, source)
			values (
				left(q.name, 60),
				btrim(q.description),
				q.category,
				public.link_author(q.url),
				jsonb_build_array(jsonb_build_object('url', q.url, 'note', '')),
				q.images[1:5],
				'Turtle WoW Wiki'
			)
			returning id into made;

			update public.import_queue
			set status = 'approved', decided_by = auth.uid(), decided_at = now(), addon_id = made, problem = null
			where id = q.id;
			perform public.join_import_group(q.id, made);
			published := published + 1;
		exception when others then
			update public.import_queue set problem = sqlerrm where id = q.id;
		end;
	end loop;

	return published;
end;
$$;
