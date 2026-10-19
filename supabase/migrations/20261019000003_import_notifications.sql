create or replace function public.nightly_waiting(token text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can ask what is waiting.'; end if;
 return jsonb_build_object(
  'reports',(select count(*) from public.reports where status='open'),
  'suggestions',(select count(*) from public.group_suggestions where status='pending' and kind='user')
   +(select count(*) from public.addon_edit_requests where status='pending'),
  'imports',(select count(*) from public.import_queue where status='pending')
 );
end;
$$;
