-- Count only work waiting for review, without classifying the import queue.
create function public.admin_badge_counts() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
 if not public.is_admin() then raise exception 'Only admins can read moderation badge counts.' using errcode = '42501'; end if;
 return jsonb_build_object(
  'imports', (select count(*) from public.import_queue where status = 'pending'),
  'reports', (select count(*) from public.reports where status = 'open'),
  'edits', (select count(*) from public.addon_edit_requests where status = 'pending') +
           (select count(*) from public.addon_link_requests where status = 'pending')
 );
end;
$$;

revoke all on function public.admin_badge_counts() from public, anon, authenticated, service_role;
grant execute on function public.admin_badge_counts() to authenticated;
notify pgrst, 'reload schema';
