import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryDescription, readmeCategoryText, tocCategoryText } from '../../src/lib/category-context.ts';
import { suggestCategory } from '../../src/lib/category-scoring.ts';

test('repository prose resolves cryptic names without replacing the wiki description', () => {
 const item = {name:'ABC', description:'A useful addon', category_context:{repository:'A quest tracker', toc:'', readme:''}};
 assert.equal(suggestCategory(item.name, item.description).confidence, 'Uncertain');
 assert.equal(suggestCategory(item.name, categoryDescription(item)).category, 'Quests & Leveling');
 assert.equal(suggestCategory(item.name, categoryDescription(item)).confidence, 'Strong match');
 assert.equal(item.description, 'A useful addon');
});

test('richer evidence resolves a name without category clues', () => {
 const item = {name:'MysteryThing', description:'', category_context:{readme:'A damage meter for your party.'}};
 assert.equal(suggestCategory(item.name, '').confidence, 'Uncertain');
 assert.equal(suggestCategory(item.name, categoryDescription(item)).category, 'Combat');
});

test('README keeps features but excludes code, badges, URLs and installation sections', () => {
 const text = '# ABC\nA [quest tracker](https://example.com/chat).\n![damage](image.png)\n```lua\nraid warnings\n```\n## Installation\nRequires action bars\n### Dependencies\nUI replacement\n## Features\nTracks quests';
 const cleaned = readmeCategoryText(text);
 assert.match(cleaned, /quest tracker/);
 assert.match(cleaned, /Tracks quests/);
 for (const unwanted of ['damage', 'raid warnings', 'action bars', 'UI replacement', 'https:']) assert.ok(!cleaned.includes(unwanted));
 assert.ok(readmeCategoryText('x'.repeat(40000)).length <= 6000);
});

test('TOC only contributes Notes metadata, including localized Notes', () => {
 assert.equal(tocCategoryText('## Interface: 11200\r\n## Notes: Quest tracker\r\n## Notes-enUS: Tracks quests\r\n## Dependencies: SomeLibrary\r\nChat.lua'), 'Quest tracker Tracks quests');
});
