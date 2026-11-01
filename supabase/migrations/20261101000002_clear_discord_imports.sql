-- Reset unreviewed Discord discoveries without changing decisions or other sources.
create function public.clear_pending_discord_imports() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
 if not public.is_owner() or public.is_banned() then
  raise exception 'Only the owner can clear Discord imports.';
 end if;
 delete from public.import_queue where source = 'Discord' and status = 'pending';
 get diagnostics removed = row_count;
 return removed;
end;
$$;
revoke all on function public.clear_pending_discord_imports() from public, anon, authenticated, service_role;
grant execute on function public.clear_pending_discord_imports() to authenticated;
