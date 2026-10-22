-- README screenshots on OctoWoW were resolved correctly but discarded by the
-- screenshot host filter. Keep the client and database allowlists aligned.
create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co', 'octowow.st/git'
		]
	end;
$$;

-- Retry affected pending entries on the next Nightly. Cached README text can be
-- reused: only the image allowlist changed. Preserve screenshots and decisions.
update public.import_queue
set readme_checked_at = null
where status = 'pending' and images = '{}' and readme_checked_at is not null
	and url like 'https://octowow.st/git/%';

notify pgrst, 'reload schema';
