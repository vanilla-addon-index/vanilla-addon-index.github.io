// What the nightly job makes of GitLab's and Gitea's answers about a repository.
// See src/lib/forges.ts. Nothing here talks to those sites: the answers are written out
// below, in the shape the sites send them.
//
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { askForge, forgePlace } from '../src/lib/forges.ts';

// Answers by address. An address that is not listed gets no answer at all.
const site = (answers) => {
	const asked = [];
	const ask = async (url, as) => {
		asked.push(url);
		if (!(url in answers)) return null;
		const body = answers[url];
		if (body === 404) return { status: 404 };
		return { status: 200, body: as === 'json' ? body : String(body) };
	};
	return { ask, asked };
};

describe('where a link to GitLab, Codeberg or gitea.com points', () => {
	const place = (url) => {
		const p = forgePlace(url);
		return p && [p.kind, p.host, p.project, p.ref, p.path].join(' | ');
	};

	test('the repository, as the link spells it', () => {
		assert.equal(place('https://gitlab.com/Artur91425/Automaton'), 'gitlab | gitlab.com | Artur91425/Automaton |  | ');
		assert.equal(place('https://www.GitLab.com/aead/aBindings.git?ref=x#top'), 'gitlab | gitlab.com | aead/aBindings |  | ');
		assert.equal(place('https://gitlab.com/group/sub/addon/'), 'gitlab | gitlab.com | group/sub/addon |  | ');
		assert.equal(place('https://codeberg.org/Someone/Addon'), 'gitea | codeberg.org | Someone/Addon |  | ');
		assert.equal(place('https://gitea.com/someone/addon.git'), 'gitea | gitea.com | someone/addon |  | ');
	});

	test('the branch and the folder, when the link names them', () => {
		assert.equal(place('https://gitlab.com/woblight/actionmirroringframe/-/tree/vanilla'), 'gitlab | gitlab.com | woblight/actionmirroringframe | vanilla | ');
		assert.equal(place('https://gitlab.com/group/sub/addon/-/tree/main/Addons/One'), 'gitlab | gitlab.com | group/sub/addon | main | Addons/One');
		assert.equal(place('https://gitlab.com/someone/addon/-/issues/3'), 'gitlab | gitlab.com | someone/addon |  | ');
		// Links from before GitLab put "/-/" in them.
		assert.equal(place('https://gitlab.com/someone/addon/tree/master/Folder'), 'gitlab | gitlab.com | someone/addon | master | Folder');
		assert.equal(place('https://codeberg.org/someone/addon/src/branch/main/My%20Addon'), 'gitea | codeberg.org | someone/addon | main | My Addon');
		assert.equal(forgePlace('https://codeberg.org/someone/addon/src/tag/v1').refKind, 'tag');
		assert.equal(place('https://codeberg.org/someone/addon/releases'), 'gitea | codeberg.org | someone/addon |  | ');
	});

	test('nothing for a link without a repository, or to a site that is not asked', () => {
		for (const url of [
			'https://gitlab.com/someone',
			'https://codeberg.org/',
			'https://github.com/shagu/pfQuest',
			'https://octowow.st/git/ShempError/BulwarkFrame',
			'https://bitbucket.org/team/addon',
			'not a link'
		]) {
			assert.equal(forgePlace(url), null, url);
		}
	});
});

describe('what GitLab says about a repository', () => {
	const api = 'https://gitlab.com/api/v4/projects';
	const project = {
		id: 77,
		path_with_namespace: 'Artur91425/Automaton',
		star_count: 3,
		last_activity_at: '2025-03-01T00:00:00Z',
		default_branch: 'master',
		forked_from_project: { path_with_namespace: 'Someone/Automaton' }
	};

	test('stars, the last commit, the fork parent, the game version and the README', async () => {
		const { ask, asked } = site({
			[`${api}/Artur91425%2FAutomaton`]: project,
			[`${api}/77/repository/commits?per_page=1&ref_name=master`]: [{ committed_date: '2024-06-14T14:00:48Z' }],
			[`${api}/77/repository/tree?per_page=100&ref=master`]: [
				{ name: 'Automaton.toc', type: 'blob' },
				{ name: 'README.md', type: 'blob' },
				{ name: 'modules', type: 'tree' }
			],
			[`${api}/77/repository/files/Automaton.toc/raw?ref=master`]: '## Interface: 11200\n## Title: Automaton',
			[`${api}/77/repository/files/README.md/raw?ref=master`]: '![shot](img/a.png)'
		});
		assert.deepEqual(await askForge(forgePlace('https://gitlab.com/Artur91425/Automaton'), ask, true), {
			project: 'Artur91425/Automaton',
			stars: 3,
			// The last commit, not the last time anything at all happened.
			pushed_at: '2024-06-14T14:00:48Z',
			code_update: { date: '2024-06-14T14:00:48Z', url: 'https://gitlab.com/Artur91425/Automaton/-/commits/master' },
			archived: false,
			fork_of: 'Someone/Automaton',
			interface: 11200,
			missing: false,
			readme: { text: '![shot](img/a.png)', base: 'https://gitlab.com/Artur91425/Automaton/-/raw/master/README.md' }
		});
		assert.equal(asked.length, 5);
	});

	test('a folder of a collection is read on the branch the link names, one folder down when need be', async () => {
		const { ask } = site({
			[`${api}/group%2Fsub%2Fcollection`]: { ...project, id: 5, path_with_namespace: 'group/sub/collection', forked_from_project: undefined },
			[`${api}/5/repository/tree?per_page=100&ref=vanilla&path=Addons`]: [
				{ name: 'One', type: 'tree' },
				{ name: '.github', type: 'tree' }
			],
			[`${api}/5/repository/files/Addons%2FOne%2FOne.toc/raw?ref=vanilla`]: '## Interface: 20400\n',
		});
		const facts = await askForge(forgePlace('https://gitlab.com/group/sub/collection/-/tree/vanilla/Addons'), ask);
		assert.equal(facts.interface, 20400);
		// The commits could not be read, so the site's own date stands in.
		assert.equal(facts.pushed_at, '2025-03-01T00:00:00Z');
		// General activity must never be shown as a public code update.
		assert.equal(facts.code_update, null);
		// Not asked for.
		assert.equal(facts.readme, null);
	});

	test('a repository that is gone is missing; a site that does not answer says nothing', async () => {
		const gone = await askForge(forgePlace('https://gitlab.com/someone/gone'), site({ [`${api}/someone%2Fgone`]: 404 }).ask);
		assert.equal(gone.missing, true);
		assert.equal(await askForge(forgePlace('https://gitlab.com/someone/slow'), site({}).ask), null);
	});
});

describe('what a Gitea site says about a repository', () => {
	const api = 'https://codeberg.org/api/v1/repos';

	test('the same facts, and the new name of a repository that was renamed', async () => {
		const { ask } = site({
			[`${api}/Old/Addon`]: {
				full_name: 'New/Addon',
				stars_count: 12,
				updated_at: '2026-01-01T00:00:00Z',
				archived: true,
				default_branch: 'main',
				parent: null
			},
			[`${api}/New/Addon/commits?limit=1&stat=false&verification=false&files=false&sha=main`]: [
				{ commit: { committer: { date: '2023-05-05T10:00:00+02:00' } } }
			],
			[`${api}/New/Addon/contents/?ref=main`]: [
				{ name: 'Addon.toc', type: 'file' },
				{ name: 'Addon-TBC.toc', type: 'file' },
				{ name: 'readme.txt', type: 'file' }
			],
			[`${api}/New/Addon/raw/Addon.toc?ref=main`]: '## Interface: 20400',
			[`${api}/New/Addon/raw/Addon-TBC.toc?ref=main`]: '##Interface: 11200',
			[`${api}/New/Addon/raw/readme.txt?ref=main`]: 'See ![a](a.png)'
		});
		assert.deepEqual(await askForge(forgePlace('https://codeberg.org/Old/Addon'), ask, true), {
			project: 'New/Addon',
			stars: 12,
			pushed_at: '2023-05-05T10:00:00+02:00',
			code_update: { date: '2023-05-05T10:00:00+02:00', url: 'https://codeberg.org/New/Addon/commits/branch/main' },
			archived: true,
			fork_of: null,
			// Several clients: the 1.12 one is what matters.
			interface: 11200,
			missing: false,
			readme: { text: 'See ![a](a.png)', base: 'https://codeberg.org/New/Addon/raw/branch/main/readme.txt' }
		});
	});

	test('an empty repository has its facts and nothing to read', async () => {
		const { ask, asked } = site({ [`${api}/someone/empty`]: { full_name: 'someone/empty', stars_count: 0, default_branch: '' } });
		const facts = await askForge(forgePlace('https://codeberg.org/someone/empty'), ask, true);
		assert.equal(facts.missing, false);
		assert.equal(facts.interface, null);
		assert.equal(asked.length, 1);
	});

	test('a web page where data was asked for is no answer', async () => {
		assert.equal(await askForge(forgePlace('https://codeberg.org/someone/addon'), site({ [`${api}/someone/addon`]: '<html>Just a moment</html>' }).ask), null);
	});
});
