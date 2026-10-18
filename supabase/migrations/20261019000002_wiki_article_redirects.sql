-- Use the resolved article title/description when an old listing redirects to another addon.
drop function public.expand_wiki_article(bigint,jsonb);

create function public.expand_wiki_article(queue_id bigint, links jsonb, article_name text default null, article_description text default null) returns integer
language plpgsql security definer set search_path='' as $$
declare q public.import_queue; entry jsonb; target bigint; made integer:=0; link text;
begin
 if not public.is_admin() then raise exception 'Only admins can expand wiki imports.'; end if;
 select * into q from public.import_queue where id=queue_id and status='pending' for update;
 if q.id is null then raise exception 'That import is no longer pending.'; end if;
 if q.url !~ '^https://turtle-wow[.]fandom[.]com/wiki/' then raise exception 'Expected a wiki article.'; end if;
 if jsonb_typeof(links) is distinct from 'array' then raise exception 'Expected repository links.'; end if;
 if jsonb_array_length(links) not between 1 and 100 then raise exception 'Choose between 1 and 100 repository links.'; end if;
 if article_name is not null and (char_length(btrim(article_name)) not between 2 and 120) then raise exception 'Invalid article title.'; end if;
 if article_description is not null and char_length(article_description)>5000 then raise exception 'Article description is too long.'; end if;
 for entry in select * from jsonb_array_elements(links) loop
  link:=entry->>'url';
  if link is null or link !~ '^https://\S+$' or char_length(link)>300 or not public.host_allowed(link,'link') then raise exception 'Invalid repository link.'; end if;
  select a.id into target from public.addons a where public.link_key(link)=any(a.link_keys) limit 1;
  insert into public.import_queue(key,url,name,description,images,category,status,addon_id,wiki_source,wiki_recommended)
  values(public.link_key(link),link,coalesce(article_name,q.name),coalesce(nullif(article_description,''),q.description),q.images,'',case when target is null then 'pending' else 'approved' end,target,q.url,coalesce((entry->>'recommended')::boolean,false))
  on conflict(key) do update set wiki_source=coalesce(public.import_queue.wiki_source,excluded.wiki_source),
   wiki_recommended=public.import_queue.wiki_recommended or excluded.wiki_recommended;
  made:=made+1;
 end loop;
 update public.import_queue set status='approved',wiki_expanded=true,decided_by=auth.uid(),decided_at=now(),problem=null where id=queue_id;
 return made;
end;
$$;
revoke all on function public.expand_wiki_article(bigint,jsonb,text,text) from public,anon,service_role;
grant execute on function public.expand_wiki_article(bigint,jsonb,text,text) to authenticated;

notify pgrst,'reload schema';
