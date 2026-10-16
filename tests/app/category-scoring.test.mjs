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

test('weak evidence, competing categories and no evidence remain uncertain', () => {
	assert.equal(suggest('Helper', 'Adds a button').confidence, 'Uncertain');
	assert.equal(suggest('Button', 'button button button').confidence, 'Uncertain');
	const tie = suggest('ChatCombat', 'chat and combat');
	assert.equal(tie.confidence, 'Uncertain');
	assert.equal(tie.matches[0].score, tie.matches[1].score);
	assert.deepEqual(suggest('Something', 'Does useful things'), {category:'Miscellaneous', confidence:'Uncertain', matches:[]});
	assert.equal(suggest('ChatMonitor').confidence, 'Possible match');
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
		['HealersMate', 'Unit frames addon for healers', 'Unit Frames'],
		['TradeSkillsData', 'Provides trade skill recipes. Library addon.', 'Libraries'],
		['LibramSwap', 'Smart libram swapping for paladins - no macros required.', 'Class'],
		['Helper', 'Works without replacing unit frames. Monitors chat.', 'Chat & Social'],
		['pfUI-autoinvite', 'External module for pfUI that allows auto invites through whispers', 'Chat & Social'],
		['RangeColor', 'Changes color when no mana is available', 'Combat'],
		['WorldBossAlert', "Scouting world bosses using the scout's combat log", 'Boss Mods'],
		['MacroTextStop', 'Hides macro texts in action buttons', 'Macros'],
		['Quiver-ClassicAPI', 'Hunter combat addon', 'Class'],
		['ShaguKill', 'Displays remaining kills till level up', 'Quests & Leveling']
	]) assert.equal(suggest(name, description).category, expected, name);
	assert.ok(!suggest('Helper', 'No macros required').matches.some(m => m.category === 'Macros'));
});
