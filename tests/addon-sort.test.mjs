import assert from 'node:assert/strict';
import {test} from 'node:test';
import {byCodeUpdate, readSort} from '../src/lib/addon-sort.ts';

const addon = (name, date, added) => ({name, code_update:date ? {date, url:'https://example.invalid/history'} : null, created_at:added, updated_at:added});

test('code update order uses commit time, not index timestamps or timestamp spelling', () => {
	const rows = [
		addon('New entry', '2020-01-01T00:00:00Z', '2026-10-15'),
		addon('Latest code', '2026-10-14T23:00:00-02:00', '2020-01-01'),
		addon('Earlier code', '2026-10-15T00:00:00Z', '2026-10-15'),
		addon('Unknown', null, '2026-10-15'), addon('Invalid', 'bad date', '2026-10-15')
	];
	assert.deepEqual(rows.sort(byCodeUpdate).map(a => a.name), ['Latest code', 'Earlier code', 'New entry', 'Invalid', 'Unknown']);
	assert.ok(byCodeUpdate(addon('Alpha', null), addon('Beta', null)) < 0);
});

test('old date-sort links use code updates; unknown options use name', () => {
	for (const value of ['new', 'updated', 'code']) assert.equal(readSort(value), 'code');
	for (const value of [null, '', 'name', 'constructor', 'other']) assert.equal(readSort(value), 'name');
});
