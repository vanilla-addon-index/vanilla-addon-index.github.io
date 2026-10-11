// A full copy of what the hosted database holds: every table of the site, and the accounts
// kept by the login service. The table structure is not part of it; supabase/migrations is
// that. Needs Docker, and `npx supabase login` and `link` to have been run once.
//
//   node scripts/backup.mjs                 writes backups/<date and time>.sql
//   node scripts/backup.mjs <file>          the same, to that file
//   node scripts/backup.mjs check <file>    loads a backup into the local backend and counts
//                                           what arrived, to show it can be restored
//
// A backup holds private data: usernames, email addresses, the log, reports. It is never
// committed (backups/ is ignored by git), and the nightly one that GitHub keeps is
// encrypted first; see .github/workflows/backup.yml.
//
// To restore after losing the hosted database: create a project, link it, build its tables
// with `npm run db:push`, then load the backup file with psql against the new database.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// The site's own tables, and the accounts with the logins they are tied to.
const SCHEMAS = 'public,auth';
// Sessions and one-time codes are of no use in a backup: everyone simply logs in again.
const LEFT_OUT = [
	'auth.sessions',
	'auth.refresh_tokens',
	'auth.mfa_amr_claims',
	'auth.flow_state',
	'auth.one_time_tokens',
	'auth.audit_log_entries',
	'auth.schema_migrations',
	// A cache of who is in the GitHub organization; the migrations create it and it refills itself.
	'public.org_cache'
].join(',');
const DB_CONTAINER = 'supabase_db_vanilla-addon-index';
const TABLES = ['auth.users', 'auth.identities', 'profiles', 'addons', 'import_queue', 'repo_stats', 'activity_log', 'addon_trash', 'group_suggestions', 'reports'];

function dump(file) {
	mkdirSync(dirname(file), { recursive: true });
	execSync(`npx supabase db dump --linked --data-only --use-copy --schema ${SCHEMAS} --exclude ${LEFT_OUT} --file "${file}"`, {
		stdio: ['ignore', 'ignore', 'inherit']
	});
	const { size } = statSync(file);
	// A dump that holds no data at all means something went wrong, not that the site is empty.
	if (!/^COPY "?auth"?\."?users"? /m.test(readFileSync(file, 'utf8'))) {
		throw new Error(`${file} does not contain the accounts table; the backup is not usable.`);
	}
	console.log(`Backed up to ${file} (${(size / 1024).toFixed(0)} KB).`);
}

/** Runs SQL in the local backend, as the database owner. */
function psql(input, args = []) {
	const run = spawnSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
		input,
		encoding: 'utf8',
		maxBuffer: 1 << 28
	});
	if (run.status !== 0) throw new Error(run.stderr || run.stdout);
	return run.stdout;
}

function check(file) {
	const backup = readFileSync(file, 'utf8');
	console.log('Rebuilding the local database from the migrations…');
	execSync('npx supabase db reset --local --no-seed', { stdio: ['ignore', 'ignore', 'inherit'] });
	console.log('Loading the backup into it…');
	psql(backup);
	const counts = psql(
		TABLES.map((t) => `select '${t}', count(*) from ${t.includes('.') ? t : `public.${t}`}`).join(' union all ') + ';',
		['-At', '-F', ': ']
	);
	console.log(`The backup restores. Rows per table:\n${counts.trim().replace(/^/gm, '  ')}`);
	console.log('The local backend now holds real data. Run "npm run local" to put the test data back.');
}

const [first, second] = process.argv.slice(2);
if (first === 'check') {
	if (!second) throw new Error('Usage: node scripts/backup.mjs check <file>');
	check(second);
} else {
	dump(first ?? `backups/${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.sql`);
}
