-- Remove an exact download URL and record it as a recoverable link edit.
create function public.delete_addon_link(target bigint, link text) returns void
language plpgsql security definer set search_path = '' as $$
declare
 a public.addons;
 prior_action text := current_setting('app.doing', true);
begin
 if not public.is_admin() then raise exception 'Only admins can delete download links.'; end if;
 select * into a from public.addons where id = target for update;
 if not found then raise exception 'That addon no longer exists.'; end if;
 if not exists (select 1 from jsonb_array_elements(a.versions) v where v->>'url' = link) then
  raise exception 'That link is no longer on this addon.';
 end if;
 if jsonb_array_length(a.versions) = 1 then
  raise exception 'An addon must keep at least one download link.';
 end if;

 perform set_config('app.doing', 'remove_link', true);
 update public.addons set versions = (
  select jsonb_agg(v order by position)
  from jsonb_array_elements(a.versions) with ordinality as versions(v, position)
  where v->>'url' <> link
 ) where id = target;
 perform set_config('app.doing', coalesce(prior_action, ''), true);
end;
$$;
revoke all on function public.delete_addon_link(bigint, text) from public, anon, service_role;
grant execute on function public.delete_addon_link(bigint, text) to authenticated;

notify pgrst, 'reload schema';
