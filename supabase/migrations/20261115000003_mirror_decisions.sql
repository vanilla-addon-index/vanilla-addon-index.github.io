-- Mirror decisions are separate from addon versions so attached mirrors stay out of
-- the archive catalogue. Host metadata remains evidence and cannot overwrite a decision.
create table public.addon_mirror_decisions (
 url text primary key,
 addon_id bigint not null references public.addons on delete cascade,
 source text,
 decision text not null check (decision in ('mirror', 'independent', 'removed')),
 check ((decision = 'mirror') = (source is not null))
);
alter table public.addon_mirror_decisions enable row level security;
revoke all on public.addon_mirror_decisions from public, anon, authenticated, service_role;
grant select on public.addon_mirror_decisions to authenticated;
create policy "admins read mirror decisions" on public.addon_mirror_decisions
 for select to authenticated using (public.is_admin());

create function public.addon_mirrors(target bigint) returns table(url text, source text)
language sql stable security definer set search_path = '' as $$
 select d.url,
  (select v->>'url' from jsonb_array_elements(a.versions) v
   where public.mirror_repository_root(v->>'url') = d.source limit 1)
 from public.addon_mirror_decisions d join public.addons a on a.id = d.addon_id
 where d.addon_id = target and d.decision = 'mirror';
$$;
revoke all on function public.addon_mirrors(bigint) from public, service_role;
grant execute on function public.addon_mirrors(bigint) to anon, authenticated;

create function public.decide_addon_mirror(target bigint, mirror_url text, source_url text, choice text, queue_id bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
 a public.addons;
 queued public.import_queue;
 previous public.addon_mirror_decisions;
 mirror_key text := public.mirror_repository_root(mirror_url);
 source_key text := public.mirror_repository_root(source_url);
 retained_url text;
begin
 if not public.is_admin() then raise exception 'Only admins can manage mirrors.'; end if;
 if mirror_key is null or choice is null or choice not in ('mirror','independent','removed')
   or (choice = 'mirror' and (source_key is null or source_key = mirror_key)) then
  raise exception 'Choose a mirror and a different repository source.';
 end if;
 if queue_id is not null then
  select * into queued from public.import_queue where id = queue_id and status = 'pending' for update;
  if queued.id is null or public.mirror_repository_root(queued.url) is distinct from mirror_key then
   raise exception 'That import is no longer pending.';
  end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(mirror_key, 0));
 select * into a from public.addons where id = target for update;
 if a.id is null then raise exception 'The addon is no longer published.'; end if;
 select * into previous from public.addon_mirror_decisions where url = mirror_key;
 if previous.url is not null and previous.addon_id <> target then
  raise exception 'This mirror is managed on another addon page.';
 end if;
 if choice = 'mirror' then
  select v->>'url' into retained_url from jsonb_array_elements(a.versions) v
   where public.mirror_repository_root(v->>'url') = source_key;
  if retained_url is null or exists (
   select 1 from public.repo_stats r where r.key = public.link_key(retained_url) and r.missing
  ) then raise exception 'The exact source must be available on this addon page.'; end if;
  if queued.id is not null and (queued.entry_type <> a.entry_type or not exists (
    select 1 from public.repository_mirrors m where m.url = mirror_key and m.source = source_key
  )) then raise exception 'The source or mirror evidence changed. Refresh this import.'; end if;
  if exists (
   select 1 from public.addons other cross join lateral jsonb_array_elements(other.versions) v
   where other.id <> target and other.link_keys @> array[public.link_key(mirror_key)]
    and public.mirror_repository_root(v->>'url') = mirror_key
  ) then raise exception 'This link is already published on another addon page.'; end if;
  if exists (
   select 1 from public.addon_mirror_decisions d
   where d.addon_id = target and d.source = mirror_key and d.decision = 'mirror'
  ) then raise exception 'Move the mirrors attached to this link before reclassifying it.'; end if;
  if exists (select 1 from jsonb_array_elements(a.versions) v where public.mirror_repository_root(v->>'url') = mirror_key) then
   perform set_config('app.doing', 'remove_link', true);
   update public.addons set versions = (
    select jsonb_agg(v order by n) from jsonb_array_elements(a.versions) with ordinality entries(v,n)
    where public.mirror_repository_root(v->>'url') is distinct from mirror_key
   ), pinned_link = case when public.mirror_repository_root(pinned_link) = mirror_key then retained_url else pinned_link end
   where id = target;
   perform set_config('app.doing', '', true);
  end if;
 elsif choice = 'independent' then
  if previous.url is null then raise exception 'Only an existing mirror can be restored as a version.'; end if;
  perform public.add_addon_link(target, mirror_key);
 elsif previous.url is null then
  raise exception 'Only an existing mirror can be unlinked.';
 end if;
 insert into public.addon_mirror_decisions as d (url, addon_id, source, decision)
 values (mirror_key, target, case when choice = 'mirror' then source_key end, choice)
 on conflict (url) do update set source = excluded.source, decision = excluded.decision;
 update public.import_queue q set status = case when choice = 'removed' then 'rejected' else 'approved' end,
  addon_id = case when choice = 'removed' then null else target end, decided_at = now(), decided_by = auth.uid(), problem = null
  where q.key = public.link_key(mirror_key) and q.status = 'pending';
 perform public.log_action('addon.mirror', a.name, target,
  jsonb_build_object('url', mirror_key, 'source', source_key, 'decision', choice, 'previous', to_jsonb(previous)));
end;
$$;
revoke all on function public.decide_addon_mirror(bigint,text,text,text,bigint) from public, anon, service_role;
grant execute on function public.decide_addon_mirror(bigint,text,text,text,bigint) to authenticated;

create or replace view public.pending_imports with (security_invoker = true) as
select q.id,q.key,q.url,q.name,q.description,q.images,q.alts,q.category,
 q.obsolete,q.parent,q.group_key,q.status,q.problem,q.readme_checked_at,
 q.rejected_by_owner,q.wiki_source,q.wiki_recommended,q.source,q.entry_type,
 m.source as mirror_source, destination.id as mirror_addon_id,
 coalesce(unavailable.missing,false) as mirror_source_unavailable
from public.import_queue q
left join public.addon_mirror_decisions d on d.url = public.mirror_repository_root(q.url)
left join public.repository_mirrors m on m.url = public.mirror_repository_root(q.url) and d.url is null
left join public.repo_stats unavailable on unavailable.key = public.link_key(m.source)
left join lateral (
 select a.id from public.addons a
 where a.entry_type = q.entry_type and not coalesce(unavailable.missing,false)
  and a.link_keys @> array[public.link_key(m.source)]
  and exists (select 1 from jsonb_array_elements(a.versions) v where public.mirror_repository_root(v->>'url') = m.source)
 order by a.id limit 1
) destination on true
where q.status = 'pending';


-- Restore the reviewed cleanup links as secondary links only while their source
-- and declaration still match the original review.
with reviewed(addon_id, mirror, source) as (values
 (173, 'https://octowow.st/git/Bluewhale/ElvUIModernized', 'https://github.com/Bluewhale1337/ElvUIModernized'),
 (208, 'https://octowow.st/git/Bluewhale/HealBotBlue', 'https://github.com/Bluewhale1337/HealBotBlue'),
 (1003, 'https://octowow.st/git/Fayz/AutoSpam', 'https://github.com/TheRealFayz/AutoSpam'),
 (926, 'https://octowow.st/git/Fayz/TimeToDrink', 'https://github.com/TheRealFayz/TimeToDrink'),
 (601, 'https://octowow.st/git/Fayz/TotemNesia', 'https://github.com/TheRealFayz/TotemNesia'),
 (286, 'https://octowow.st/git/Markuru/RecipeRadar', 'https://github.com/MarkuruThunderhoof/RecipeRadar'),
 (834, 'https://octowow.st/git/Meta/MetaHunt', 'https://codeberg.org/Duvelcorp/MetaHunt.git'),
 (183, 'https://octowow.st/git/Mquadrat/FBHealBox', 'https://github.com/QbiXibQ/FBHealBox'),
 (345, 'https://octowow.st/git/Mr_Rosh/ColorPickerPlus', 'https://github.com/mr-rosh/ColorPickerPlus'),
 (227, 'https://octowow.st/git/Mr_Rosh/Lern2Spell', 'https://github.com/mr-rosh/Lern2Spell'),
 (699, 'https://octowow.st/git/Mr_Rosh/pfUI-CustomMedia', 'https://github.com/mr-rosh/pfUI-CustomMedia'),
 (715, 'https://octowow.st/git/brues/SuperCleveRoidMacros', 'https://github.com/brues-code/SuperCleveRoidMacros'),
 (626, 'https://octowow.st/git/brues/TwitchEmotes', 'https://github.com/brues-code/TwitchEmotes'),
 (984, 'https://octowow.st/git/brues/Vanilla_MikScrollingBattleText', 'https://github.com/brues-code/Vanilla_MikScrollingBattleText'),
 (263, 'https://octowow.st/git/brues/pfUI', 'https://github.com/brues-code/pfUI'),
 (136, 'https://octowow.st/git/lightblade/CawDPSMeter', 'https://github.com/NovaElysium/CawDPSMeter'),
 (152, 'https://octowow.st/git/lightblade/CleanRolls', 'https://github.com/lightbladeninja/CleanRolls'),
 (682, 'https://octowow.st/git/lightblade/CombatLedger', 'https://github.com/akzkak/CombatLedger'),
 (400, 'https://octowow.st/git/lightblade/GreedMeter', 'https://github.com/iGreed1993/GreedMeter'),
 (808, 'https://octowow.st/git/lightblade/InstanceJournal', 'https://github.com/Arthur-Helias/InstanceJournal'),
 (847, 'https://octowow.st/git/lightblade/MusicExpanded', 'https://github.com/lightbladeninja/MusicExpanded'),
 (657, 'https://octowow.st/git/lightblade/WeakestAuras', 'https://github.com/fuffc/WeakestAuras'),
 (478, 'https://octowow.st/git/lightblade/pfExtend', 'https://github.com/Cliencer/pfExtend'),
 (262, 'https://octowow.st/git/lightblade/pfQuest', 'https://github.com/rivi-s/pfQuest'),
 (1014, 'https://octowow.st/git/lightblade/pfQuest-HDB-Install', 'https://github.com/rivi-s/pfQuest-HDB-Install'),
 (1035, 'https://octowow.st/git/lightblade/pfQuest-turtle', 'https://github.com/rivi-s/pfQuest-turtle'),
 (1015, 'https://octowow.st/git/lightblade/pfQuest-turtle-HDB-Install', 'https://github.com/rivi-s/pfQuest-turtle-HDB-Install'),
 (762, 'https://octowow.st/git/stealthzi/EquipCompareAdv', 'https://github.com/notforever-ship-it/EquipCompareAdv')
), attached as (
 insert into public.addon_mirror_decisions(url, addon_id, source, decision)
 select m.url, a.id, m.source, 'mirror'
 from reviewed r join public.addons a on a.id = r.addon_id
 join public.repository_mirrors m on m.url = public.mirror_repository_root(r.mirror)
  and m.source = public.mirror_repository_root(r.source)
 join public.import_queue q on q.key = public.link_key(r.mirror) and q.status = 'pending'
 where exists (select 1 from jsonb_array_elements(a.versions) v where v->>'url' = r.source)
  and not exists (select 1 from public.addons other where other.link_keys @> array[public.link_key(r.mirror)])
  and not exists (select 1 from public.repo_stats s where s.key = public.link_key(r.source) and s.missing)
  and exists (select 1 from public.activity_log l, lateral jsonb_array_elements(
    case when jsonb_typeof(l.details->'removed_links') = 'array' then l.details->'removed_links' else '[]'::jsonb end
   ) v where l.addon_id = a.id and v->>'url' = r.mirror)
 on conflict (url) do nothing
 returning url, addon_id
)
update public.import_queue q set status = 'approved', addon_id = attached.addon_id, decided_at = now(), problem = null
from attached where q.key = public.link_key(attached.url) and q.status = 'pending';

notify pgrst, 'reload schema';
