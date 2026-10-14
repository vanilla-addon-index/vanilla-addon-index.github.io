import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequester, rateLimitFailure } from '../src/lib/request.ts';

const json = (response) => response.json();
const url = 'https://example.com/data';

test('temporary failures retry with backoff, permanent failures do not', async () => {
	const waits = [];
	let calls = 0;
	const request = createRequester({ random: () => 0, sleep: async (ms) => { waits.push(ms); }, fetcher: async () => {
		calls++;
		if (calls === 1) throw new TypeError('connection reset');
		return new Response(calls === 2 ? 'unavailable' : '{"ok":true}', { status: calls === 2 ? 503 : 200 });
	} });
	assert.deepEqual(await request(url, { read: json }), { ok: true });
	assert.deepEqual(waits, [1000, 2000]);
	let refused = 0;
	const permanent = createRequester({ fetcher: async () => { refused++; return new Response('', { status: 403 }); } });
	await assert.rejects(permanent(url, { read: json }), /HTTP 403/);
	assert.equal(refused, 1);
});

test('deadlines cover stalled headers and bodies, abort requests and cap attempts', async () => {
	for (const stalled of ['headers', 'body']) {
		const signals = [];
		const request = createRequester({ sleep: async () => {}, fetcher: async (_, { signal }) => {
			signals.push(signal);
			return stalled === 'headers' ? new Promise(() => {}) : new Response('{"unfinished":', { status: 200 });
		} });
		await assert.rejects(request(url, { timeoutMs: 5, attempts: 2,
			read: stalled === 'body' ? () => new Promise(() => {}) : json }), /timed out/);
		assert.equal(signals.length, 2);
		assert.ok(signals.every((signal) => signal.aborted));
	}
});

test('Retry-After and reset headers are honoured, including later batches on the same host', async () => {
	let clock = 100_000;
	const waits = [];
	let calls = 0;
	const request = createRequester({ now: () => clock, random: () => 0,
		sleep: async (ms) => { waits.push(ms); clock += ms; },
		fetcher: async () => {
			calls++;
			return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '5' } }) : new Response('{}');
		} });
	await request(url, { read: json });
	assert.deepEqual(waits, [5000]);
	let limitedCalls = 0;
	const limited = createRequester({ now: () => clock, fetcher: async () => {
		limitedCalls++;
		return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(clock / 1000 + 3600) } });
	} });
	await assert.rejects(limited(url, { read: json }), /budget/);
	await assert.rejects(limited(url + '?next-batch', { read: json }), /budget/);
	assert.equal(limitedCalls, 1);
	const date = new Date(clock + 10_000).toUTCString();
	assert.equal(rateLimitFailure(new Response('', { headers: { 'retry-after': date } }), '', clock).retryAfterMs, 10_000);
});

test('known absence can be accepted, malformed JSON is retried and attempts remain bounded', async () => {
	const missing = createRequester({ fetcher: async () => new Response('', { status: 404 }) });
	assert.equal(await missing(url, { accept: [404], read: async (r) => r.status }), 404);
	let calls = 0;
	const invalid = createRequester({ sleep: async () => {}, fetcher: async () => { calls++; return new Response('not json'); } });
	await assert.rejects(invalid(url, { read: json, attempts: 3 }), SyntaxError);
	assert.equal(calls, 3);
});

test('permanent database errors keep their useful diagnostic without being retried', async () => {
	let calls = 0;
	const request = createRequester({ fetcher: async () => {
		calls++;
		return new Response(JSON.stringify({message:'The wiki lists far fewer addons. Nothing was queued.'}), {status:400});
	} });
	await assert.rejects(request(url, { read: json, errorMessage: async (r) => (await r.json()).message }), /Nothing was queued/);
	assert.equal(calls, 1);
});
