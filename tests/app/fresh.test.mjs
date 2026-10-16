// How a visitor's list is put together from the snapshot and what the database says is
// newer; see src/lib/fresh.ts.
//
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeFresh, newestStamp, stillGone } from '../../src/lib/fresh.ts';

const row = (id, name, day, extra = {}) => ({ id, name, updated_at: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000000+00:00`, ...extra });
const names = (rows) => rows.map((r) => r.name);

describe('a visitor\'s list', () => {
	const snapshot = [row(1, 'Atlas', 3), row(2, 'Bagnon', 8), row(3, 'Cartographer', 5)];

	test('the snapshot stands for the newest stamp in it, and an empty one for the beginning', () => {
		assert.equal(newestStamp(snapshot), row(0, '', 8).updated_at);
		assert.equal(newestStamp([]), '');
	});

	test('with nothing newer, it is the snapshot', () => {
		assert.deepEqual(mergeFresh(snapshot, [], []), snapshot);
	});

	test('an addon posted since is added in its place by name, and an edited one replaces the old', () => {
		const posted = row(4, 'Auctioneer', 9);
		const edited = row(3, 'Cartographer', 10, { description: 'Edited since the snapshot.' });
		const list = mergeFresh(snapshot, [], [posted, edited]);
		assert.deepEqual(names(list), ['Atlas', 'Auctioneer', 'Bagnon', 'Cartographer']);
		assert.equal(list[3].description, 'Edited since the snapshot.');
	});

	test('what an earlier visit fetched still counts while it is newer than the snapshot', () => {
		const kept = [row(4, 'Auctioneer', 9), ...snapshot];
		assert.deepEqual(names(mergeFresh(snapshot, kept, [])), ['Atlas', 'Auctioneer', 'Bagnon', 'Cartographer']);
	});

	test('one deleted before the next snapshot drops out with it, and a renamed one is not doubled', () => {
		// The next snapshot is newer than the kept row and does not hold it: it was deleted.
		const next = [...snapshot, row(5, 'Decursive', 11)];
		assert.deepEqual(names(mergeFresh(next, [row(4, 'Auctioneer', 9)], [])), ['Atlas', 'Bagnon', 'Cartographer', 'Decursive']);
		// Renamed since: one entry, under the new name.
		assert.deepEqual(names(mergeFresh(snapshot, [], [row(1, 'Zebra', 9)])), ['Bagnon', 'Cartographer', 'Zebra']);
	});

	test('a member\'s own addons come with the answer and replace the snapshot\'s copies, which do not say whose they are', () => {
		const mine = { ...snapshot[1], owner: 'me' };
		const list = mergeFresh(snapshot, [], [mine]);
		assert.deepEqual(names(list), ['Atlas', 'Bagnon', 'Cartographer']);
		assert.equal(list[1].owner, 'me');
		assert.equal(list[0].owner, undefined);
	});

	test('what was deleted in this browser is gone at once, and forgotten when the snapshot drops it', () => {
		assert.deepEqual(names(mergeFresh(snapshot, [], [], [2])), ['Atlas', 'Cartographer']);
		// Deleted right after posting: never in a snapshot, kept from the post, and still gone.
		assert.deepEqual(names(mergeFresh(snapshot, [row(4, 'Auctioneer', 9)], [], [4])), ['Atlas', 'Bagnon', 'Cartographer']);
		assert.deepEqual(stillGone([2, 2, 9], snapshot), [2]);
		// The next snapshot no longer lists it: nothing to remember.
		assert.deepEqual(stillGone([2], [snapshot[0], snapshot[2]]), []);
	});

	test('a fresh answer wins over what was kept', () => {
		const list = mergeFresh(snapshot, [row(4, 'Old name', 9)], [row(4, 'New name', 10)]);
		assert.deepEqual(names(list), ['Atlas', 'Bagnon', 'Cartographer', 'New name']);
	});
});
