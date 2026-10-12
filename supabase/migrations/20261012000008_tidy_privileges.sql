-- Two loose ends, neither of which anyone could reach through the API.
--
-- 1. addons_before_update was the one function that did not say which schema it looks
--    names up in. Every other one does.
--
-- 2. The API's roles were given the right to empty a table, and to put triggers on it,
--    on every table made in future, and still held it on a few made so far. Emptying a
--    table is not subject to row-level security; the API has no call for it, so nothing
--    could use the right, but there is no reason for it to be there.
alter function public.addons_before_update() set search_path = '';

alter default privileges for role postgres in schema public
	revoke all on tables from anon, authenticated, service_role;
revoke maintain, references, trigger, truncate on all tables in schema public
	from anon, authenticated, service_role;
