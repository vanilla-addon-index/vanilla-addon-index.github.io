-- Search the full trash and return one bounded page plus exact counts. A scalar
-- JSON result is unaffected by the Data API's maximum number of returned rows.
create index addon_trash_page_idx on public.addon_trash(deleted_at desc, id desc);

create function public.list_trash(search text default '', before_time timestamptz default null, before_id bigint default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare result jsonb;
begin
 if not public.is_admin() then raise exception 'Only admins can read the trash.'; end if;
 if (before_time is null) <> (before_id is null) then raise exception 'Invalid trash cursor.'; end if;
 with matches as materialized (
  select t.id,t.deleted_at from public.addon_trash t
  where strpos(lower(t.name || ' ' || coalesce(t.deleted_by_name,'')),lower(btrim(coalesce(search,'')))) > 0
 ), page as (
  select * from matches where before_id is null or (deleted_at,id) < (before_time,before_id)
  order by deleted_at desc,id desc limit 101
 ), shown as (
  select t.* from page p join public.addon_trash t on t.id = p.id
  order by p.deleted_at desc,p.id desc limit 100
 )
 select jsonb_build_object(
  'items',coalesce((select jsonb_agg(to_jsonb(s) order by deleted_at desc,id desc) from shown s),'[]'::jsonb),
  'total',(select count(*) from public.addon_trash),
  'matching',(select count(*) from matches),
  'more',(select count(*) > 100 from page)
 ) into result;
 return result;
end;
$$;
revoke all on function public.list_trash(text,timestamptz,bigint) from public,anon,service_role;
grant execute on function public.list_trash(text,timestamptz,bigint) to authenticated;

notify pgrst, 'reload schema';
