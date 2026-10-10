-- One-off, for a database that was set up before the Users tab showed how each account
-- logs in. A database built from the other files as they are now does not need this.

drop function if exists public.list_users(text);
create function public.list_users(search text)
returns table (id uuid, username text, joined timestamptz, banned boolean, role text, addons bigint, providers text[])
language sql stable security definer set search_path = '' as $$
	select
		p.id,
		p.username,
		p.created_at,
		p.banned,
		case when p.is_owner then 'owner' when public.is_staff(p.id) then 'admin' else 'member' end,
		(select count(*) from public.addons a where a.owner = p.id),
		-- What the account logs in with: 'github', 'discord', or both once linked.
		coalesce((select array_agg(i.provider order by i.provider) from auth.identities i where i.user_id = p.id), '{}')
	from public.profiles p
	where public.is_admin()
		and (coalesce(search, '') = '' or p.username ilike '%' || search || '%')
	order by public.is_staff(p.id) desc, p.username
	limit 200;
$$;

revoke all on function public.list_users(text) from public, anon;
grant execute on function public.list_users(text) to authenticated;
