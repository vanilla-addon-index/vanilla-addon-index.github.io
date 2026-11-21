export const adminDemoSql = String.raw`
-- Local preview fixtures. Run through scripts/local.mjs so the target is the local Docker database.
do $demo$
declare
 demo_source constant text := 'Local admin demo';
 repo_root constant text := 'https://github.com/vanilla-index-demo-fixtures/';
 admin_id uuid;
 member_id uuid;
 member2_id uuid;
 closed_report bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(demo_source, 0));
 select p.id into strict admin_id from public.profiles p join auth.users u on u.id = p.id
  where p.username = 'admin' and u.email = 'admin@local.test' and p.is_admin;

 -- A typed DLL has no category to fill in, so it can be approved as queued.
 -- Seed this separately so existing preview databases get it too.
 with ready as (
  insert into public.import_queue (key, url, name, description, category, entry_type, source)
  values (public.link_key(repo_root || 'window-focus-guard'), repo_root || 'window-focus-guard',
   'Window Focus Guard', 'A small 1.12 client mod that releases captured keyboard input when the game window loses focus.',
   'DLL', 'dll', 'Discord')
  on conflict (key) do nothing
  returning key
 )
 insert into public.repo_stats (key, stars, pushed_at, archived, missing, interface, canonical)
 select key, 21, now() - interval '18 days', false, false, 11200, key from ready
 on conflict (key) do nothing;

 -- Approved and rejected imports retain their keys, so rerunning does not reopen work.
 if exists (select 1 from public.import_queue where key = public.link_key(repo_root || 'starlight-frames')) then
  return;
 end if;

 select p.id into strict member_id from public.profiles p join auth.users u on u.id = p.id
  where p.username = 'member' and u.email = 'member@local.test';
 select p.id into strict member2_id from public.profiles p join auth.users u on u.id = p.id
  where p.username = 'member2' and u.email = 'member2@local.test';

 insert into public.addons (name, description, category, author, versions, shared, source, owner, created_at)
 select f.name, f.description, f.category, f.author,
  jsonb_build_array(jsonb_build_object('url', repo_root || f.repo, 'note', ''))
   || case when f.shared then jsonb_build_array(jsonb_build_object('url', repo_root || f.repo || '-community', 'note', 'Community fork')) else '[]'::jsonb end,
  f.shared, demo_source, case when f.author = 'Mira' then member_id else member2_id end, now() - interval '12 days'
 from (values
  ('Pack Ledger', 'pack-ledger', 'Bags & Inventory', 'Mira', true, 'Browse your bags and bank in one searchable window. Optional tags flag items reserved for professions.'),
  ('Trailkeepers', 'trailkeepers', 'Map & Minimap', 'Cedar', true, 'Save gathering routes and show their waypoints on the world map. Routes stay local to your character.'),
  ('Raid Signals', 'raid-signals', 'Raid & Party', 'Mira', true, 'Track ready checks, interrupts, and raid assignments in a compact panel.'),
  ('Quiet Chat', 'quiet-chat', 'Chat & Social', 'Cedar', true, 'Filter repeated trade messages and keep independent chat history for each character.'),
  ('Vendor Notebook', 'vendor-notebook', 'Auction & Economy', 'Mira', false, 'Keep a searchable history of vendor prices, with a list of items to buy on your next trip.'),
  ('Aura Postcards', 'aura-postcards', 'Buffs & Debuffs', 'Cedar', false, 'Move buff icons into groups and highlight effects that are about to expire.'),
  ('Quest Lantern Classic', 'quest-lantern-classic', 'Quests & Leveling', 'Mira', false, 'An older quest tracker saved in the demo trash for restore and history previews.'),
  ('Old Flight Timer', 'old-flight-timer', 'Map & Minimap', 'Cedar', false, 'An archived flight path timer for the original client.')
 ) as f(name, repo, category, author, shared, description);

 -- Shared listings have no owner. Give their links and proposals a contributor.
 insert into public.addon_link_contributions (url, addon_id, submitted_by)
 select v.item ->> 'url', a.id,
  case when (a.author = 'Mira') = (v.position = 1) then member_id else member2_id end
 from public.addons a cross join lateral jsonb_array_elements(a.versions) with ordinality v(item, position)
 where a.source = demo_source and a.shared
 on conflict (url) do update set submitted_by = excluded.submitted_by
  where addon_link_contributions.addon_id = excluded.addon_id;

 insert into public.addon_contributors (addon_id, user_id)
 select distinct c.addon_id, c.submitted_by
 from public.addon_link_contributions c join public.addons a on a.id = c.addon_id
 where a.source = demo_source and a.shared and c.submitted_by is not null
 on conflict do nothing;

 insert into public.reports (addon_id, reason, note, reported_by, reported_by_name, created_at)
 select a.id, f.reason, f.note, case when f.reporter = 'member' then member_id else member2_id end, f.reporter,
  now() - make_interval(days => f.days)
 from (values
  ('Pack Ledger', 'broken', 'The first download link returns a 404. The community fork still loads.', 'member2', 6),
  ('Trailkeepers', 'wrong-client', 'The latest release lists Retail in its TOC file. The 1.12 tag may still be usable.', 'member', 5),
  ('Raid Signals', 'duplicate', 'This looks like the same addon as Raid Helper. The interrupt tracker and screenshots match.', 'member2', 4),
  ('Quiet Chat', 'other', 'Trade chat is filtered, but the description says the addon also handles whispers. Could the listing clarify that?', 'member', 3),
  ('Vendor Notebook', 'harmful', 'The download now points to an installer instead of a ZIP. Please verify what the repository is distributing.', 'member2', 2),
  ('Aura Postcards', 'broken', '', 'member', 2),
  ('Quiet Chat', 'broken', 'The project moved and its old releases page stopped redirecting.', 'member2', 7)
 ) as f(name, reason, note, reporter, days)
 join public.addons a on a.name = f.name and a.source = demo_source;

 -- Capture the actual page values so each proposal can be approved. One older
 -- description deliberately conflicts, so partial approval can also be previewed.
 insert into public.addon_edit_requests (addon_id, proposed_by, base, changes, created_at, updated_at)
 select a.id, case when a.author = 'Mira' then member_id else member2_id end, prior.base || f.conflict, f.changes, now() - interval '3 days', now() - interval '3 days'
 from (values
  ('Pack Ledger', '{"description":"Search bags and bank from one window. Tag crafting materials, filter duplicates, and jump to the bag slot that contains an item."}'::jsonb, '{}'::jsonb),
  ('Trailkeepers', '{"description":"Record gathering routes, import shared waypoint lists, and switch between map overlays without losing the current route.","author":"Cedar & Juniper"}'::jsonb, '{}'::jsonb),
  ('Raid Signals', '{"name":"Raid Signals Tracker","description":"Track interrupts, ready checks, and cooldown assignments across raids and parties."}'::jsonb, '{"description":"Tracks raid ready checks."}'::jsonb),
  ('Quiet Chat', '{"category":"UI & Appearance"}'::jsonb, '{}'::jsonb)
 ) as f(name, changes, conflict)
 join public.addons a on a.name = f.name and a.source = demo_source
 cross join lateral (
  select jsonb_object_agg(field, to_jsonb(a) -> field) as base from jsonb_object_keys(f.changes) as keys(field)
 ) prior;

 insert into public.addon_link_requests (addon_id, proposed_by, url, key, created_at)
 select a.id, case when a.author = 'Mira' then member2_id else member_id end,
  repo_root || f.repo, public.link_key(repo_root || f.repo), now() - interval '2 days'
 from (values
  ('Pack Ledger', 'pack-ledger-vanilla-backport'),
  ('Trailkeepers', 'trailkeepers-waypoints-fork'),
  ('Vendor Notebook', 'vendor-notebook-1.12')
 ) as f(name, repo)
 join public.addons a on a.name = f.name and a.source = demo_source;

 insert into public.import_queue (key, url, name, description, category, entry_type, source, status, decided_by, decided_at, created_at)
 select public.link_key(repo_root || f.repo), repo_root || f.repo,
  f.name, f.description, f.category, f.kind, f.source, f.status,
  case when f.status = 'rejected' then admin_id end,
  case when f.status = 'rejected' then now() - interval '4 days' end,
  now() - interval '2 days'
 from (values
  ('starlight-frames', 'Starlight Frames', 'Compact unit frames with clear debuff and low-health indicators.', 'Unit Frames', 'addon', 'Turtle WoW Wiki', 'pending'),
  ('pack-ledger-cleanup', 'Pack Ledger', 'Community version with better item search and sorting.', 'Bags & Inventory', 'addon', 'Discord', 'pending'),
  ('trailkeepers-route-editor', 'Trailkeepers Route Editor', 'Adds route editing and import shortcuts to Trailkeepers.', 'Map & Minimap', 'addon', 'Turtle WoW Wiki', 'pending'),
  ('totem-pulse', 'Totem Pulse', '', 'Class', 'addon', 'Turtle WoW Wiki', 'pending'),
  ('render-notes', 'Render Notes', 'Shows renderer timing and framerate in the client status window.', 'Miscellaneous', 'addon', 'Discord', 'pending'),
  ('retired-mail-tool', 'Parcel Watch', 'An archived mail notification tool.', 'Chat & Social', 'addon', 'Turtle WoW Wiki', 'pending'),
  ('retail-layout', 'Skyline Layout', 'An interface pack for a newer client.', 'UI & Appearance', 'addon', 'Turtle WoW Wiki', 'rejected')
 ) as f(repo, name, description, category, kind, source, status);

 insert into public.repo_stats (key, stars, pushed_at, archived, missing, interface, canonical, fork_of)
 select public.link_key(repo_root || f.repo), f.stars, now() - make_interval(days => f.age),
  f.missing, f.missing, f.client, public.link_key(repo_root || f.repo),
  case when f.repo = 'trailkeepers-route-editor' then public.link_key(repo_root || 'trailkeepers') end
 from (values
  ('starlight-frames', 84, 14, false, 11200),
  ('pack-ledger-cleanup', 37, 5, false, 11200),
  ('trailkeepers-route-editor', 11, 45, false, 11200),
  ('retired-mail-tool', 2, 900, true, null),
  ('retail-layout', 140, 8, false, 110000)
 ) as f(repo, stars, age, missing, client);

 -- Use the real decision and deletion paths so preview rows have working History and Restore actions.
 perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
 select r.id into strict closed_report from public.reports r join public.addons a on a.id = r.addon_id
  where a.source = demo_source and a.name = 'Quiet Chat' and r.reason = 'broken';
 perform public.decide_report(closed_report, 'handled');

 delete from public.addons where source = demo_source and name in ('Quest Lantern Classic', 'Old Flight Timer');
 update public.addon_trash set deleted_at = now() - interval '7 days'
  where addon ->> 'source' = demo_source and name = 'Old Flight Timer';
end
$demo$;
`;
