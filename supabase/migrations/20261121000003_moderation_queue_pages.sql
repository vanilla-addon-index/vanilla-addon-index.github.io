-- Keep the same oldest-first ordering as the review screens. Fetch one extra
-- row so the browser can tell if there is another page without a count query.
create index reports_open_page_idx on public.reports (id) where status = 'open';
create index addon_edit_requests_pending_page_idx on public.addon_edit_requests (id) where status = 'pending';
create index addon_link_requests_pending_page_idx on public.addon_link_requests (id) where status = 'pending';

create function public.moderation_queue_page(queue text, after_id bigint default 0,
 search text default '', include_report_counts boolean default false) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
 term text := lower(btrim(coalesce(search, '')));
 rows jsonb;
 report_counts jsonb;
begin
 if not public.is_admin() then raise exception 'Only admins can read moderation queues.' using errcode = '42501'; end if;

 case queue
 when 'reports' then
  select jsonb_agg(to_jsonb(p) order by p.id) into rows from (
   select r.id, r.addon_id, r.reason, r.note, r.reported_by_name, r.created_at
   from public.reports r left join public.addons a on term <> '' and a.id = r.addon_id
   where r.status = 'open' and r.id > after_id
    and (term = '' or strpos(lower(concat_ws(' ', a.name, r.reported_by_name,
     case r.reason
      when 'broken' then 'The link is dead or broken'
      when 'wrong-client' then 'Not an addon for 1.12'
      when 'duplicate' then 'Already listed under another entry'
      when 'harmful' then 'Harmful or malicious'
      when 'other' then 'Something else'
     end, r.note)), term) > 0)
   order by r.id limit 51
  ) p;
  if include_report_counts then
   select coalesce(jsonb_object_agg(t.reason, t.total), '{}') into report_counts
   from (select reason, count(*) as total from public.reports where status = 'open' group by reason) t;
  end if;
 when 'edits' then
  select jsonb_agg(to_jsonb(p) order by p.id) into rows from (
   select r.id, r.addon_id, r.base, r.changes, r.status, jsonb_build_object('username', u.username) as proposer
   from public.addon_edit_requests r
   left join public.profiles u on u.id = r.proposed_by
   left join public.addons a on term <> '' and a.id = r.addon_id
   where r.status = 'pending' and r.id > after_id
    and (term = '' or strpos(lower(concat_ws(' ', a.name, u.username, (
     select string_agg(case f.field
      when 'name' then 'Name'
      when 'description' then 'Description'
      when 'entry_type' then 'Type'
      when 'category' then 'Category'
      when 'author' then 'Author'
      when 'images' then 'Screenshots'
      when 'versions' then 'Download links'
     end, ' ' order by length(f.field), f.field)
     from jsonb_object_keys(r.changes) f(field)
    ))), term) > 0)
   order by r.id limit 51
  ) p;
 when 'links' then
  select jsonb_agg(to_jsonb(p) order by p.id) into rows from (
   select r.id, r.addon_id, r.url, r.images, jsonb_build_object('username', u.username) as proposer
   from public.addon_link_requests r
   left join public.profiles u on u.id = r.proposed_by
   left join public.addons a on term <> '' and a.id = r.addon_id
   where r.status = 'pending' and r.id > after_id
    and (term = '' or strpos(lower(concat_ws(' ', a.name, r.url, u.username)), term) > 0)
   order by r.id limit 51
  ) p;
 else
  raise exception 'Unknown moderation queue.' using errcode = '22023';
 end case;

 return jsonb_build_object('rows', coalesce(rows, '[]'), 'report_counts', report_counts);
end;
$$;

revoke all on function public.moderation_queue_page(text,bigint,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.moderation_queue_page(text,bigint,text,boolean) to authenticated;
notify pgrst, 'reload schema';
