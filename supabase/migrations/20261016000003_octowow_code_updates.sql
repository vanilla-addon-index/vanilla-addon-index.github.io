-- OctoWoW history is served below /git, alongside its public repository API.
-- The original code-date constraint predates support for this host.
alter table public.repo_code_updates
	drop constraint repo_code_updates_history_url_check,
	add constraint repo_code_updates_history_url_check check (
		history_url ~ '^https://(github\.com|gitlab\.com|codeberg\.org|gitea\.com)/'
		or history_url ~ '^https://octowow\.st/git/'
	);
