// A copy of the whole backend on this computer, for trying things out and for the browser
// tests: real Postgres, the real API and the real login service, built from the project's
// own migrations, with test data in place. Nothing here touches the hosted database.
//
//   node scripts/local.mjs up      start it if needed, then wipe and fill it
//   node scripts/local.mjs reset   wipe and fill it (it must be running)
//   node scripts/local.mjs down    stop it
//
// Needs Docker. `npm run dev:local` then serves the site against it on port 5174, where
// the login page offers one account of each kind. See src/lib/local-accounts.ts.
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CATEGORIES } from '../src/lib/config.ts';
import { LOCAL_ACCOUNTS, LOCAL_PASSWORD } from '../src/lib/local-accounts.ts';

// The site only needs the database, the API and the login service.
const LEFT_OUT = 'realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor';
const DB_CONTAINER = 'supabase_db_vanilla-addon-index';
const ENV_FILE = '.env.localdb';

const supabase = (args, options = {}) => execSync(`npx supabase ${args}`, { stdio: 'inherit', ...options });

function status() {
	try {
		const out = execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
		const info = JSON.parse(out.slice(out.indexOf('{')));
		return info.API_URL ? info : null;
	} catch {
		return null;
	}
}

/** Runs SQL as the database owner, the way the Supabase SQL editor does. */
function sql(text, label) {
	const run = spawnSync(
		'docker',
		['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
		{ input: text, encoding: 'utf8' }
	);
	if (run.status !== 0) throw new Error(`${label} failed:\n${run.stderr || run.stdout}`);
	return run.stdout;
}

async function createAccounts({ API_URL, SERVICE_ROLE_KEY }) {
	for (const account of LOCAL_ACCOUNTS) {
		const res = await fetch(`${API_URL}/auth/v1/admin/users`, {
			method: 'POST',
			headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: account.email,
				password: LOCAL_PASSWORD,
				email_confirm: true,
				user_metadata: { username: account.username }
			})
		});
		if (!res.ok) throw new Error(`Creating ${account.username} failed: ${res.status} ${await res.text()}`);
	}
}

// Enough of everything to look like the real site a few months in: a list long enough to
// scroll and search, groups, a full import queue with every kind of verdict, and addons
// posted by members.
const WORDS = ['Raid', 'Quest', 'Bag', 'Buff', 'Map', 'Chat', 'Bar', 'Frame', 'Auction', 'Threat', 'Loot', 'Totem'];
const THINGS = ['Helper', 'Tracker', 'Timers', 'Plus', 'Lite', 'Master', 'Watch', 'Notes', 'Alert', 'Sort', 'Stats', 'Mate'];
const name = (i) => `${WORDS[i % WORDS.length]}${THINGS[Math.floor(i / WORDS.length) % THINGS.length]}${i >= 144 ? ` ${Math.floor(i / 144) + 1}` : ''}`;
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function seedSql() {
	const flags = LOCAL_ACCOUNTS.map(
		(a) =>
			`update public.profiles set is_owner = ${a.role === 'owner'}, is_admin = ${a.role === 'admin'}, banned = ${Boolean(a.banned)} where username = ${quote(a.username)};`
	).join('\n');

	// Imports an admin approved: the bulk of the list.
	const imported = Array.from({ length: 240 }, (_, i) => {
		const title = name(i);
		return `(${quote(title)}, ${quote(`${title} does one thing well. It was imported from the wiki for the local test data.`)}, ${quote(CATEGORIES[i % CATEGORIES.length])}, ${quote(`author${i % 40}`)}, jsonb_build_array(jsonb_build_object('url', 'https://github.com/author${i % 40}/${title.replace(/\s+/g, '-')}', 'note', '')), 'Turtle WoW Wiki', (select id from public.profiles where username = 'admin'), now() - interval '${i} hours')`;
	}).join(',\n');

	const posted = [
		['member', 'Member Bars', 'Action Bars', 'Posted by the test member. Moves and resizes the action bars.'],
		['member', 'Member Bags', 'Bags & Inventory', 'Posted by the test member. One big bag instead of five small ones.'],
		['member', 'Member Map', 'Map & Minimap', 'Posted by the test member. Coordinates and notes on the world map.'],
		['member2', 'Second Member Chat', 'Chat & Social', 'Posted by the second test member. Timestamps and class colours in chat.'],
		['banned', 'Banned Tooltip', 'Tooltip', 'Posted by the banned test member before the ban. Extra lines in tooltips.']
	]
		.map(
			([user, title, category, description]) =>
				`(${quote(title)}, ${quote(description)}, ${quote(category)}, '', jsonb_build_array(jsonb_build_object('url', 'https://github.com/${user}/${title.replace(/\s+/g, '-')}', 'note', '')), '', (select id from public.profiles where username = ${quote(user)}), now() - interval '2 days')`
		)
		.join(',\n');

	// The import queue, with what the nightly job would have found out about each repository.
	const queued = Array.from({ length: 40 }, (_, i) => {
		const title = `Queued${WORDS[i % WORDS.length]}${i}`;
		const key = `github.com/wiki${i}/${title.toLowerCase()}`;
		return {
			title,
			key,
			queue: `(${quote(key)}, ${quote(`https://github.com/wiki${i}/${title}`)}, ${quote(title)}, ${quote(i % 7 === 0 ? '' : `${title} is waiting in the import queue of the local test data.`)}, ${quote(CATEGORIES[i % CATEGORIES.length])}, ${i % 13 === 5})`,
			stats: `(${quote(key)}, ${i * 3}, now() - interval '${i % 9 === 4 ? 7 : 1} years', ${i % 11 === 3}, ${i % 10 === 6}, ${i % 8 === 2 ? 20504 : 11200}, ${quote(key)})`
		};
	});

	return `
${flags}

insert into public.addons (name, description, category, author, versions, source, owner, created_at) values
${imported};

insert into public.addons (name, description, category, author, versions, source, owner, created_at) values
${posted};

-- One group of three, with a main version.
update public.addons set group_id = nextval('public.addon_group_seq'), is_main = (name = 'RaidHelper')
where name in ('RaidHelper', 'RaidTracker', 'RaidTimers');
update public.addons set group_id = currval('public.addon_group_seq') where name in ('RaidHelper', 'RaidTracker', 'RaidTimers');

insert into public.import_queue (key, url, name, description, category, obsolete) values
${queued.map((q) => q.queue).join(',\n')};
insert into public.repo_stats (key, stars, pushed_at, archived, missing, interface, canonical) values
${queued.map((q) => q.stats).join(',\n')};
-- One queued entry is a fork of a live addon, and one has the name of a live addon.
update public.repo_stats set fork_of = (select link_keys[1] from public.addons where name = 'QuestHelper')
where key = ${quote(queued[1].key)};
update public.import_queue set name = 'BagHelper' where key = ${quote(queued[2].key)};

-- Seeding is not something that happened on the site.
insert into public.repo_code_updates (url, committed_at, history_url)
select repo_url, '2024-06-14T14:00:48Z', repo_url || '/commits/HEAD' from public.addons where name = 'RaidHelper';
update public.addons set code_update = null where name = 'RaidHelper';
delete from public.activity_log;
`;
}

async function fill() {
	const info = status();
	if (!info) throw new Error('The local backend is not running. Start it with: node scripts/local.mjs up');

	// Rebuilds it from supabase/migrations, the same way the hosted database was built.
	console.log('Wiping the local database and applying the migrations…');
	supabase('db reset --local --no-seed', { stdio: ['ignore', 'ignore', 'inherit'] });

	console.log('Creating the test accounts and data…');
	await createAccounts(info);
	sql(seedSql(), 'seeding');

	writeFileSync(
		ENV_FILE,
		`# Written by scripts/local.mjs. Points \`npm run dev:local\` at the backend on this computer.\nVITE_SUPABASE_URL=${info.API_URL}\nVITE_SUPABASE_ANON_KEY=${info.ANON_KEY}\n`
	);
	console.log(`Ready: ${info.API_URL}. Accounts: ${LOCAL_ACCOUNTS.map((a) => a.username).join(', ')}.`);
}

const command = process.argv[2];
if (command === 'up') {
	if (!status()) supabase(`start -x ${LEFT_OUT}`);
	await fill();
} else if (command === 'reset') {
	await fill();
} else if (command === 'down') {
	supabase('stop');
} else {
	console.log('Usage: node scripts/local.mjs up | reset | down');
	process.exit(1);
}
