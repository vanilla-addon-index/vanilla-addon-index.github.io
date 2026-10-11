-- One-off, for a database that was set up while repository stats were readable by anyone.
-- A database built from the other files as they are now does not need this.

drop policy if exists "repo stats are public" on public.repo_stats;
drop policy if exists "admins read repo stats" on public.repo_stats;
create policy "admins read repo stats" on public.repo_stats for select to authenticated
	using (public.is_admin());
revoke select on public.repo_stats from anon;
