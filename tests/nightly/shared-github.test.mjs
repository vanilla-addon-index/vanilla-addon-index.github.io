import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldFailed, githubRepositoryKey, sharedGithubChecks } from '../../src/lib/nightly-github.ts';

const rows = [{owner:'A', name:'Addon', url:'one'}, {owner:'a', name:'addon', url:'two'}, {owner:'fork', name:'addon', url:'fork'}];
test('one repository field serves equivalent links while forks keep independent results', async () => {
	let saved = 0;
	const response = await sharedGithubChecks(rows, githubRepositoryKey, () => 'id', async (query) => {
		assert.equal((query.match(/repository\(/g) ?? []).length, 2);
		return {data:{r0:{id:'shared'},r1:{id:'fork'}},errors:[]};
	}, (count) => { saved = count; });
	assert.equal(saved, 1);
	assert.deepEqual(response.data, {r0:{id:'shared'},r1:{id:'shared'},r2:{id:'fork'}});
});

test('shared partial errors and missing repositories expand to every affected original link', async () => {
	const response = await sharedGithubChecks(rows, githubRepositoryKey, () => 'id', async () => ({
		data:{r0:null,r1:{id:'fork'}}, errors:[{type:'NOT_FOUND',path:['r0']},{type:'INTERNAL',path:['r1','head1']}]
	}));
	assert.deepEqual([...response.gone], ['r0','r1']);
	assert.equal(fieldFailed(response.errors, ['r0','id']), true);
	assert.equal(fieldFailed(response.errors, ['r1','id']), true);
	assert.equal(fieldFailed(response.errors, ['r2','head1']), true);
	assert.equal(fieldFailed(response.errors, ['r2','head']), false);
});

test('global and unexpected errors cannot be lost when aliases are shared', async () => {
	for (const error of [{type:'INTERNAL'}, {type:'INTERNAL',path:['unrecognized']}]) {
		const response = await sharedGithubChecks(rows, githubRepositoryKey, () => 'id', async () => ({data:{r0:{id:'x'}},errors:[error]}));
		for (const alias of ['r0','r1','r2']) assert.equal(fieldFailed(response.errors,[alias,'id']), true);
	}
});
