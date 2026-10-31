-- Manual History reverts share the ordinary edit budget. The owner remains
-- unlimited for incident recovery; a revert that changes nothing costs nothing.
create or replace function public.addons_edit_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
 hourly integer;
 daily integer;
 in_hour integer;
 in_day integer;
begin
 if auth.uid() is null or public.is_owner() or public.doing('remove_link') then
  return new;
 end if;
 -- Include pinned links and shared status: reverting only this metadata also
 -- writes a full before-image to History and must not bypass the budget.
 if (new.name, new.description, new.category, new.author, new.versions, new.images, new.pinned_link, new.shared)
  is not distinct from (old.name, old.description, old.category, old.author, old.versions, old.images, old.pinned_link, old.shared) then
  return new;
 end if;

 -- Serialize each account's budget check across concurrent requests, including
 -- requests updating different addons. Held until the audit entry is committed.
 perform pg_advisory_xact_lock(hashtextextended('addon-edit-budget:' || auth.uid()::text, 0));
 hourly := case when public.is_admin() then 30 else 10 end;
 daily := case when public.is_admin() then 90 else 30 end;
 select count(*) filter (where at > now() - interval '1 hour'), count(*)
 into in_hour, in_day
 from public.activity_log
 where actor = auth.uid() and action in ('addon.update', 'addon.revert')
  and at > now() - interval '1 day';
 if in_hour >= hourly then
  raise exception 'You can make at most % edits an hour. Try again later.', hourly using errcode = 'LIMIT';
 end if;
 if in_day >= daily then
  raise exception 'You can make at most % edits a day. Try again tomorrow.', daily using errcode = 'LIMIT';
 end if;
 return new;
end;
$$;
