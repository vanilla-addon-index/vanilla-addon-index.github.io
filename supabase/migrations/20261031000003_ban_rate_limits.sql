-- Bans and unbans share an allowance, including unbans through account rollback.
-- The owner stays unlimited for recovery. Unchanged states spend nothing.
create or replace function public.set_banned(target uuid, value boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
 who text;
 target_is_owner boolean;
 was_banned boolean;
 in_hour integer;
 in_day integer;
begin
 if not public.is_admin() then
  raise exception 'Only admins can ban accounts.';
 end if;
 if target = auth.uid() then
  raise exception 'You cannot ban yourself.';
 end if;
 if value is null then
  raise exception 'Choose whether to ban or unban the account.';
 end if;

 -- Serialize the actor's allowance across requests, even for different members.
 perform pg_advisory_xact_lock(hashtextextended('account-ban-budget:' || auth.uid()::text, 0));
 select username, is_owner, banned into who, target_is_owner, was_banned
 from public.profiles where id = target for update;
 if who is null then
  raise exception 'That account does not exist.';
 end if;
 -- Recheck after waiting for locks: a suspended admin has no moderation powers.
 if not public.is_admin() then
  raise exception 'Only admins can ban accounts.';
 end if;
 if target_is_owner then
  raise exception 'The owner cannot be banned.';
 end if;
 if public.is_staff(target) and not public.is_owner() then
  raise exception 'Only the owner can suspend an admin.';
 end if;
 if was_banned = value then
  return;
 end if;

 if not public.is_owner() then
  select count(*) filter (where at > now() - interval '1 hour'), count(*)
  into in_hour, in_day from public.activity_log
  where actor = auth.uid() and action in ('user.ban', 'user.unban')
   and at > now() - interval '1 day';
  if in_hour >= 5 then
   raise exception 'You can make at most 5 ban or unban changes an hour. Try again later.' using errcode = 'LIMIT';
  end if;
  if in_day >= 15 then
   raise exception 'You can make at most 15 ban or unban changes a day. Try again tomorrow.' using errcode = 'LIMIT';
  end if;
 end if;

 update public.profiles set banned = value where id = target;
 perform public.log_action(case when value then 'user.ban' else 'user.unban' end, who, null, null);
end;
$$;
