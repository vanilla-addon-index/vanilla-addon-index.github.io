-- What is waiting for an admin to act on: reports nobody has closed, and suggestions from
-- members that nobody has decided. The nightly job asks, and tells the admins on GitHub
-- when there is something; see .github/workflows/nightly.yml. Only the two numbers leave
-- the database.
--
-- The import queue is not part of it: it is always full, and nobody is waiting on it.
create or replace function public.nightly_waiting(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can ask what is waiting.';
	end if;
	return jsonb_build_object(
		'reports', (select count(*) from public.reports where status = 'open'),
		'suggestions', (select count(*) from public.group_suggestions where status = 'pending' and kind = 'user')
	);
end;
$$;

revoke all on function public.nightly_waiting(text) from public, authenticated, service_role;
grant execute on function public.nightly_waiting(text) to anon;
