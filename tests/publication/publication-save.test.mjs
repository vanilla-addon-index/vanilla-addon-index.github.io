import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fingerprint} from '../../scripts/publication-state.mjs';

const publish = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const save = publish.split('\n  snapshot:\n')[1].split('        run: |\n')[1]
	.split('\n').map((line) => line.slice(10)).join('\n');
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const commit = 'a'.repeat(40);

test('snapshot saving verifies this successful deployment and replaces the branch without keeping history', () => {
	const dir = mkdtempSync(join(tmpdir(), 'publication-save-'));
	const work = join(dir, 'work');
	const remote = join(dir, 'remote.git');
	const temp = join(dir, 'temp');
	const artifact = join(temp, 'snapshot');
	mkdirSync(work);
	mkdirSync(artifact, {recursive:true});
	function git(...args) {
		const result = spawnSync('git', args, {cwd:work, encoding:'utf8'});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}
	function run({id = 42, sha = commit, state = 'success', runId = '123', badHash = false, apiFail = false, downloadFail = false} = {}) {
		const snapshot = JSON.stringify([{id:'addon', description:'Deployment ' + id}]) + '\n';
		writeFileSync(join(artifact, 'addons.json'), snapshot);
		writeFileSync(join(artifact, 'publication.json'), JSON.stringify({...fingerprint(commit, snapshot), ...(badHash ? {snapshot:'0'.repeat(64)} : {})}));
		return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `
gh() {
  if [ "$1" = run ]; then return "$DOWNLOAD_STATUS"; fi
  if [ "$API_FAIL" = true ]; then return 1; fi
  case "$2" in
    *statuses*) printf '%s\\n' "$MOCK_STATUS" ;;
    *) printf '%s\\n' "$MOCK_DEPLOYMENT" ;;
  esac
}
${save}`], {cwd:work, encoding:'utf8', env:{...process.env,
			RUNNER_TEMP:temp.replaceAll('\\','/'), GITHUB_SHA:commit, GITHUB_REPOSITORY:'example/site', GITHUB_SERVER_URL:'https://github.com', GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'2',
			GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid',
			API_FAIL:String(apiFail), DOWNLOAD_STATUS:downloadFail ? '1' : '0',
			MOCK_DEPLOYMENT:JSON.stringify([{id, sha, environment:'github-pages'}]),
			MOCK_STATUS:JSON.stringify([{state, log_url:`https://github.com/example/site/actions/runs/${runId}/job/456`}])
		}});
	}
	try {
		git('init', '--bare', remote);
		git('init');
		git('remote', 'add', 'origin', remote);
		let result = run();
		assert.equal(result.status, 0, result.stderr + result.stdout);
		git('fetch', 'origin', 'snapshot');
		assert.equal(JSON.parse(git('show', 'FETCH_HEAD:publication.json')).deployment, 42);
		assert.equal(git('rev-list', '--count', 'FETCH_HEAD'), '1');
		result = run({id:43});
		assert.equal(result.status, 0, result.stderr + result.stdout);
		git('fetch', 'origin', 'snapshot');
		const saved = git('rev-parse', 'FETCH_HEAD');
		assert.equal(JSON.parse(git('show', 'FETCH_HEAD:publication.json')).deployment, 43);
		assert.equal(git('rev-list', '--count', 'FETCH_HEAD'), '1');
		assert.ok(git('show', 'FETCH_HEAD:addons.json').includes('Deployment 43'));
		for (const scenario of [{state:'failure'}, {state:'pending'}, {sha:'b'.repeat(40)}, {runId:'999'}, {badHash:true}, {apiFail:true}]) {
			result = run({...scenario, id:44});
			assert.notEqual(result.status, 0, JSON.stringify(scenario));
			git('fetch', 'origin', 'snapshot');
			assert.equal(git('rev-parse', 'FETCH_HEAD'), saved, JSON.stringify(scenario));
		}
		result = run({downloadFail:true});
		assert.equal(result.status, 0, result.stderr);
		git('fetch', 'origin', 'snapshot');
		assert.equal(git('rev-parse', 'FETCH_HEAD'), saved);
	} finally {rmSync(dir, {recursive:true, force:true});}
});
