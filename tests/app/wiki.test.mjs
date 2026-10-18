// What the wiki parser makes of the wiki's markup: each rule on a small piece of it, and
// the whole page as it once was.
//
//   npm test
//
// Nothing here talks to the wiki. fixtures/wiki-addons.wikitext is the "Addons" page of the
// Turtle WoW Wiki (turtle-wow.fandom.com/wiki/Addons) at revision 23801, whose text is
// licensed CC BY-SA.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseWiki } from '../../src/lib/wiki.ts';

// What the saved page gives. See the last group of tests.
const TOTALS = {
	candidates: 1082,
	fromTables: 59,
	repeated: 6,
	problems: 2,
	withScreenshots: 247,
	withOtherVersions: 33,
	versionsOfAnother: 34,
	nested: 5,
	obsolete: 4,
	wikiPages: 38,
	withoutDescription: 34,
	foldersOfCollections: 5
};

// The page is found by its headings; everything between them is the test's own.
const page = ({ list = '', superwow = '', classicapi = '' }) =>
	[
		'intro',
		'===Full Addons List===',
		list,
		'==SuperWoW Addons==',
		superwow,
		'==ClassicAPI Addons==',
		classicapi,
		'==Further Addons Collections==',
		'outro'
	].join('\n');
const read = (list) => parseWiki(page({ list }));
const only = (list) => {
	const { candidates, problems } = read(list);
	assert.deepEqual(problems, []);
	assert.equal(candidates.length, 1);
	return candidates[0];
};

describe('a bullet of the list', () => {
	test('starts with a link: its label is the name, the rest the description', () => {
		assert.deepEqual(only('* [https://github.com/Someone/Atlas Atlas] - View maps of dungeons and raids'), {
			key: 'github.com/someone/atlas',
			name: 'Atlas',
			url: 'https://github.com/Someone/Atlas',
			description: 'View maps of dungeons and raids',
			images: [],
			alts: [],
			category: '',
			obsolete: false,
			parent: null,
			group_key: null
		});
	});

	test('the link can be written in each of the three ways the page uses', () => {
		for (const link of [
			'[https://github.com/a/b Name]',
			'[[https://github.com/a/b Name]]',
			'[https://github.com/a/b [Name]]'
		]) {
			const entry = only(`* ${link} does a thing`);
			assert.equal(entry.name, 'Name', link);
			assert.equal(entry.url, 'https://github.com/a/b', link);
			assert.equal(entry.description, 'does a thing', link);
		}
	});

	test('wiki markup is taken out of the name and the description', () => {
		const entry = only("* [https://github.com/a/b '''Bold''' Name] : ''a'' <big>big</big> [[Some page|thing]]<br /> here");
		assert.equal(entry.name, 'BoldName');
		assert.equal(entry.description, 'a big thing here');
	});

	test('square brackets inside nowiki are text, not a link', () => {
		const entry = only('* [https://github.com/a/b Name] uses <nowiki>[target=mouseover]</nowiki> in macros');
		assert.equal(entry.description, 'uses (target=mouseover) in macros');
		assert.deepEqual(entry.alts, []);
	});

	test('an addon with a wiki page of its own links to that page', () => {
		const entry = only('* [[Turtle Dungeon Timer|TDT]] times your dungeon runs');
		assert.equal(entry.name, 'TDT');
		assert.equal(entry.url, 'https://turtle-wow.fandom.com/wiki/Turtle_Dungeon_Timer');
		assert.equal(entry.description, 'times your dungeon runs');
	});

	test('links marked img are screenshots, at most six, and https only', () => {
		const shots = Array.from({ length: 7 }, (_, i) => `[https://i.imgur.com/${i}.png (img)]`).join(' ');
		const entry = only(`* [https://github.com/a/b Name] shows things ${shots} [http://plain.example/x.png (img)]`);
		assert.equal(entry.description, 'shows things');
		assert.deepEqual(entry.images, [0, 1, 2, 3, 4, 5].map((i) => `https://i.imgur.com/${i}.png`));
	});

	test('"(obsolete)" marks the entry and comes off the name', () => {
		const entry = only('* [https://github.com/a/b Old Thing (obsolete)] replaced long ago');
		assert.equal(entry.name, 'OldThing');
		assert.equal(entry.obsolete, true);
		assert.equal(only('* [https://github.com/a/c Thing] is deprecated now').obsolete, true);
		assert.equal(only('* [https://github.com/a/d Thing] works fine').obsolete, false);
	});

	test('a nested bullet belongs to the bullet above it', () => {
		const { candidates } = read(
			['* [https://github.com/a/pfquest pfQuest] quest helper', '** [https://github.com/a/pfquest-turtle pfQuest-turtle] its Turtle data', '* [https://github.com/a/other Other] thing'].join('\n')
		);
		assert.deepEqual(
			candidates.map((c) => [c.name, c.parent]),
			[
				['pfQuest', null],
				['pfQuest-turtle', 'pfQuest'],
				['Other', null]
			]
		);
	});

	test('a bullet that cannot be read is reported, not guessed at', () => {
		const { candidates, problems } = read(
			['* Just some words about addons', '* [http://example.com/addon Plain] not https', '* [https://github.com/a/b Good] fine', 'A line that is no bullet'].join('\n')
		);
		assert.deepEqual(candidates.map((c) => c.name), ['Good']);
		assert.deepEqual(problems.map((p) => p.problem), ['does not start with a link', 'link is not https']);
	});
});

describe('versions and repeats', () => {
	test('import names have no whitespace across bullets, tables, mirrors and parent references', () => {
		const { candidates } = parseWiki(page({
			list: '* [https://github.com/a/BetterCharacterPanel Better Character Panel] Improves the character and inspect panel [https://github.com/b/BetterCharacterPanel Alt]\n** [https://github.com/a/Child Child Addon] extension',
			superwow: '|[https://github.com/a/Table Table\u00a0Addon]\n|A useful description',
			classicapi: '|[https://github.com/a/Other Other Addon]\n|Another description'
		}));
		assert.deepEqual(candidates.map((c) => c.name), ['BetterCharacterPanel', 'ChildAddon', 'TableAddon', 'OtherAddon', 'BetterCharacterPanel']);
		assert.equal(candidates[1].parent, 'BetterCharacterPanel');
		assert.equal(candidates[0].category, '');
		assert.equal(candidates[0].description, 'Improves the character and inspect panel');
		assert.equal(candidates[0].url, 'https://github.com/a/BetterCharacterPanel');
	});
	test('a link marked alt becomes an entry of its own, as a version of the first', () => {
		const { candidates } = read('* [https://github.com/a/Bagnon Bagnon] one big bag [https://github.com/b/Bagnon (alt)] [https://gitlab.com/c/bagnon (Alt 2)]');
		assert.deepEqual(
			candidates.map((c) => [c.key, c.name, c.description, c.category, c.group_key]),
			[
				['github.com/a/bagnon', 'Bagnon', 'one big bag', '', null],
				['github.com/b/bagnon', 'Bagnon', '', '', 'github.com/a/bagnon'],
				['gitlab.com/c/bagnon', 'Bagnon', '', '', 'github.com/a/bagnon']
			]
		);
		assert.deepEqual(candidates[0].alts, ['https://github.com/b/Bagnon', 'https://gitlab.com/c/bagnon']);
	});

	test('the same link listed twice is one entry, and counted', () => {
		const { candidates, repeated } = read(
			['* [https://github.com/a/Atlas Atlas] first', '* [https://github.com/A/atlas.git Atlas again] second', '* [https://github.com/a/Atlas/tree/master Atlas branch] third'].join('\n')
		);
		assert.deepEqual(candidates.map((c) => c.description), ['first']);
		assert.equal(repeated, 2);
	});

	test('two folders of one repository are two entries', () => {
		const { candidates, repeated } = read(
			['* [https://github.com/a/collection/tree/master/Atlas Atlas] maps', '* [https://github.com/a/collection/tree/master/Bagnon Bagnon] bags'].join('\n')
		);
		assert.deepEqual(candidates.map((c) => c.key), ['github.com/a/collection/atlas', 'github.com/a/collection/bagnon']);
		assert.equal(repeated, 0);
	});
});

describe('the tables further down the page', () => {
	const table = ['{| class="wikitable"', '|-', '|[https://github.com/a/SuperThing SuperThing]', '|Needs SuperWoW to work', '|-', '|[https://github.com/a/Atlas Atlas again]', '|Already in the list', '|}'].join('\n');

	test('add the addons the list does not have, with the next cell as the description', () => {
		const { candidates, fromTables } = parseWiki(page({ list: '* [https://github.com/a/Atlas Atlas] maps', superwow: table }));
		assert.equal(fromTables, 1);
		assert.deepEqual(
			candidates.map((c) => [c.name, c.description]),
			[
				['Atlas', 'maps'],
				['SuperThing', 'Needs SuperWoW to work']
			]
		);
	});

	test('are read in both sections', () => {
		const { fromTables } = parseWiki(page({ classicapi: table }));
		assert.equal(fromTables, 2);
	});
});

test('a page that has lost one of its headings is refused, not half read', () => {
	assert.throws(() => parseWiki('===Full Addons List===\n* [https://github.com/a/b Name] thing'), /no longer has the section/);
});

describe('the whole page, as it was at revision 23801', () => {
	const { candidates, problems, fromTables, repeated } = parseWiki(
		readFileSync(new URL('../fixtures/wiki-addons.wikitext', import.meta.url), 'utf8')
	);
	const count = (test) => candidates.filter(test).length;

	// A change to the parser that moves one of these numbers is either a fix, and the
	// number is updated with a word on why, or a mistake.
	test('gives the same entries as before', () => {
		assert.deepEqual(
			{
				candidates: candidates.length,
				fromTables,
				repeated,
				problems: problems.length,
				withScreenshots: count((c) => c.images.length > 0),
				withOtherVersions: count((c) => c.alts.length > 0),
				versionsOfAnother: count((c) => c.group_key),
				nested: count((c) => c.parent),
				obsolete: count((c) => c.obsolete),
				wikiPages: count((c) => c.url.startsWith('https://turtle-wow.fandom.com/')),
				withoutDescription: count((c) => !c.description),
				foldersOfCollections: count((c) => c.key.split('/').length > 3 && c.key.startsWith('github.com/'))
			},
			TOTALS
		);
	});

	test('every entry is one the import queue would take', () => {
		assert.equal(new Set(candidates.map((c) => c.key)).size, candidates.length);
		for (const c of candidates) {
			assert.match(c.url, /^https:\/\/\S+$/, c.name);
			assert.notEqual(c.name, '', c.url);
		assert.doesNotMatch(c.name, /\s/, c.url);
			assert.equal(c.category, '', c.name);
			assert.ok(c.images.length <= 5, c.name);
		}
	});

	test('every import requires a manual category choice', () => {
		assert.ok(candidates.every(c => c.category === ''));
	});
});
