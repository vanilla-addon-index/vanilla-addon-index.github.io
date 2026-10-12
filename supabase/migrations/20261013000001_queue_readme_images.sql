-- An entry in the import queue only had the screenshots the wiki lists for it, and the wiki
-- lists one for a quarter of its entries. Most repositories show their own in their README,
-- which nothing looked at: those addons would have been published without a picture.
--
-- The nightly job now reads the README of each waiting entry that has no screenshot and
-- stores the pictures it finds, for the admin to see and weed out in the review like the
-- wiki's own. Each entry's README is read once: the second column below says when.

alter table public.import_queue add column if not exists readme_checked_at timestamptz;

-- Replaces the version in the nightly links migration: each link also says whether its
-- README is still to be read for screenshots.
create or replace function public.nightly_links(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can list the repositories to check.';
	end if;
	return (
		select coalesce(
			jsonb_agg(jsonb_build_object('key', l.key, 'url', l.url, 'readme', l.readme) order by l.key, l.url),
			'[]'
		)
		from (
			select q.key, q.url, (q.images = '{}' and q.readme_checked_at is null) as readme
			from public.import_queue q
			where q.status = 'pending'
			union
			select public.link_key(v ->> 'url'), v ->> 'url', false
			from public.addons a, jsonb_array_elements(a.versions) v
		) l
	);
end;
$$;

-- Stores the screenshots found in the READMEs of waiting entries: [{ "key": …, "images": […] }].
-- An entry that already has screenshots keeps them, and one that is no longer waiting is
-- left alone. An entry with an empty list is only marked as read. Returns how many
-- entries were given pictures.
create or replace function public.store_queue_images(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	given integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store screenshots for the queue.';
	end if;

	with found as (
		select
			i ->> 'key' as key,
			-- At most five, each an https address of a sane length, like an addon's own.
			coalesce(
				(
					select array_agg(image order by place)
					from (
						select image, place
						from jsonb_array_elements_text(coalesce(i -> 'images', '[]')) with ordinality as listed(image, place)
						where image ~ '^https://\S+$' and char_length(image) <= 500
						order by place
						limit 5
					) kept
				),
				'{}'
			) as images
		from jsonb_array_elements(items) i
	),
	stored as (
		update public.import_queue q
		set images = f.images, readme_checked_at = now()
		from found f
		where q.key = f.key and q.status = 'pending' and q.images = '{}'
		returning (f.images <> '{}') as has
	)
	select count(*) filter (where has) into given from stored;
	return given;
end;
$$;

revoke all on function public.store_queue_images(text, jsonb) from public, authenticated, service_role;
grant execute on function public.store_queue_images(text, jsonb) to anon;
