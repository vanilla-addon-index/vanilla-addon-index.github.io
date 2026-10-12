-- An addon can list up to 10 links: the main one, and mirrors of the same code. The
-- site's form has no way to add a mirror, but anyone with an account could send more
-- links to the database directly, and a link listed under one addon cannot be posted or
-- imported as another. So a member could list other people's repositories as "mirrors"
-- of a throwaway addon, nine at a time, and keep them out of the list.
--
-- Only an admin can add a mirror now. Someone who is not one:
--   * posts an addon with one link
--   * can change that link, remove mirrors an addon already has and put them in another
--     order, but cannot bring in a link the addon did not have, other than as its main one
--
-- Posting somebody else's addon under its own link is still open to everyone: that is
-- what the list is for, and what reports and admins are there to put right.
create or replace function public.addons_links_member() returns trigger
language plpgsql set search_path = '' as $$
declare
	main_key text := public.link_key(new.versions -> 0 ->> 'url');
begin
	-- The database's own work (auth.uid() is empty), an admin, and a restore from the trash.
	if auth.uid() is null or public.is_admin() or public.doing('restore') then
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

-- Named to run after addons_links, which has checked the links and made their keys by then.
drop trigger if exists addons_links_member on public.addons;
create trigger addons_links_member
	before insert or update on public.addons
	for each row execute function public.addons_links_member();
