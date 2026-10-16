import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createForgeRequests } from '../../src/lib/nightly-rest.ts';

const fetcher = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetcher; });
const endpoint = 'https://codeberg.org/api/v1/repos/a/Addon';
const modified = 'Wed, 14 Oct 2026 12:00:00 GMT';
const body = {id:1,full_name:'a/Addon',stars_count:3,archived:false,updated_at:'2026-10-14T12:00:00Z',default_branch:'main',parent:{full_name:'upstream/Addon'},private_unneeded_field:'omit-this'};
const json = (value, headers = {}) => new Response(JSON.stringify(value),{headers:{'content-type':'application/json', ...headers}});

test('OctoWoW metadata, history and files avoid the custom agent that triggers its HTML challenge', async () => {
	globalThis.fetch = async (_, init) => init.headers['User-Agent']
		? new Response('<html>Just a moment please...</html>', {headers:{'content-type':'text/html'}})
		: init.headers.Accept === 'application/json' ? json(body)
			: new Response('## Interface: 11200', {headers:{'content-type':'text/plain'}});
	const session = createForgeRequests();
	for (const path of ['api/v1/repos/Ade/AdeAlts', 'api/v1/repos/Ade/AdeAlts/commits?limit=1']) {
		assert.equal((await session.ask(`https://octowow.st/git/${path}`, 'json')).status, 200);
	}
	assert.equal((await session.ask('https://octowow.st/git/api/v1/repos/Ade/AdeAlts/raw/AdeAlts.toc?ref=main', 'text')).body, '## Interface: 11200');
});

test('in-flight and completed endpoint reads share one request with isolated response objects', async () => {
	let calls = 0;
	let release;
	const ready = new Promise((resolve) => {release=resolve;});
	globalThis.fetch = async () => { calls++; await ready; return json(body); };
	const hits = [];
	const session = createForgeRequests({hit:(name) => hits.push(name)});
	const first = session.ask(endpoint,'json');
	const second = session.ask(endpoint,'json');
	release();
	const [one,two] = await Promise.all([first,second]);
	one.body.stars_count = 100;
	assert.equal(two.body.stars_count,3);
	assert.equal((await session.ask(endpoint,'json')).body.stars_count,3);
	assert.equal(calls,1);
	assert.deepEqual(hits,['rest_shared_request','rest_shared_request']);
});

test('ETag metadata survives between runs, revalidates through 304, and updates its validator', async () => {
	globalThis.fetch = async () => json(body,{etag:'"one"','last-modified':modified});
	const cold = createForgeRequests({now:() => 1});
	await cold.ask(endpoint,'json');
	const cached = cold.metadata(endpoint);
	assert.ok(!JSON.stringify(cached).includes('omit-this'));
	const events = [], hits = [];
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-None-Match'],'"one"');
		assert.equal(init.headers['If-Modified-Since'],undefined);
		return new Response(null,{status:304,headers:{etag:'"two"'}});
	};
	const warm = createForgeRequests({previous:[cached],now:() => 2,hit:(name) => hits.push(name),observe:() => (event) => events.push(event)});
	assert.equal((await warm.ask(endpoint,'json')).body.stars_count,3);
	assert.equal(warm.metadata(endpoint).etag,'"two"');
	assert.equal(warm.metadata(endpoint).checkedAt,2);
	assert.equal(events[0].failed,false);
	assert.deepEqual(hits,['rest_not_modified']);
});

test('Last-Modified is used when ETag is absent, and a changed response replaces old values', async () => {
	const previous = {version:1,endpoint,checkedAt:1,lastModified:modified,body};
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-Modified-Since'],modified);
		return json({...body,stars_count:19},{etag:'"new"'});
	};
	const session = createForgeRequests({previous:[previous]});
	assert.equal((await session.ask(endpoint,'json')).body.stars_count,19);
	assert.equal(session.metadata(endpoint).etag,'"new"');
	assert.equal(session.metadata(endpoint).lastModified,undefined);
});

test('malformed cached bodies and header injection are misses; unexpected 304 retries unconditionally once', async () => {
	let calls = 0;
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-None-Match'],undefined);
		return ++calls === 1 ? new Response(null,{status:304}) : json(body,{etag:'"fresh"'});
	};
	const session = createForgeRequests({previous:[{version:1,endpoint,checkedAt:1,etag:'bad\r\nheader',body:{}}]});
	assert.equal((await session.ask(endpoint,'json')).body.id,1);
	assert.equal(calls,2);
	assert.equal(session.metadata(endpoint).etag,'"fresh"');
});

test('404 invalidates metadata; refused requests never silently reuse its body', async () => {
	const previous = {version:1,endpoint,checkedAt:1,etag:'"old"',body};
	globalThis.fetch = async () => new Response(null,{status:404});
	const missing = createForgeRequests({previous:[previous]});
	assert.deepEqual(await missing.ask(endpoint,'json'),{status:404});
	assert.equal(missing.metadata(endpoint),undefined);
	globalThis.fetch = async () => new Response('',{status:403});
	const refused = createForgeRequests({previous:[previous]});
	assert.equal(await refused.ask(endpoint,'json'),null);
});

test('conditional headers are restricted to the same repository endpoint and never sent to file reads', async () => {
	const previous = {version:1,endpoint,checkedAt:1,etag:'"old"',body};
	globalThis.fetch = async (url,init) => {
		assert.equal(init.headers['If-None-Match'],undefined);
		return url.includes('/raw/') ? new Response('## Interface:11200', {headers:{'content-type':'text/plain'}}) : json(body);
	};
	const session = createForgeRequests({previous:[previous]});
	await session.ask(endpoint + '/raw/Addon.toc?ref=main','text');
	await session.ask(endpoint + 'Fork','json');
});

test('the newest usable metadata wins and oversized metadata is not persisted', async () => {
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-None-Match'],'"new"');
		return new Response(null,{status:304});
	};
	const session = createForgeRequests({previous:[
		{version:1,endpoint,checkedAt:2,etag:'"new"',body},
		{version:1,endpoint,checkedAt:1,etag:'"old"',body}
	]});
	await session.ask(endpoint,'json');
	globalThis.fetch = async () => json({...body, full_name:'a/'+'x'.repeat(9000)},{etag:'"large"'});
	const large = createForgeRequests();
	assert.equal((await large.ask(endpoint,'json')).status,200);
	assert.equal(large.metadata(endpoint),undefined);
});

test('an incomplete saved metadata body cannot clear stars or archive status after 304', async () => {
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-None-Match'],undefined);
		return json(body,{etag:'"complete"'});
	};
	const incomplete = createForgeRequests({previous:[{version:1,endpoint,checkedAt:1,etag:'"bad"',body:{id:1,full_name:'a/Addon'}}]});
	assert.equal((await incomplete.ask(endpoint,'json')).body.stars_count,3);
});

test('GitLab metadata validators retain the fields used for subgroup and fork identity', async () => {
	const endpoint = 'https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Faddon';
	const project = {id:2,path_with_namespace:'group/subgroup/addon',star_count:5,archived:true,last_activity_at:'2026-10-14T12:00:00Z',default_branch:'vanilla',forked_from_project:{path_with_namespace:'source/addon'}};
	globalThis.fetch = async () => json(project,{etag:'"project"'});
	const cold = createForgeRequests();
	await cold.ask(endpoint,'json');
	globalThis.fetch = async (_,init) => {
		assert.equal(init.headers['If-None-Match'],'"project"');
		return new Response(null,{status:304});
	};
	const warm = createForgeRequests({previous:[cold.metadata(endpoint)]});
	assert.deepEqual((await warm.ask(endpoint,'json')).body,project);
});


test('OctoWoW repository validators survive between runs under /git', async () => {
	const url = 'https://octowow.st/git/api/v1/repos/Ade/AdeAlts';
	globalThis.fetch = async () => json(body,{etag:'"octo"'});
	const cold = createForgeRequests();
	await cold.ask(url,'json');
	const cached = cold.metadata(url);
	assert.ok(cached);
	globalThis.fetch = async (target,init) => {
		assert.equal(target,url);
		assert.equal(init.headers['If-None-Match'],'"octo"');
		return new Response(null,{status:304});
	};
	const warm = createForgeRequests({previous:[cached]});
	assert.equal((await warm.ask(url,'json')).body.stars_count,3);
});


test('OctoWoW challenge HTML is an unavailable response, preserving cached metadata', async () => {
	const endpoint = 'https://octowow.st/git/api/v1/repos/Ade/AdeAlts';
	const previous = {version:1,endpoint,checkedAt:1,etag:'"old"',body};
	globalThis.fetch = async () => new Response('<html>Just a moment please...</html>',{headers:{'content-type':'text/html'}});
	const session = createForgeRequests({previous:[previous]});
	assert.equal(await session.ask(endpoint,'json'),null);
	assert.equal(session.metadata(endpoint).body.stars_count,3);
	assert.equal(session.metadata(endpoint).etag,'"old"');
});
