-- One-off, for a database that was set up before posters could follow their own group
-- suggestions. A database built from the other files as they are now does not need this.

drop policy if exists "admins read group suggestions" on public.group_suggestions;
drop policy if exists "admins and the suggester read group suggestions" on public.group_suggestions;
create policy "admins and the suggester read group suggestions" on public.group_suggestions for select to authenticated
	using (public.is_admin() or suggested_by = auth.uid());
