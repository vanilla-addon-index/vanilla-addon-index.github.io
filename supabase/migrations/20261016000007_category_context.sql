-- Extra evidence stays in the admin queue, separate from the published description.
alter table public.import_queue add column category_context jsonb not null default '{}'
	check (jsonb_typeof(category_context) = 'object' and octet_length(category_context::text) <= 65536);

alter function public.nightly_links(text) rename to nightly_links_without_category_context;
revoke all on function public.nightly_links_without_category_context(text) from public, anon, authenticated, service_role;
create function public.nightly_links(token text) returns jsonb
language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(l.item || case when q.id is not null then
		jsonb_build_object('category_item', jsonb_build_object('name', q.name, 'description', q.description,
		'category_context', q.category_context)) else '{}'::jsonb end), '[]'::jsonb)
	from jsonb_array_elements(public.nightly_links_without_category_context(token)) l(item)
	left join public.import_queue q on q.key = l.item->>'key' and q.url = l.item->>'url' and q.status = 'pending';
$$;
revoke all on function public.nightly_links(text) from public, authenticated, service_role;
grant execute on function public.nightly_links(text) to anon;

create function public.store_category_context(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare stored integer;
begin
	if not public.is_nightly(token) then raise exception 'Only the nightly job can store category context.'; end if;
	update public.import_queue q set category_context = q.category_context || i.context
	from jsonb_to_recordset(items) i(key text, context jsonb)
	where q.key = i.key and q.status = 'pending' and jsonb_typeof(i.context) = 'object';
	get diagnostics stored = row_count;
	return stored;
end;
$$;
revoke all on function public.store_category_context(text, jsonb) from public, authenticated, service_role;
grant execute on function public.store_category_context(text, jsonb) to anon;
notify pgrst, 'reload schema';
