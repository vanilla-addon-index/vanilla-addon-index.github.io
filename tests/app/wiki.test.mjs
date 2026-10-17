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
import { CATEGORIES } from '../../src/lib/config.ts';
import { parseWiki } from '../../src/lib/wiki.ts';
import { suggestCategory } from '../../src/lib/category-scoring.ts';

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
const CATEGORY_TOTALS = {
	"Action Bars": 25,
	"Auction & Economy": 41,
	"Bags & Inventory": 30,
	"Boss Mods": 19,
	"Buffs & Debuffs": 45,
	"Chat & Social": 73,
	"Class": 92,
	"Combat": 109,
	"Libraries": 4,
	"Loot Distribution": 25,
	"Macros": 12,
	"Map & Minimap": 30,
	"Professions": 26,
	"PvP": 23,
	"Quests & Leveling": 60,
	"Raid & Party": 76,
	"Roleplay": 7,
	"Tooltip": 17,
	"UI & Appearance": 45,
	"Unit Frames": 49,
	"Miscellaneous": 0
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
		assert.equal(candidates[0].category, 'UI & Appearance');
		assert.equal(candidates[0].description, 'Improves the character and inspect panel');
		assert.equal(candidates[0].url, 'https://github.com/a/BetterCharacterPanel');
	});
	test('a link marked alt becomes an entry of its own, as a version of the first', () => {
		const { candidates } = read('* [https://github.com/a/Bagnon Bagnon] one big bag [https://github.com/b/Bagnon (alt)] [https://gitlab.com/c/bagnon (Alt 2)]');
		assert.deepEqual(
			candidates.map((c) => [c.key, c.name, c.description, c.category, c.group_key]),
			[
				['github.com/a/bagnon', 'Bagnon', 'one big bag', 'Bags & Inventory', null],
				['github.com/b/bagnon', 'Bagnon', '', 'Bags & Inventory', 'github.com/a/bagnon'],
				['gitlab.com/c/bagnon', 'Bagnon', '', 'Bags & Inventory', 'github.com/a/bagnon']
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

describe('the category is guessed from the name and the description', () => {
	const guess = (name, description = '') => suggestCategory(name, description).category;

	test('one addon for each category', () => {
		const cases = [
			['LibStub', '', 'Libraries'],
			['BigWigs', 'Boss encounter warnings', 'Boss Mods'],
			['LunaUnitFrames', 'unit frames', 'Unit Frames'],
			['Bartender', 'replaces the action bars', 'Action Bars'],
			['Bagnon', 'all your bags in one window', 'Bags & Inventory'],
			['Auctionator', 'A lightweight addon designed to help manage auctions.', 'Auction & Economy'],
			['SexyMap', 'A prettier minimap', 'Map & Minimap'],
			['pfQuest', 'quest helper and database', 'Quests & Leveling'],
			['BuffWatch', 'shows what is on your group', 'Buffs & Debuffs'],
			['WIM', 'brings an instant messenger feel to communication in game', 'Chat & Social'],
			['TinyTip', 'changes the look of your GameTooltip', 'Tooltip'],
			['Artisan', 'Compact professions window', 'Professions'],
			['BGFlag', 'status of the Alliance and Horde flags', 'PvP'],
			['Quiver', 'Hunter auto shot timer, castbar, and more', 'Class'],
			['RollFor', 'An automated item roller for raids', 'Loot Distribution'],
			['RaidHelper', 'Raid assignments and ready checks', 'Raid & Party'],
			['TurtleRP', 'An RP addon custom-made for turtle', 'Roleplay'],
			['KillTrack', 'Tracks any and all mob kills for you.', 'Combat'],
			['SpartanUI', 'moves the interface elements to the bottom', 'UI & Appearance'],
			['CleverMacro', 'Adds extra slash commands for use in macros', 'Macros'],
			['MoveAnything', 'Lets you move, scale, and hide anything at all', 'Miscellaneous']
		];
		for (const [name, description, expected] of cases) assert.equal(guess(name, description), expected, name);
		// Every category has a case, so a rule cannot be lost without a test noticing.
		assert.deepEqual([...new Set(cases.map((c) => c[2]))].sort(), [...CATEGORIES].sort());
	});

	test('visual addons fit UI & Appearance while functional categories keep priority', () => {
		for (const [name, description] of [
			["Beardley's Diablo Orbs", 'is a backported Diablo like UI'],
			['SimpleSkin', 'A new skin for the interface'],
			['DarkTheme', 'Darker textures and decorative elements'],
			['pfUI', 'A full UI replacement']
		]) assert.equal(guess(name, description), 'UI & Appearance', name);
		assert.equal(guess('PrettyBars', 'A themed action bar replacement'), 'Action Bars');
		assert.equal(guess('PrettyTooltip', 'A new tooltip skin'), 'Tooltip');
		assert.equal(guess('PrettyMinimap', 'A minimap theme'), 'Map & Minimap');
	});

	test('words joined up in a name count as words', () => {
		assert.equal(guess('AdvancedTradeSkillWindow2', 'Improved window'), 'Professions');
		assert.equal(guess('RaidSummon', 'small frame'), 'Raid & Party');
		assert.equal(guess('TurtlePvp', 'Broadcasts your location'), 'PvP');
	});

	test('character and inspect panels are UI addons even when they describe equipment or spells', () => {
		for (const [name, description] of [
			['Better Character Panel', 'Improves the default character and inspect panel by adding enchants effects and more! Made for TWoW'],
			['BetterCharacterPanel', 'Improved equipment and spell statistics'],
			['BetterCharacterStats', 'Backports the TBC character stats panel, collecting primary and secondary stats like spellpower, hit, crit'],
			['InspectPlus', 'Overhauls the inspection pane for raid gear checks'],
			['PaperDoll', 'Improves the character window'],
			['InspectFrame', 'Adds equipment statistics']
		]) assert.equal(guess(name, description), 'UI & Appearance', name);
		assert.equal(guess('GearCheck', 'Inspect equipment for raids'), 'Bags & Inventory');
		assert.equal(guess('PanelHelper', 'Improves a panel'), 'Miscellaneous');
	});

	test('plurals count too', () => {
		assert.equal(guess('CThunWarner', "Provides information for C'Thun raids"), 'Boss Mods');
		assert.equal(guess('Crusader', 'Sphere addon for Paladins'), 'Class');
		assert.equal(guess('AuctionAltBuy', 'Alt-Click auctions to buy and cancel instantly'), 'Auction & Economy');
	});

	test('macro utilities get their own category while incidental macros keep functional categories', () => {
		for (const [name, description] of [
			['CerniesWonderfulFunctions', 'Script methods for using specific items and helping players create simple(er) macros'],
			['CleverMacro', 'Adds extra slash commands for use in macros'],
			['CleveRoidMacros', 'More advanced and modern style macros'],
			['PlayerStates', 'Macro Helper addon'],
			['Iconic', 'Improves the default macro icon selection system by adding a search bar'],
			['MacroTT-V', 'Create tooltips for your macros'],
			['MacroDebug', 'A macro debugger'],
			['UltimaMacros', 'A lightweight, self-contained macro system']
		]) assert.equal(guess(name, description), 'Macros', name);
		assert.equal(guess('TotemBar', 'Shaman totem bar usable from a single macro or keybind'), 'Class');
		assert.equal(guess('LibramSwap', 'Adds automatic smart libram swapping for paladins - no macros required.'), 'Class');
		assert.equal(guess('Flyout', 'Using a macro creates a flyout action button for spells'), 'Action Bars');
	});

	test('battleground names and abbreviations identify PvP addons', () => {
		assert.equal(guess('Avbars', 'Graphical Timers for Events in AV and AB'), 'PvP');
		for (const battleground of ['AV', 'AB', 'WSG', 'Alterac Valley', 'Arathi Basin', 'Warsong Gulch', 'BGs']) {
			assert.equal(guess('EventTimers', `Timers for ${battleground}`), 'PvP', battleground);
			assert.equal(guess('EventTimers', `Timers for ${battleground.toLowerCase()}`), 'PvP', battleground);
		}
	});

	test('class descriptions are considered alongside higher-priority name clues', () => {
		assert.equal(guess('SP_SwingTimer', 'Warrior Swing Timer'), 'Combat');
		assert.equal(guess('AutoLock', 'Priority-based spell rotation addon for Warlocks.'), 'Class');
		assert.equal(guess('LibramSwap', 'Adds automatic smart libram swapping for paladins - no macros required.'), 'Class');
	});

	test('a word that only looks like a rule does not decide', () => {
		assert.equal(guess('AvailableTabs', 'Available tabs for the interface'), 'Miscellaneous');
		assert.equal(guess('MouseLookLock', 'sets up a simple perma-mouselook.'), 'Miscellaneous');
		assert.equal(guess('BetterBabelFish', 'Better babel talk between factions'), 'Miscellaneous');
		assert.equal(guess('HideErrorFrame', 'Removes the error messages that spam your screen'), 'Miscellaneous');
		assert.equal(guess('RosterFilter', 'a guild frame based on aux'), 'Chat & Social');
	});
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
			assert.ok(c.category === '' || CATEGORIES.includes(c.category), c.name);
			assert.ok(c.images.length <= 5, c.name);
		}
	});

	test('only confident suggestions preselect a category; uncertain entries need a manual choice', () => {
		assert.equal(candidates.find((c) => c.key === 'github.com/topfreestyle/avbars')?.category, 'PvP');
		const per = Object.fromEntries(CATEGORIES.map((category) => [category, count((c) => c.category === category)]));
		assert.deepEqual(per, CATEGORY_TOTALS);
		assert.equal(count(c => c.category === ''), 274);
	});
});
