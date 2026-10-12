-- The nightly job reads the game version an addon is for from its .toc file. It was given
-- only the key of each link, which leaves the branch out, so it read the file on the
-- repository's main branch: an addon kept on a branch of its own, such as a "Vanilla-Port"
-- next to a version for a later client, was reported as made for that later client.
--
-- The job is now given each link as it was written, with its key, and reads the .toc
-- from the branch and folder the link points to. Replaces nightly_repos(text) in the
-- nightly token migration, which returned the keys alone.
create or replace function public.nightly_links(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can list the repositories to check.';
	end if;
	return (
		select coalesce(jsonb_agg(jsonb_build_object('key', l.key, 'url', l.url) order by l.key, l.url), '[]')
		from (
			select q.key, q.url from public.import_queue q where q.status = 'pending'
			union
			select public.link_key(v ->> 'url'), v ->> 'url'
			from public.addons a, jsonb_array_elements(a.versions) v
		) l
	);
end;
$$;

revoke all on function public.nightly_links(text) from public, authenticated, service_role;
grant execute on function public.nightly_links(text) to anon;
drop function if exists public.nightly_repos(text);
