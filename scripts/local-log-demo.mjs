export const logDemoSql = String.raw`
-- Curated audit history against the local Docker database.
do $demo$
declare
 demo_source constant text := 'Local log demo';
 marker constant jsonb := '{"local_demo":"log"}';
 repo_root constant text := 'https://github.com/vanilla-index-demo-fixtures/';
 admin_id uuid;
 owner_id uuid;
 member_id uuid;
 atlas bigint;
 lantern bigint;
 compass bigint;
 overlay bigint;
 archive bigint;
 timeline bigint;
 report_id bigint;
 original_id bigint;
 first_id bigint;
 group_after jsonb;
 other_main jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(demo_source, 0));
 select p.id into strict admin_id from public.profiles p join auth.users u on u.id = p.id
  where p.is_admin and p.username = 'admin' and u.email = 'admin@local.test';
 if exists (select 1 from public.activity_log where details @> marker) then return; end if;
 select id into strict owner_id from public.profiles where username = 'owner' and is_owner;
 select id into strict member_id from public.profiles where username = 'member';
 select coalesce(max(id), 0) into first_id from public.activity_log;

 -- Dedicated pages isolate recovery actions from other preview queues.
 insert into public.addons (name, description, category, author, versions, source, created_at)
 select name, description, category, author, jsonb_build_array(jsonb_build_object('url', repo_root || repo, 'note', '')),
  demo_source, now() - interval '30 days'
 from (values
  ('Route Atlas', 'route-atlas-log', 'Map & Minimap', 'Juniper', 'Browse saved gathering routes and share waypoint lists.'),
  ('Chat Lantern', 'chat-lantern-log', 'Chat & Social', 'Fern', 'Filter trade and party messages with separate rules for each channel.'),
  ('Loot Compass', 'loot-compass-log', 'Bags & Inventory', 'Mira', 'Find loot by source and mark items you still need.'),
  ('Route Atlas Overlay', 'route-atlas-overlay-log', 'Map & Minimap', 'Juniper', 'Show Route Atlas waypoints on the world map.'),
  ('Raid Timeline', 'raid-timeline-log', 'Raid & Party', 'Cedar', 'Review raid events and highlight cooldown overlap.'),
  ('Archive Ledger', 'archive-ledger-log', 'Bags & Inventory', 'Mira', 'Browse earlier snapshots of bags and bank contents.')
 ) as f(name, repo, category, author, description);

 select id into strict atlas from public.addons where source = demo_source and name = 'Route Atlas';
 select id into strict lantern from public.addons where source = demo_source and name = 'Chat Lantern';
 select id into strict compass from public.addons where source = demo_source and name = 'Loot Compass';
 select id into strict overlay from public.addons where source = demo_source and name = 'Route Atlas Overlay';
 select id into strict timeline from public.addons where source = demo_source and name = 'Raid Timeline';
 select id into strict archive from public.addons where source = demo_source and name = 'Archive Ledger';

 -- Historical events can describe old data without modifying the current pages or accounts.
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 select now() - make_interval(days => days), p.id, p.username, action, subject, addon_id, details || marker
 from (values
  (120, 'member', 'addon.update', 'Route Atlas', atlas, '{"changed":["description"]}'::jsonb),
  (22, 'member', 'addon.create', 'Route Atlas', atlas, '{}'),
  (21, 'admin', 'addon.restore', 'Loot Compass', compass, '{}'),
  (20, 'admin', 'addon.community', 'Loot Compass', compass, '{}'),
  (19, 'admin', 'addon.mirror', 'Route Atlas', atlas, '{}'),
  (18, 'admin', 'addon.merge', 'Old Route Overlay', atlas, '{}'),
  (17, 'admin', 'addon.purge', 'Auction Notebook Classic', null, '{}'),
  (16, 'member', 'group.suggest', 'Route Atlas Overlay', overlay, '{}'),
  (15, 'admin', 'group.decline', 'Chat Lantern', lantern, '{"target":"Quiet Chat"}'),
  (14, 'member', 'import.submitted', 'Skyline Layout', null, '{}'),
  (13, 'admin', 'import.requeue', 'Trail Map Beta', null, '{}'),
  (12, 'member', 'report.create', 'Chat Lantern', lantern, '{"reason":"broken"}'),
  (11, 'owner', 'user.admin', 'admin2', null, '{}'),
  (10, 'owner', 'user.unadmin', 'member2', null, '{}'),
  (9, 'owner', 'user.unban', 'member2', null, '{}'),
  (8, 'admin', 'user.ban', 'banned', null, '{}'),
  (7, null, 'user.autosuspend', null, null, '{"reason":"Repeated duplicate submissions from an account."}'),
  (6, 'owner', 'user.rollback', 'member', null, '{"steps":2,"skipped":1,"skipped_details":[{"action":"addon.update","subject":"Chat Lantern","why":"A later edit changed the same field."}]}'),
  (5, null, 'account.delete', 'Deleted account', null, '{}'),
  (4, 'owner', 'trash.purge', 'Old Mail Counter', null, '{"names":["Old Mail Counter","Party Notes Classic"]}'),
  (3, 'admin', 'addon.delete', 'Old Mail Counter', null, '{}')
 ) as f(days, username, action, subject, addon_id, details)
 left join public.profiles p on p.username = f.username
 order by days desc;

 -- Keep one recoverable import approval and reuse the demo's rejected import.
 insert into public.import_queue (key, url, name, description, category, source, status, decided_by, decided_at, addon_id)
 select link_keys[1], versions->0->>'url', name, description, category, 'Discord', 'approved', admin_id, now() - interval '4 days', id
 from public.addons where id = timeline;
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 select now() - interval '4 days', admin_id, 'admin', 'import.approve', name, id, jsonb_build_object('url', versions->0->>'url') || marker
 from public.addons where id = timeline;
 insert into public.activity_log (at, actor, actor_name, action, subject, details)
 select now() - interval '3 days', admin_id, 'admin', 'import.reject', name, jsonb_build_object('url', url) || marker
 from public.import_queue where key = public.link_key(repo_root || 'retail-layout');

 -- Show a safe reversion, a later conflicting edit, and a completed recovery.
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 select now() - make_interval(hours => hours), admin_id, 'admin', 'addon.update', a.name, a.id,
  jsonb_build_object('changed', array['description'], 'before', jsonb_build_object('description', f.before),
   'after', jsonb_build_object('description', coalesce(f.after, a.description))) || marker
 from (values
  (atlas, 84, 'Save routes for gathering professions.', null),
  (lantern, 78, 'Filter repeated posts in trade chat.', 'Filter trade and guild messages.'),
  (lantern, 37, 'Filter trade and guild messages.', null),
  (compass, 65, 'Find loot by source and mark items you still need.', 'Find raid drops by source.')
 ) as f(addon_id, hours, before, after)
 join public.addons a on a.id = f.addon_id
 order by hours desc;
 select id into strict original_id from public.activity_log
  where addon_id = compass and action = 'addon.update' and details @> marker;
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 select now() - interval '31 hours', owner_id, 'owner', 'addon.revert', name, id,
  jsonb_build_object('changed', array['description'], 'before', jsonb_build_object('description', 'Find raid drops by source.'),
   'after', jsonb_build_object('description', description), 'undid', original_id) || marker
 from public.addons where id = compass;
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values (now() - interval '30 hours', owner_id, 'owner', 'addon.recovery', 'Loot Compass', compass, marker || '{"unchanged":true}');

 perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

 -- Use a real group, with an older unverifiable change and a newer undoable change.
 perform public.group_addons(array[atlas, overlay]);
 group_after := public.groups_of(array[atlas, overlay]);
 update public.activity_log set at = now() - interval '28 hours', details = details || marker
 where id = currval(pg_get_serial_sequence('public.activity_log', 'id'));
 select jsonb_agg(jsonb_set(item, '{is_main}', to_jsonb((item->>'id')::bigint = overlay)) order by position)
 into other_main from jsonb_array_elements(group_after) with ordinality g(item, position);
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values (now() - interval '27 hours', admin_id, 'admin', 'group.remove', 'Route Atlas Overlay', overlay,
  jsonb_build_object('groups_before', group_after) || marker);
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values (now() - interval '26 hours', admin_id, 'admin', 'group.main', 'Route Atlas Overlay', overlay,
  jsonb_build_object('groups_before', group_after, 'groups_after', other_main) || marker)
 returning id into original_id;
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values
  (now() - interval '25 hours', owner_id, 'owner', 'group.undo', 'Route Atlas Overlay', overlay, jsonb_build_object('groups_before', other_main, 'groups_after', group_after, 'undid', original_id) || marker);

 -- Persist one report decision that an owner can reopen, and one already reopened pair.
 insert into public.reports (addon_id, reason, note, reported_by, reported_by_name, created_at)
 values (lantern, 'broken', 'The old release link works again.', member_id, 'member', now() - interval '4 days')
 returning id into report_id;
 perform public.decide_report(report_id, 'dismissed');
 update public.activity_log set at = now() - interval '23 hours', details = details || marker
 where id = (select decision_log_id from public.reports where id = report_id);
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values (now() - interval '22 hours', admin_id, 'admin', 'report.handle', 'Route Atlas', atlas, marker)
 returning id into original_id;
 insert into public.activity_log (at, actor, actor_name, action, subject, addon_id, details)
 values (now() - interval '21 hours', owner_id, 'owner', 'report.reopen', 'Route Atlas', atlas, jsonb_build_object('undid', original_id) || marker);

 delete from public.addons where id = archive;
 update public.activity_log set at = now() - interval '20 hours', details = details || marker
 where id > first_id and addon_id = archive and action = 'addon.delete';

 -- Incidental rows from this same transaction are setup activity, not examples.
 delete from public.activity_log
 where id > first_id and at = now() and addon_id = any(array[atlas, lantern, compass, overlay, timeline, archive])
  and not coalesce(details @> marker, false);

 -- History sorts by ID. Give the demos a matching timeline, keeping the expired edit old.
 with dated as (
  select id, row_number() over (order by id desc) as position
  from public.activity_log where id > first_id and details @> marker and at > now() - interval '90 days'
 )
 update public.activity_log l set at = now() - make_interval(hours => (dated.position * 4)::integer)
 from dated where l.id = dated.id;
end
$demo$;
`;
