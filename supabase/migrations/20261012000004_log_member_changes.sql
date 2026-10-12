-- The nightly job tells the database who the organization's public members are, and those
-- accounts are admins. So whoever holds the job's token can make an account an admin by
-- adding it to that list, and until now nothing showed that it had happened.
--
-- Every account that joins or leaves the list is now written to the log, as the work of
-- the system: a new admin can no longer appear unseen. The line names the account if it
-- has logged in here, and the GitHub id either way. What such an admin can do stays within
-- the limits, in the log and undoable, and the owner can suspend them.
--
-- Replaces the version in the org members migration.
create or replace function public.store_org_members(token text, ids bigint[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	known bigint[];
	change record;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store the organization''s members.';
	end if;
	-- An empty list means the organization has no public members; no list is a mistake.
	if ids is null then
		raise exception 'The list of members is missing.';
	end if;

	select member_ids into known from public.org_cache where id;
	for change in
		select m as github_id, true as joined from unnest(ids) m where not m = any (known)
		union
		select m, false from unnest(known) m where not m = any (ids)
	loop
		insert into public.activity_log (action, subject, details)
		values (
			case when change.joined then 'user.admin' else 'user.unadmin' end,
			coalesce(
				(
					select p.username
					from auth.identities i
					join public.profiles p on p.id = i.user_id
					where i.provider = 'github' and i.provider_id = change.github_id::text
					limit 1
				),
				'GitHub user ' || change.github_id
			),
			jsonb_build_object('github_id', change.github_id)
		);
	end loop;

	update public.org_cache set member_ids = ids, fetched_at = now(), checked_at = now() where id;
	return cardinality(ids);
end;
$$;
