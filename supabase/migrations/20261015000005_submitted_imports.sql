-- A member can publish a link before its wiki candidate is reviewed. Keep that
-- resolution separate from an admin approval, especially for approval undo.
alter table public.import_queue drop constraint import_queue_status_check;
alter table public.import_queue add constraint import_queue_status_check
	check (status in ('pending', 'approved', 'rejected', 'submitted'));

create function public.resolve_submitted_imports() returns trigger
language plpgsql security definer set search_path = '' as $$
declare resolved record;
begin
	for resolved in
		update public.import_queue q
		set status = 'submitted', addon_id = new.id, decided_by = auth.uid(),
			decided_at = now(), problem = null
		where q.status = 'pending' and q.key = any(new.link_keys)
		returning q.name, q.url
	loop
		-- Admin import publication sets the final status to approved itself.
		-- Its ordinary approval path must not gain a member-submission log entry.
		if auth.uid() is not null and not public.is_admin() then
			perform public.log_action('import.submitted', resolved.name, new.id,
				jsonb_build_object('url', resolved.url));
		end if;
	end loop;
	return null;
end;
$$;
revoke all on function public.resolve_submitted_imports() from public, anon, authenticated, service_role;
create trigger addons_resolve_submitted_imports after insert or update of versions on public.addons
	for each row execute function public.resolve_submitted_imports();

-- Reconcile candidates left waiting by earlier independent submissions. Do not
-- invent a submitting user or change an existing admin decision.
update public.import_queue q
set status = 'submitted', addon_id = a.id, decided_by = null, decided_at = now(), problem = null
from public.addons a
where q.status = 'pending' and q.key = any(a.link_keys);

notify pgrst, 'reload schema';
