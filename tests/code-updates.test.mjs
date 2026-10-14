import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubCodeQuery, githubCodeUpdate } from '../src/lib/code-updates.ts';
import { askForge, forgePlace } from '../src/lib/forges.ts';

test('GitHub dates use the linked branch and folder history, never repository push activity', () => {
	const query = githubCodeQuery('vanilla', 'My Addon');
	assert.match(query, /object\(expression: "vanilla"\)/);
	assert.match(query, /history\(first: 1, path: "My Addon"\)/);
	const repo = { nameWithOwner: 'New/Collection', pushedAt: '2026-10-14T00:00:00Z' };
	assert.equal(githubCodeUpdate(repo, 'vanilla', 'My Addon'), null);
	repo.code = { history: { nodes: [{ committedDate: '2020-02-01T10:00:00Z' }] } };
	assert.deepEqual(githubCodeUpdate(repo, 'vanilla', 'My Addon'), {
		date: '2020-02-01T10:00:00Z', url: 'https://github.com/New/Collection/commits/vanilla/My%20Addon'
	});
	repo.code.history.nodes = [];
	assert.equal(githubCodeUpdate(repo, 'vanilla', 'My Addon'), null);
});

for (const host of ['gitlab.com', 'codeberg.org', 'gitea.com']) {
	test(`${host} scopes commit dates and history links to the branch and addon folder`, async () => {
		const gitlab = host === 'gitlab.com';
		const place = forgePlace(`https://${host}/Owner/Collection/${gitlab ? '-/tree' : 'src/branch'}/vanilla/My%20Addon`);
		const requested = [];
		const ask = async (url) => {
			requested.push(url);
			if (url.includes('/commits?')) {
				assert.match(url, /(?:ref_name|sha)=vanilla/);
				assert.match(url, /&path=My%20Addon/);
				return { status: 200, body: [gitlab ? { committed_date: '2021-03-04T00:00:00Z' } : { commit: { committer: { date: '2021-03-04T00:00:00Z' } } }] };
			}
			if (requested.length === 1) return { status: 200, body: gitlab
				? { id: 1, path_with_namespace: 'New/Collection', default_branch: 'main', last_activity_at: '2026-10-14T00:00:00Z' }
				: { full_name: 'New/Collection', default_branch: 'main', updated_at: '2026-10-14T00:00:00Z' } };
			return null;
		};
		const facts = await askForge(place, ask);
		assert.deepEqual(facts.code_update, {
			date: '2021-03-04T00:00:00Z',
			url: `https://${host}/New/Collection/${gitlab ? '-/commits' : 'commits/branch'}/vanilla/My%20Addon`
		});
	});
}
