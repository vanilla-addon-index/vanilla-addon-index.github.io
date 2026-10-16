-- Personal bookmarks never enter the public addon snapshot.
create table public.addon_favorites (
	user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
	addon_id bigint not null references public.addons(id) on delete cascade,
	primary key (user_id, addon_id)
);
alter table public.addon_favorites enable row level security;
revoke all on public.addon_favorites from public, anon, authenticated, service_role;
grant select, insert, delete on public.addon_favorites to authenticated;
create policy favorites_read on public.addon_favorites for select to authenticated
	using (user_id = (select auth.uid()));
create policy favorites_add on public.addon_favorites for insert to authenticated
	with check (user_id = (select auth.uid()));
create policy favorites_remove on public.addon_favorites for delete to authenticated
	using (user_id = (select auth.uid()));
create index addon_favorites_addon on public.addon_favorites(addon_id);
