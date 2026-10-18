-- Remember the authority of the rejection even if account roles later change.
alter table public.import_queue add column rejected_by_owner boolean not null default false;
update public.import_queue q set rejected_by_owner = true
from public.profiles p where q.status = 'rejected' and q.decided_by = p.id and p.is_owner;

create function public.protect_owner_import_rejection() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if old.status = 'rejected' and old.rejected_by_owner
    and new.status = 'pending' and not public.is_owner() then
  raise exception 'Only the owner can put an import rejected by the owner back in the queue.';
 end if;
 if new.status = 'rejected' and old.status <> 'rejected' then
  new.rejected_by_owner := public.is_owner();
 elsif new.status <> 'rejected' then
  new.rejected_by_owner := false;
 else
  new.rejected_by_owner := old.rejected_by_owner;
 end if;
 return new;
end;
$$;
create trigger protect_owner_import_rejection before update on public.import_queue
for each row execute function public.protect_owner_import_rejection();
notify pgrst, 'reload schema';
