import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wikiSubmission } from '../../src/lib/wiki-submission.ts';

const addon = { name: 'Blockvalue', description: 'Shows your total block value.', versions: [{ url: 'https://github.com/sondli/blockvalue', note: '' }], images: [], author: '', category: 'Combat' };

test('generates a wiki entry without a leading bullet and links to the wiki editor', () => {
	const entry = wikiSubmission(addon);
	assert.equal(entry.markup, '[https://github.com/sondli/blockvalue Blockvalue] - Shows your total block value.');
	assert.equal(entry.href, 'https://turtle-wow.fandom.com/wiki/Addons?veaction=edit');
});

test('image labels match the wiki and unsafe links are excluded', () => {
	const entry = wikiSubmission({ ...addon, images: ['https://example.com/one.png', 'javascript:alert(1)', 'https://example.com/two.png'] });
	assert.ok(entry.markup.endsWith(' [https://example.com/one.png [Img1]] [https://example.com/two.png [Img2]]'));
	assert.equal(entry.images.length, 2);
});

test('user text cannot introduce wiki templates, links, HTML or extra bullets', () => {
	const entry = wikiSubmission({ ...addon, description: 'Text\n* {{template}} [[Page]] <b>bold</b> & &#123;' });
	assert.equal(entry.description, 'Text * {{template}} [[Page]] <b>bold</b> & &#123;');
	assert.equal(entry.markup.includes('\n'), false);
	assert.ok(entry.markup.includes('&#123;&#123;template&#125;&#125;'));
	assert.ok(entry.markup.includes('&#91;&#91;Page&#93;&#93;'));
	assert.ok(entry.markup.includes('&#60;b&#62;'));
	assert.ok(entry.markup.includes('&#38; &#38;#123;'));
});
