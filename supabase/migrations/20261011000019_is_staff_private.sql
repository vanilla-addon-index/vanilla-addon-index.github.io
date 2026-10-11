-- is_staff(uuid) says whether an account is an admin. It is there for the database's own
-- rules (who may ban or roll back whom, and the order of the admins' user list), but it
-- was also open through the API, where anyone could ask it about any account id found in
-- the public list of addons. The site never calls it, so nobody outside needs to.
--
-- The functions that use it run with the database's own rights, and keep working.
revoke all on function public.is_staff(uuid) from public, anon, authenticated, service_role;
