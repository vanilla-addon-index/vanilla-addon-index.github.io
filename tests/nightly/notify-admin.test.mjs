import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyAdmin } from '../../scripts/notify-admin.mjs';

function run(counts,title) {
 const calls=[];
 notifyAdmin({repo:'example/repo',tell:'admin',counts},args=>{
  calls.push(args);
  return args[0]==='issue' && args[1]==='list' ? JSON.stringify(title?[{number:12,title}]:[]) : '';
 });
 return calls;
}
const has=(calls,action)=>calls.some(args=>args[0]==='issue'&&args[1]===action);

test('imports alone create an assigned issue with a direct queue link',()=>{
 const calls=run({reports:0,suggestions:0,imports:2});
 const create=calls.find(args=>args[1]==='create'&&args[0]==='issue');
 assert.ok(create);assert.ok(create.includes('admin'));
 assert.ok(create.includes('Waiting for an admin: 0 reports, 0 suggestions, 2 imports'));
 assert.match(create[create.indexOf('--body')+1],/https:\/\/vanilla-addon-index.github.io\/admin\/import/);
});

test('unchanged counts stay quiet; decreases update without notifying',()=>{
 const title='Waiting for an admin: 1 reports, 2 suggestions, 3 imports';
 assert.equal(has(run({reports:1,suggestions:2,imports:3},title),'edit'),false);
 const calls=run({reports:0,suggestions:1,imports:2},title);
 assert.equal(has(calls,'edit'),true);assert.equal(has(calls,'comment'),false);
});

test('new imports notify even when the overall total falls, and old titles remain compatible',()=>{
 for(const title of ['Waiting for an admin: 9 reports, 0 suggestions, 1 imports','Waiting for an admin: 9 reports, 0 suggestions']) {
  assert.equal(has(run({reports:0,suggestions:0,imports:2},title),'comment'),true);
 }
});

test('empty queues close the issue and missing counts cannot accidentally close it',()=>{
 assert.equal(has(run({reports:0,suggestions:0,imports:0},'Waiting for an admin: 0 reports, 0 suggestions, 1 imports'),'close'),true);
 assert.equal(has(run({reports:0,suggestions:0,imports:0}),'create'),false);
 assert.throws(()=>run({reports:0,suggestions:0}),/Missing or invalid imports/);
});
