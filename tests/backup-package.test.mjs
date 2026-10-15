import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const root = new URL('../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/backup.yml', root), 'utf8').replaceAll('\r\n', '\n');
function step(name) {
	return workflow.split(`      - name: ${name}\n`)[1].split('        run: |\n')[1]
		.split('\n\n')[0].split('\n').map(line => line.slice(10)).join('\n');
}
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';

test('backup archive decrypts with matching recovery files and checks the extracted copy', () => {
	const dir = mkdtempSync(join(tmpdir(), 'backup-package-'));
	const work = join(dir, 'work');
	const temp = join(dir, 'temp');
	mkdirSync(work);
	mkdirSync(temp);
	for (const file of ['supabase/migrations', 'supabase/config.toml', 'scripts/backup.mjs', 'src/lib/config.ts', 'package.json', 'package-lock.json', 'docs/backup-restore.md']) {
		cpSync(new URL(file, root), join(work, file), {recursive:true});
	}
	const run = (script) => {
		// Git for Windows cannot start its GPG agent here. Exercise the archive
		// pipeline with a transport stub locally; Linux CI uses real encryption.
		const portableScript = (process.platform === 'win32' ? `
tar() { command tar --force-local "$@"; }
gpg() {
  local output input
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      --passphrase|--cipher-algo) shift 2 ;;
      --*) shift ;;
      *) input="$1"; shift ;;
    esac
  done
  cp "$input" "$output"
}
` : '') + script;
		const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', portableScript], {
			cwd:work, encoding:'utf8', env:{...process.env,
				RUNNER_TEMP:temp.replaceAll('\\', '/'), GNUPGHOME:join(temp, 'gnupg').replaceAll('\\', '/'),
				BACKUP_PASSPHRASE:'test-only-passphrase', GITHUB_REPOSITORY:'example/site',
				GITHUB_SHA:'a'.repeat(40), GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'2'
			}
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
	};
	try {
		run(`
mkdir -p "$GNUPGHOME"
supabase() { if [ "$1" = --version ]; then echo 2.120.0; fi; }
node() {
  if [ "$1" = scripts/backup.mjs ]; then printf 'fixture SQL\\n' > "$2";
  else command node "$@"; fi
}
${step('Back up and encrypt')}
`);
		assert.ok(existsSync(join(work, 'backup.tar.gz.gpg')));
		assert.equal(existsSync(join(temp, 'recovery')), false, 'plaintext staging must be removed');
		assert.equal(existsSync(join(temp, 'backup.tar.gz')), false);
		run(`
supabase() {
  test "$PWD" = "$(cd "$RUNNER_TEMP/restored" && pwd)"
  test -f supabase/config.toml
  test -d supabase/migrations
}
node() {
  test "$1" = scripts/backup.mjs
  test "$2" = check
  test "$(cat "$3")" = 'fixture SQL'
  cmp supabase/config.toml "$GITHUB_WORKSPACE/supabase/config.toml"
  diff -r supabase/migrations "$GITHUB_WORKSPACE/supabase/migrations"
  cmp scripts/backup.mjs "$GITHUB_WORKSPACE/scripts/backup.mjs"
  cmp src/lib/config.ts "$GITHUB_WORKSPACE/src/lib/config.ts"
  cmp package-lock.json "$GITHUB_WORKSPACE/package-lock.json"
  cmp README.md "$GITHUB_WORKSPACE/docs/backup-restore.md"
  cp manifest.json "$RUNNER_TEMP/verified-manifest.json"
}
export GITHUB_WORKSPACE="$PWD"
${step('Check that it restores')}
`);
		const manifest = JSON.parse(readFileSync(join(temp, 'verified-manifest.json'), 'utf8'));
		assert.equal(manifest.commit, 'a'.repeat(40));
		assert.equal(manifest.supabaseCli, '2.120.0');
		assert.equal(manifest.runAttempt, '2');
		assert.equal(manifest.node, process.version);
		assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
		assert.ok(!JSON.stringify(manifest).includes('test-only-passphrase'));
		assert.equal(existsSync(join(temp, 'restored')), false);
	} finally {
		rmSync(dir, {recursive:true, force:true});
	}
});

test('branch retention keeps seven newest copies across legacy and archive formats', () => {
	const dir = mkdtempSync(join(tmpdir(), 'backup-retention-'));
	try {
		for (let day = 1; day <= 10; day++) {
			writeFileSync(join(dir, `backup-2026-10-${String(day).padStart(2, '0')}.${day <= 5 ? 'sql' : 'tar.gz'}.gpg`), 'encrypted fixture');
		}
		writeFileSync(join(dir, 'README.md'), 'Keep this');
		// Read the actual retention pipeline rather than reproducing its policy.
		const pipeline = workflow.slice(workflow.indexOf('          ls -1 "$keep" |'))
			.split('\n          done')[0] + '\n          done';
		const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', pipeline], {
			encoding:'utf8', env:{...process.env, keep:dir.replaceAll('\\', '/')}
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readdirSync(dir).length, 8);
		assert.ok(existsSync(join(dir, 'backup-2026-10-04.sql.gpg')));
		assert.ok(existsSync(join(dir, 'backup-2026-10-10.tar.gz.gpg')));
		assert.ok(existsSync(join(dir, 'README.md')));
	} finally { rmSync(dir, {recursive:true, force:true}); }
});
