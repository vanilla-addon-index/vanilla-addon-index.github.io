import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const job = (yaml, name) => yaml.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
const publish = workflow('publish');

test('all publication entry points hold one shared lock over the entire reusable workflow', () => {
	for (const [name, caller] of [['deploy', 'publish'], ['nightly', 'deploy'], ['refresh', 'deploy']]) {
		const locked = job(workflow(name), caller);
		assert.match(locked, /concurrency:\n\s+group: publication\n\s+cancel-in-progress: false\n\s+(?:#.*\n\s+)*queue: max/);
		assert.match(locked, /uses: \.\/\.github\/workflows\/publish.yml/);
	}
	// A nested lock could deadlock the caller. No other workflow may bypass these callers.
	assert.ok(!publish.includes('concurrency:'));
	assert.ok(!publish.includes('workflow_dispatch:'));
	assert.ok(!publish.includes('\n  push:'));
	assert.match(job(publish, 'deploy'), /needs: build/);
	assert.match(job(publish, 'snapshot'), /needs: deploy/);
	assert.match(job(publish, 'deploy'), /if: steps\.fresh\.outputs\.current == 'true'/);
	assert.match(job(publish, 'snapshot'), /if: needs\.deploy\.outputs\.published == 'true' && needs\.deploy\.outputs\.attempt == github\.run_attempt/);
	assert.match(job(publish, 'deploy'), /published: \$\{\{ steps\.deployment\.outcome == 'success' }}/);
	assert.match(job(publish, 'build'), /attempt: \$\{\{ steps\.built\.outputs\.attempt }}/);
	assert.match(job(publish, 'build'), /name: snapshot-\$\{\{ github\.run_attempt }}/);
	assert.match(job(publish, 'build'), /name: github-pages-\$\{\{ github\.run_attempt }}/);
	assert.match(job(publish, 'deploy'), /artifact_name: github-pages-\$\{\{ github\.run_attempt }}/);
	assert.match(job(publish, 'snapshot'), /--name "snapshot-\$GITHUB_RUN_ATTEMPT"/);
});

// Execute the actual freshness shell with a local gh stand-in. No network or hosted writes.
const fresh = job(publish, 'deploy').split('        run: |\n')[1].split('\n      - id: deployment')[0]
	.split('\n').map((line) => line.slice(10)).join('\n');
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';

for (const [name, head, attempt, apiStatus, expectedStatus, allowed] of [
	['current build', 'current', '2', '0', 0, true],
	['superseded commit', 'newer', '2', '0', 0, false],
	['failed GitHub check', 'current', '2', '1', 1, false],
	['partial rerun with old artifact', 'current', '1', '0', 1, false]
]) {
	test(`publication freshness: ${name}`, () => {
		const dir = mkdtempSync(join(tmpdir(), 'publication-'));
		const output = join(dir, 'output').replaceAll('\\', '/');
		try {
			const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `
touch "$GITHUB_OUTPUT"
gh() { printf '%s\\n' "$MOCK_HEAD"; return "$MOCK_STATUS"; }
${fresh}`], {
				encoding: 'utf8',
				env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_SHA: 'current', GITHUB_REPOSITORY: 'example/site',
					GITHUB_RUN_ATTEMPT: '2', BUILD_ATTEMPT: attempt, MOCK_HEAD: head, MOCK_STATUS: apiStatus }
			});
			assert.equal(result.status, expectedStatus, result.error?.message ?? result.stderr + result.stdout);
			assert.equal(readFileSync(output, 'utf8').includes('current=true'), allowed);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
