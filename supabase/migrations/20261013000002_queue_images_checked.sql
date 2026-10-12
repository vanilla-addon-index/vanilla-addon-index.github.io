-- The screenshots the wiki lists for an entry are links someone pasted years ago, and
-- many no longer load: a fifth of them go through an old GitHub image proxy whose
-- addresses have all stopped working, though the pictures behind them are still there.
-- An entry with such a link showed a broken picture in the review, and because it "had"
-- a screenshot, its README was never read for a working one.
--
-- So every waiting entry is now looked at once, not only those without a screenshot: the
-- nightly job is given the pictures the entry has, keeps the ones that still load, adds
-- what its README shows, and stores the result in place of what was there.

-- Replaces the version in the queue README images migration: every waiting entry that has
-- not been looked at yet is marked, and comes with the pictures it has.
create or replace function public.nightly_links(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can list the repositories to check.';
	end if;
	return (
		select coalesce(
			jsonb_agg(
				jsonb_build_object('key', l.key, 'url', l.url, 'readme', l.readme)
					|| case when l.readme then jsonb_build_object('images', to_jsonb(l.images)) else '{}' end
				order by l.key, l.url
			),
			'[]'
		)
		from (
			select q.key, q.url, q.readme_checked_at is null as readme, q.images
			from public.import_queue q
			where q.status = 'pending'
			union
			select public.link_key(v ->> 'url'), v ->> 'url', false, '{}'
			from public.addons a, jsonb_array_elements(a.versions) v
		) l
	);
end;
$$;

-- Replaces the version in the queue README images migration: the pictures sent take the
-- place of the ones an entry had, once, for an entry that is still waiting and has not
-- been looked at before. Returns how many entries have pictures afterwards.
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
		where q.key = f.key and q.status = 'pending' and q.readme_checked_at is null
		returning (f.images <> '{}') as has
	)
	select count(*) filter (where has) into given from stored;
	return given;
end;
$$;
