import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readOctowow } from '../../src/lib/octowow.ts';
import { repositoryRoot } from '../../src/lib/mirrors.ts';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const json = body => new Response(JSON.stringify(body));

test('discovery reads every page and leaves classification to admin review', async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		assert.equal(init.headers.Accept, 'application/json');
		assert.equal(new Headers(init.headers).has('user-agent'), false);
		calls.push(url);
		return json({ok:true, data: calls.length === 1 ? [
			{full_name:'Ade/AdeAlts', name:'AdeAlts', description:'Tracks alts'},
			{full_name:'Ade/Private', name:'Private', private:true},
			{full_name:'Ade/Empty', name:'Empty', empty:true}
		] : calls.length === 2 ? [{full_name:'Someone/OldAddon', name:'OldAddon', archived:true}] : []});
	};
	const candidates = await readOctowow();
	assert.equal(calls.length, 3);
	assert.match(calls[1], /page=2/);
	assert.deepEqual(candidates.map(c => [c.url, c.category, c.obsolete]), [
		['https://octowow.st/git/Ade/AdeAlts', '', false],
		['https://octowow.st/git/Someone/OldAddon', '', true]
	]);
	assert.equal(candidates[0].key, 'octowow.st/git/ade/adealts');
});

test('invalid responses and repeating pagination fail before returning candidates', async () => {
	for (const body of [{}, {ok:false, data:[]}, {ok:true,data:[{name:'Broken'}]}]) {
		globalThis.fetch = async () => json(body);
		await assert.rejects(readOctowow(), /OctoWoW/);
	}
	globalThis.fetch = async () => new Response('<html>Verifying your browser</html>');
	await assert.rejects(readOctowow());
	globalThis.fetch = async () => json({ok:true,data:[{full_name:'Ade/AdeAlts',name:'AdeAlts'}]});
	await assert.rejects(readOctowow(), /repeated/);
});

test('discovery reports explicit mirrors without dropping any candidate', async () => {
	const repos = [
		{full_name:'lightblade/CombatLedger', name:'CombatLedger', mirror:true, original_url:'https://github.com/akzkak/CombatLedger.git'},
		{full_name:'someone/Fork', name:'Fork', fork:true, original_url:'https://github.com/akzkak/CombatLedger'},
		{full_name:'someone/Unknown', name:'Unknown', mirror:true, original_url:'https://github.com/akzkak/CombatLedger/tree/main'}
	];
	globalThis.fetch = async url => json({ok:true, data: new URL(url).searchParams.get('page') === '1' ? repos : []});
	assert.deepEqual((await readOctowow()).map(candidate => candidate.mirror_source), [
		'https://github.com/akzkak/CombatLedger', null, null
	]);
});

test('mirror identity requires a supported repository root', () => {
	assert.equal(repositoryRoot('https://gitlab.com/group/subgroup/project'), 'https://gitlab.com/group/subgroup/project');
	assert.equal(repositoryRoot('https://octowow.st/git/lightblade/CombatLedger'), 'https://octowow.st/git/lightblade/CombatLedger');
	for (const url of [
		'https://gitlab.com/group/project/-/tree/main',
		'https://github.com/akzkak/CombatLedger/tree/main/Addon',
		'https://github.com/akzkak/CombatLedger?ref=main',
		'https://github.com/akzkak/CombatLedger/../Other',
		'https://codeberg.org/owner/repo/src/branch/main',
		'https://unknown.example/owner/repo'
	]) assert.equal(repositoryRoot(url), null, url);
});
