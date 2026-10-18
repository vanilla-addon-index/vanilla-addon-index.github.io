-- Category choices belong to admins reviewing new pages, not the import pipeline.
update public.import_queue set category = '' where status = 'pending';

-- Restore nightly links without the category evidence payload.
drop function public.nightly_links(text);
alter function public.nightly_links_without_category_context(text) rename to nightly_links;
grant execute on function public.nightly_links(text) to anon;
drop function public.store_category_context(text, jsonb);
alter table public.import_queue drop column category_context;
notify pgrst, 'reload schema';
