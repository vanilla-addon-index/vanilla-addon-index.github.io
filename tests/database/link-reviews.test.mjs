import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addon, createDb, post, NIGHTLY_TOKEN } from '../helpers/db.mjs';

test('members suggest links without publishing; admins approve with contributor provenance', async () => {
	const db = await createDb();
	try {
		const author = await db.addUser('author'), member = await db.addUser('member'), other = await db.addUser('other'), admin = await db.addUser('admin', 'admin');
		const a = await post(db, author, addon('Widget'));
		const url = 'https://octowow.st/git/member/Widget';
		const call = (user, sql, params = []) => db.as(user, q => q(sql, params));
		const submit = user => call(user, 'select public.request_addon_link($1,$2)', [a.id, url]);
		await submit(member);
		assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions, a.versions);
		assert.equal((await db.sql('select owner from public.addons'))[0].owner, author.id);
		const [request] = await db.sql('select * from public.addon_link_requests');
		assert.deepEqual(await call(other, 'select * from public.addon_link_requests'), []);
		assert.equal((await call(member, 'select * from public.addon_link_requests')).length, 1);
		await assert.rejects(submit(other), /waiting for admin review/);
		await assert.rejects(call(member, 'select public.decide_addon_link($1,true)', [request.id]), /Only admins/);
		const [waiting] = await db.sql('select public.nightly_waiting($1) as totals', [NIGHTLY_TOKEN]);
		assert.equal(waiting.totals.suggestions, 1);
		await call(admin, 'select public.decide_addon_link($1,true)', [request.id]);
		const [live] = await db.sql('select * from public.addons');
		assert.deepEqual(live.versions.map(v => v.url), [a.repo_url, url]);
		assert.equal(live.shared, true);
		assert.equal((await call(member, 'select public.addon_contribution_access($1) as access', [a.id]))[0].access.can_propose, true);
		assert.deepEqual((await call(member, 'select public.addon_contribution_access($1) as access', [a.id]))[0].access.links, [url]);
		const preview = await call(admin, "select public.rollback_account($1,'1970-01-01',true) as result", [member.id]);
		assert.equal(preview[0].result.steps.length, 1);
		assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions, live.versions);
		await assert.rejects(call(admin, 'select public.decide_addon_link($1,true)', [request.id]), /no longer pending/);
		await assert.rejects(submit(member), /already listed/);
	} finally { await db.close(); }
});

test('daily link suggestion allowance is enforced and banned proposers cannot be approved', async () => {
	const db = await createDb();
	try {
		const member = await db.addUser('member'), admin = await db.addUser('admin', 'admin');
		const a = await post(db, member, addon('Widget'));
		for (let i = 0; i < 20; i++) await db.as(member, q => q('select public.request_addon_link($1,$2)', [a.id, `https://github.com/member/fork${i}`]));
		await assert.rejects(db.as(member, q => q('select public.request_addon_link($1,$2)', [a.id, 'https://github.com/member/overflow'])), /at most 20 links/);
		await db.sql('update public.profiles set banned=true where id=$1', [member.id]);
		const [{id}] = await db.sql('select id from public.addon_link_requests order by id limit 1');
		await assert.rejects(db.as(admin, q => q('select public.decide_addon_link($1,true)', [id])), /banned/);
		await db.as(admin, q => q('select public.decide_addon_link($1,false)', [id]));
		assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions, a.versions);
	} finally { await db.close(); }
});

test('same-name submission queues a suggestion and direct owner changes cannot bypass review', async () => {
	const db = await createDb();
	try {
		const author = await db.addUser('author'), member = await db.addUser('member'), admin = await db.addUser('admin', 'admin');
		const a = await post(db, author, addon('Widget'));
		const url = 'https://github.com/member/fork';
		const call = (user, sql, params = []) => db.as(user, q => q(sql, params));
		await call(member, 'select public.submit_addon($1::jsonb)', [JSON.stringify({name:'widget',versions:[{url}]})]);
		assert.equal((await db.sql('select * from public.addon_link_requests')).length, 1);
		await assert.rejects(call(author, 'update public.addons set versions=versions || $1::jsonb where id=$2', [JSON.stringify([{url:'https://github.com/author/extra'}]), a.id]), /require admin review|Only an admin/);
		await assert.rejects(call(member, 'select public.submit_addon_before_link_reviews($1::jsonb)', ['{}']), /permission denied/);
		await assert.rejects(db.asVisitor(q => q('select public.request_addon_link($1,$2)', [a.id,url])), /permission denied/);
		const [{id}] = await db.sql('select id from public.addon_link_requests');
		await call(admin, 'select public.decide_addon_link($1,false)', [id]);
		assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions, a.versions);
		await call(admin, 'select public.request_addon_link($1,$2)', [a.id,url]);
		assert.equal((await db.sql('select versions from public.addons'))[0].versions.length, 2);
	} finally { await db.close(); }
});

test('invalid, banned and duplicate suggestions are refused; withdrawal leaves the page unchanged', async () => {
	const db = await createDb();
	try {
		const member = await db.addUser('member'), banned = await db.addUser('banned');
		await db.sql('update public.profiles set banned=true where id=$1', [banned.id]);
		const a = await post(db, member, addon('Widget'));
		const call = (user, sql, params = []) => db.as(user, q => q(sql, params));
		for (const url of ['http://github.com/a/b','https://evil.example/a/b']) await assert.rejects(call(member, 'select public.request_addon_link($1,$2)', [a.id,url]));
		await assert.rejects(call(banned, 'select public.request_addon_link($1,$2)', [a.id,'https://github.com/banned/fork']), /cannot suggest/);
		await call(member, 'select public.request_addon_link($1,$2)', [a.id,'https://github.com/member/fork']);
		const [{id}] = await db.sql('select id from public.addon_link_requests');
		await call(member, 'select public.withdraw_addon_link($1)', [id]);
		assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions, a.versions);
	} finally { await db.close(); }
});


for (const approved of [true,false]) test(`same-name screenshots ${approved ? 'publish with an admin link' : 'wait with a member link'} and fill remaining slots`,async()=>{
 const db=await createDb();
 try {
  const author=await db.addUser('author'), member=await db.addUser('member'), admin=await db.addUser('admin','admin');
  const shot=n=>`https://i.imgur.com/shot${n}.png`;
  const original=await post(db,author,addon('Images',undefined,{images:[shot(1),shot(2),shot(3)]}));
  const input={name:'Images',versions:[{url:'https://github.com/member/images'}],images:[shot(3),shot(4),shot(4),shot(5),shot(6)]};
  await db.as(approved ? admin : member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify(input)]));
  if(!approved) {
   assert.deepEqual((await db.sql('select images from public.addons'))[0].images,original.images);
   const [request]=await db.sql('select * from public.addon_link_requests');
   assert.deepEqual(request.images,[shot(3),shot(4),shot(5),shot(6)]);
   await db.as(admin,q=>q('select public.decide_addon_link($1,true)',[request.id]));
  }
  const [live]=await db.sql('select * from public.addons');
  assert.deepEqual(live.images,[shot(1),shot(2),shot(3),shot(4),shot(5)]);
  assert.equal(live.versions.length,2);
  assert.equal(live.description,original.description);
 } finally {await db.close();}
});

test('rejected screenshot suggestions leave live images unchanged; invalid images cannot bypass validation',async()=>{
 const db=await createDb();
 try {
  const member=await db.addUser('member'), admin=await db.addUser('admin','admin');
  const a=await post(db,member,addon('Images'));
  const input={name:'Images',versions:[{url:'https://github.com/member/new'}],images:['https://i.imgur.com/a.png']};
  await db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify(input)]));
  const [request]=await db.sql('select id from public.addon_link_requests');
  await db.as(admin,q=>q('select public.decide_addon_link($1,false)',[request.id]));
  assert.deepEqual((await db.sql('select images from public.addons'))[0].images,a.images);
  for(const images of [Array.from({length:6},(_,i)=>`https://i.imgur.com/${i}.png`),['http://i.imgur.com/a.png'],['https://evil.example/a.png'],['https://i.imgur.com/'+ 'x'.repeat(501)],{}]) {
   await assert.rejects(db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify({...input,images})])));
  }
 } finally {await db.close();}
});

test('signed GitHub attachments normalize before screenshot length validation, for submissions and suggestions',async()=>{
 const db=await createDb();
 try {
  const member=await db.addUser('member'), admin=await db.addUser('admin','admin');
  const signed='https://private-user-images.githubusercontent.com/29808955/641515915-39f10b7d-8916-4150-a547-09a24fa2efd8.png?jwt='+'x'.repeat(800);
  const stable='https://github.com/user-attachments/assets/39f10b7d-8916-4150-a547-09a24fa2efd8';
  const a=await post(db,member,addon('Signed',undefined,{images:[signed]}));
  assert.deepEqual(a.images,[stable]);
  await db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Signed',versions:[{url:'https://github.com/member/new'}],images:[signed]})]));
  const [request]=await db.sql('select * from public.addon_link_requests');
  assert.deepEqual(request.images,[stable]);
  await db.as(admin,q=>q('select public.decide_addon_link($1,true)',[request.id]));
  assert.deepEqual((await db.sql('select images from public.addons'))[0].images,[stable]);
 } finally {await db.close();}
});
