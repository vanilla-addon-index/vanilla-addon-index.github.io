create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org', 'gitea.com',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co', 'octowow.st/git'
		]
	end;
$$;

update public.import_queue
set readme_checked_at = null
where status = 'pending' and images = '{}' and readme_checked_at is not null
	and url ~* '^https://(www\.)?gitea\.com/';

notify pgrst, 'reload schema';
