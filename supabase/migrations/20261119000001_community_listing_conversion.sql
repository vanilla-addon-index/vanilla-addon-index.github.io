-- Staff can correct their own accidental personal submissions.
create function public.make_community_listing(target bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare entry public.addons; previous_context text := current_setting('app.doing', true);
begin
 if not public.is_admin() then raise exception 'Only admins can make community listings.' using errcode = '42501'; end if;
 select * into entry from public.addons where id = target for update;
 if not found then raise exception 'That addon no longer exists.'; end if;
 if entry.owner is null then return; end if;
 if entry.owner is distinct from auth.uid() then raise exception 'You can only make your own posts community listings.' using errcode = '42501'; end if;
 perform set_config('app.doing', 'leave', true);
 update public.addons set owner = null where id = target;
 perform set_config('app.doing', coalesce(previous_context, ''), true);
 insert into public.activity_log(actor, actor_name, action, subject, addon_id, details)
 values(auth.uid(), (select username from public.profiles where id = auth.uid()),
  'addon.community', entry.name, target, jsonb_build_object('previous_owner', entry.owner));
end;
$$;
revoke all on function public.make_community_listing(bigint) from public, anon;
grant execute on function public.make_community_listing(bigint) to authenticated;
