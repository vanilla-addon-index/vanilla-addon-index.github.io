import assert from 'node:assert/strict';
import {test} from 'node:test';
import {suggestCategory as suggest} from '../../src/lib/category-scoring.ts';

test('ChatMonitor beats incidental minimap controls with explainable purpose evidence', () => {
	const result = suggest('ChatMonitor', 'Monitors the chat and alerts you when user-defined keywords are found. Features a nice GUI and a right-clickable minimap button to start/stop the monitoring.');
	assert.equal(result.category, 'Chat & Social');
	assert.equal(result.confidence, 'Strong match');
	assert.ok(result.matches[0].evidence.some(e => e.source === 'Name' && e.text === 'Chat'));
	assert.ok(result.matches[0].evidence.some(e => e.text === 'Monitors the chat'));
	for (const category of ['Action Bars', 'Map & Minimap']) assert.equal(result.matches.find(m => m.category === category).score, 1);
});

test('competing categories and no evidence remain uncertain without a minimum score', () => {
	assert.equal(suggest('Helper', 'Adds a button').confidence, 'Uncertain');
	assert.equal(suggest('Button', 'button button button').confidence, 'Strong match');
	const tie = suggest('ChatCombat', 'chat and combat');
	assert.equal(tie.confidence, 'Uncertain');
	assert.equal(tie.matches[0].score, tie.matches[1].score);
	assert.deepEqual(suggest('Something', 'Does useful things'), {category:'Miscellaneous', confidence:'Uncertain', matches:[]});
	assert.equal(suggest('ChatMonitor').confidence, 'Strong match');
});

test('a description-only category can be selected below the former score threshold', () => {
	for (const [name, description, category] of [
		['ShaguCopy', 'Allows you to copy chat messages', 'Chat & Social'],
		['honorcounter', 'Estimates the honor gained', 'PvP'],
		['OmniCC', 'A universal cooldown count', 'Combat']
	]) {
		const result = suggest(name, description);
		assert.equal(result.category, category);
		assert.equal(result.matches[0].score, 3);
		assert.equal(result.confidence, 'Possible match');
	}
});

test('explicit macro names outweigh README compatibility features', () => {
	for (const name of ['CleverMacro', 'SuperCleveRoidMacros(ClassicAPI)']) {
		const result = suggest(name, 'Supports unit frames and action bars. Works with keybindings.');
		assert.equal(result.category, 'Macros');
		assert.equal(result.confidence, 'Strong match');
	}
	assert.equal(suggest('Helper', 'Mentions macros, unit frames and action bars.').confidence, 'Uncertain');
});

test('repeating words, raw/camel-case names and overlapping rules cannot inflate scores', () => {
	assert.deepEqual(suggest('ChatMonitor', 'chat chat chat chat'), suggest('ChatMonitor', 'chat'));
	assert.equal(suggest('ChatMonitor').matches[0].score, suggest('Chat Monitor').matches[0].score);
	const frames = suggest('UnitFrames', 'unit frames unit frames');
	assert.equal(frames.matches[0].evidence.length, 2);
});

test('purpose phrases and negative context resolve meaningful competing signals', () => {
	for (const [name, description, expected] of [
		['BetterCharacterPanel', 'Adds equipment, spell and raid statistics', 'UI & Appearance'],
		['CerniesWonderfulFunctions', 'Script methods for using specific items and helping players create simple(er) macros', 'Macros'],
		['Iconic', 'Improves the default macro icon selection system by adding a search bar', 'Macros'],
		['HealersMate', 'Unit frames addon for healers', 'Raid & Party'],
		['TradeSkillsData', 'Provides trade skill recipes. Library addon.', 'Professions'],
		['LibramSwap', 'Smart libram swapping for paladins - no macros required.', 'Class'],
		['Helper', 'Works without replacing unit frames. Monitors chat.', 'Chat & Social'],
		['pfUI-autoinvite', 'External module for pfUI that allows auto invites through whispers', 'Chat & Social'],
		['RangeColor', 'Changes color when no mana is available', 'Combat'],
		['WorldBossAlert', "Scouting world bosses using the scout's combat log", 'Boss Mods'],
		['MacroTextStop', 'Hides macro texts in action buttons', 'Macros'],
		['Quiver-ClassicAPI', 'Hunter combat addon', 'Class'],
		['ShaguKill', 'Displays remaining kills till level up', 'Combat']
	]) assert.equal(suggest(name, description).category, expected, name);
	assert.ok(!suggest('Helper', 'No macros required').matches.some(m => m.category === 'Macros'));
});


test('every category receives the same bonus for name evidence', () => {
 for (const [name, category] of [
  ['CleverMacro','Macros'], ['QuestThing','Quests & Leveling'],
  ['ChatThing','Chat & Social'], ['BagThing','Bags & Inventory'],
  ['AuctionThing','Auction & Economy'], ['BuffThing','Buffs & Debuffs'],
  ['MapThing','Map & Minimap'], ['TooltipThing','Tooltip'],
  ['ProfessionThing','Professions'], ['HonorThing','PvP'],
  ['WarriorThing','Class'], ['RaidThing','Raid & Party'],
  ['DamageThing','Combat'], ['LibraryThing','Libraries'],
  ['SkinThing','UI & Appearance'], ['PortraitThing','Unit Frames'],
  ['ButtonThing','Action Bars'], ['EncounterThing','Boss Mods']
 ]) {
  const result = suggest(name);
  assert.equal(result.category, category, name);
  const named = result.matches[0].evidence.find(e => e.source === 'Name');
  const described = suggest('Unrelated', named.text).matches.find(m => m.category === category).evidence.find(e => e.source === 'Description');
  assert.equal(named.weight - described.weight, 13, name);
 }
 for (const [name, category] of [['CleverMacro','Macros'], ['QuestThing','Quests & Leveling'], ['ChatThing','Chat & Social'], ['AuctionThing','Auction & Economy']]) {
  assert.equal(suggest(name, 'Supports unit frames and action bars.').category, category, name);
 }
});
