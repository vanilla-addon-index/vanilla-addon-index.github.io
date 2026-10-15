import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOlderAddon } from '../src/lib/addon-age.ts';

test('age filtering uses the import review calendar-year cutoff and keeps unknown dates', () => {
	const now = new Date(2026, 9, 15);
	assert.equal(isOlderAddon('2018-12-31', now), true);
	assert.equal(isOlderAddon('2017-01-01', now), true);
	assert.equal(isOlderAddon('2019-01-01', now), false);
	for (const date of [undefined, null, '', 'invalid']) assert.equal(isOlderAddon(date, now), false);
	assert.equal(isOlderAddon('2019-06-01', new Date(2027, 0, 1)), true);
});
