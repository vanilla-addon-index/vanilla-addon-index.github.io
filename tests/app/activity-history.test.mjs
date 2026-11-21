import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeSummary, pinChange } from '../../src/lib/history.ts';

test('legacy snapshots describe pinning, changing and unpinning from recorded values', () => {
	const first = { pinned_link: 'https://octowow.st/git/olzon/MinimapButtonBag_Octo' };
	const second = { pinned_link: 'https://github.com/olzon/MinimapButtonBag' };
	const empty = { pinned_link: null };
	assert.equal(changeSummary(['pinned_link'], empty, first), 'Pinned a download link');
	assert.equal(changeSummary(['pinned_link'], first, second), 'Changed which download link is pinned');
	assert.equal(changeSummary(['pinned_link'], first, empty), 'Unpinned a download link');
	assert.equal(pinChange(first, {}), undefined);
	assert.equal(changeSummary(['pinned_link'], undefined, undefined, 'unpinned'), 'Unpinned a download link');
	assert.equal(changeSummary(['pinned_link']), 'Pinned download link edited');
});

test('summaries show all link changes and keep automatically changed fields visible', () => {
	const before = { versions: [{ url: 'a', note: 'old' }, { url: 'b' }], pinned_link: 'b' };
	const after = { versions: [{ url: 'a', note: 'new' }, { url: 'c' }], pinned_link: null };
	assert.equal(changeSummary(['versions', 'pinned_link'], before, after),
		'Download links: 1 added, 1 removed, 1 note edited · Unpinned a download link');
	assert.equal(changeSummary(['name', 'slug', 'aliases'], {}, {}),
		'Name edited · Page address edited · Previous page addresses edited');
});
