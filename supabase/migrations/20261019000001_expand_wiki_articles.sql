-- Articles become source records; repositories use the ordinary import workflow.
alter table public.import_queue add column wiki_source text;
alter table public.import_queue add column wiki_recommended boolean not null default false;
alter table public.import_queue add column wiki_expanded boolean not null default false;

create function public.expand_wiki_article(queue_id bigint, links jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare q public.import_queue; entry jsonb; target bigint; made integer:=0; link text;
begin
 if not public.is_admin() then raise exception 'Only admins can expand wiki imports.'; end if;
 select * into q from public.import_queue where id=queue_id and status='pending' for update;
 if q.id is null then raise exception 'That import is no longer pending.'; end if;
 if q.url !~ '^https://turtle-wow[.]fandom[.]com/wiki/' then raise exception 'Expected a wiki article.'; end if;
 if jsonb_typeof(links) is distinct from 'array' then raise exception 'Expected repository links.'; end if;
 if jsonb_array_length(links) not between 1 and 100 then raise exception 'Choose between 1 and 100 repository links.'; end if;
 for entry in select * from jsonb_array_elements(links) loop
  link:=entry->>'url';
  if link is null or link !~ '^https://\S+$' or char_length(link)>300 or not public.host_allowed(link,'link') then raise exception 'Invalid repository link.'; end if;
  select a.id into target from public.addons a where public.link_key(link)=any(a.link_keys) limit 1;
  insert into public.import_queue(key,url,name,description,images,category,status,addon_id,wiki_source,wiki_recommended)
  values(public.link_key(link),link,q.name,q.description,q.images,'',case when target is null then 'pending' else 'approved' end,target,q.url,coalesce((entry->>'recommended')::boolean,false))
  on conflict(key) do update set wiki_source=coalesce(public.import_queue.wiki_source,excluded.wiki_source),
   wiki_recommended=public.import_queue.wiki_recommended or excluded.wiki_recommended;
  made:=made+1;
 end loop;
 update public.import_queue set status='approved',wiki_expanded=true,decided_by=auth.uid(),decided_at=now(),problem=null where id=queue_id;
 return made;
end;
$$;
revoke all on function public.expand_wiki_article(bigint,jsonb) from public,anon,service_role;
grant execute on function public.expand_wiki_article(bigint,jsonb) to authenticated;

-- Applies to all normal approval paths, including a recommendation approved last.
create function public.pin_wiki_recommendation() returns trigger
language plpgsql security definer set search_path='' as $$
declare link text;
begin
 if new.status='approved' and new.addon_id is not null and new.wiki_recommended
  and (tg_op='INSERT' or old.status is distinct from new.status or not old.wiki_recommended) then
  select v->>'url' into link from public.addons a,jsonb_array_elements(a.versions) v
   where a.id=new.addon_id and public.link_key(v->>'url')=new.key limit 1;
  if link is not null then update public.addons set pinned_link=link where id=new.addon_id; end if;
 end if;
 return new;
end;
$$;
revoke all on function public.pin_wiki_recommendation() from public,anon,authenticated,service_role;
create trigger pin_wiki_recommendation after insert or update on public.import_queue for each row execute function public.pin_wiki_recommendation();
notify pgrst,'reload schema';
