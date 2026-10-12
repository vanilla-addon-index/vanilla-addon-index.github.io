-- Who posted an addon, and which admin approved an import, are no longer readable by
-- visitors. They were only account ids, never names, but they were in the public list:
-- anyone could see which addons one account had posted, and which account ids belong to
-- admins. The site shows neither to a visitor, so a visitor's key should not be able to
-- read them.
--
-- A visitor may now read the columns listed here and no others. A column added to the
-- table later is hidden from visitors until it is granted here too.
revoke select on public.addons from anon;
grant select (
	id, slug, name, description, category, author, versions, repo_url, link_keys, aliases,
	images, source, group_id, is_main, created_at, updated_at
) on public.addons to anon;
