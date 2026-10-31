import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, unique } from './helpers.ts';

const sql = (input: string) => execFileSync('docker', ['exec','-i','supabase_db_vanilla-addon-index','psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'], {input,encoding:'utf8'}).trim();
function fixture(padding = 0) {
 const name=unique('LogRecovery').replace(/[^a-zA-Z0-9]/g,'');
 const reviewer=`${name}Admin`;
 const result=sql(`begin;
  do $$ declare reviewer uuid; target bigint; begin
   insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${reviewer}"}') returning id into reviewer;
   update public.profiles set is_admin=true where id=reviewer;
   insert into public.addons(name,description,category,versions) values('${name}','Original description for recovery.','Combat','[{"url":"https://github.com/e2e/${name}"}]') returning id into target;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
   update public.addons set description='Damaged description for recovery.' where id=target;
   insert into public.activity_log(actor,actor_name,action,subject)
    select reviewer,'${reviewer}','addon.update','${name} padding '||i from generate_series(1,${padding}) i;
  end $$;
  select json_build_object('addon',a.id,'edit',l.id) from public.addons a join public.activity_log l on l.addon_id=a.id and l.action='addon.update' where a.name='${name}';
  commit;`);
 return {name,reviewer,...JSON.parse(result)} as {name:string;reviewer:string;addon:number;edit:number};
}

test('filtered recovery permanently marks the original edit and removes its recovery action',async({page})=>{
 const f=fixture();
 await loginAs(page,'owner');
 await page.goto(`/admin/log?by=${f.reviewer}`);
 const row=page.locator(`#log-${f.edit}`);
 await row.getByRole('button',{name:'Revert',exact:true}).click();
 await confirm(page,'Revert');
 await expect(row).toContainText('Recovered by owner');
 await expect(row.getByRole('button',{name:/Revert/})).toHaveCount(0);
 const recovery=sql(`select id from public.activity_log where details->>'undid'='${f.edit}' and action='addon.revert' order by id desc limit 1`);
 await row.getByRole('link',{name:/Recovered by owner/}).click();
 await expect(page).toHaveURL(new RegExp(`entry=${recovery}#log-${recovery}$`));
 await expect(page.locator(`#log-${recovery}`)).toContainText('reverted an edit of');
 await page.getByRole('link',{name:'View original entry',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`entry=${f.edit}#log-${f.edit}$`));
 await page.reload();
 await expect(row).toContainText('Recovered by owner');
 await expect(row.getByRole('button',{name:/Revert/})).toHaveCount(0);
});

test('recovery preserves older pages, expanded details and position in a long filtered log',async({page})=>{
 const f=fixture(120);
 await loginAs(page,'owner');
 await page.goto(`/admin/log?by=${f.reviewer}`);
 await page.getByRole('button',{name:'Show older lines',exact:true}).click();
 const row=page.locator(`#log-${f.edit}`);
 await row.getByText('View changes',{exact:true}).click();
 await row.getByRole('button',{name:'Revert',exact:true}).scrollIntoViewIfNeeded();
 const count=await page.locator('[id^="log-"]').count();
 expect(count).toBeGreaterThan(100);
 const top=await row.evaluate(element=>element.getBoundingClientRect().top);
 await row.getByRole('button',{name:'Revert',exact:true}).click();
 await confirm(page,'Revert');
 await expect(row).toContainText('Recovered by owner');
 await expect(row.getByRole('button',{name:'Revert',exact:true})).toHaveCount(0);
 await expect(page.locator('[id^="log-"]')).toHaveCount(count);
 await expect(row.locator('details').first()).toHaveAttribute('open','');
 const after=await row.evaluate(element=>element.getBoundingClientRect().top);
 expect(Math.abs(after-top)).toBeLessThan(8);
 await expect(page.getByRole('button',{name:'Show older lines',exact:true})).toHaveCount(0);
});

test('group and report recovery status survives filters excluding the recovering owner',async({page})=>{
 const f=fixture();
 const ids=JSON.parse(sql(`begin;
  do $$ declare reviewer uuid; reporter uuid; second bigint; report bigint; begin
   select id into reviewer from public.profiles where username='${f.reviewer}';
   insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${f.name}Reporter"}') returning id into reporter;
   insert into public.addons(name,description,category,versions) values('${f.name}Second','Second addon for grouping.','Combat','[{"url":"https://github.com/e2e/${f.name}Second"}]') returning id into second;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',reporter,'role','authenticated')::text,true);
   perform public.report_addon(${f.addon},'harmful','Harmful download report.');
   select id into report from public.reports where addon_id=${f.addon};
   perform set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
   perform public.group_addons(array[${f.addon},second]);
   perform public.decide_report(report,'dismissed');
  end $$;
  select json_build_object('group',max(id) filter(where action='group.add'),'report',max(id) filter(where action='report.dismiss')) from public.activity_log where actor_name='${f.reviewer}';
  commit;`));
 await loginAs(page,'owner');
 await page.goto(`/admin/log?by=${f.reviewer}`);
 const group=page.locator(`#log-${ids.group}`);
 const report=page.locator(`#log-${ids.report}`);
 await expect(group.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
 await expect(report.getByRole('button',{name:'Reopen report',exact:true})).toBeVisible();
 sql(`begin;
  select set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated')::text,true) from public.profiles where username='owner';
  select public.undo_grouping(${ids.group});
  select public.reopen_report(${ids.report});
  commit;`);
 await page.reload();
 await expect(group).toContainText('Recovered by owner');
 await expect(report).toContainText('Recovered by owner');
 await expect(group.getByRole('button',{name:'Undo',exact:true})).toHaveCount(0);
 await expect(report.getByRole('button',{name:'Reopen report',exact:true})).toHaveCount(0);
});

 test('a stale Revert button cannot repeat another admin recovery and overwrite later work',async({page})=>{
  const f=fixture();
  await loginAs(page,'owner');
  await page.goto(`/admin/log?by=${f.reviewer}`);
  const row=page.locator(`#log-${f.edit}`);
  await expect(row.getByRole('button',{name:'Revert',exact:true})).toBeVisible();
  sql(`begin;
   select set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated')::text,true) from public.profiles where username='owner';
   select public.revert_addon(${f.edit});
   update public.addons set description='Legitimate work after concurrent recovery.' where id=${f.addon};
   commit;`);
  await row.getByRole('button',{name:'Revert',exact:true}).click();
  await confirm(page,'Revert');
  await expect(row).toContainText('Recovery failed: This edit has already been recovered.');
  await expect(row).toContainText('Recovered by owner');
  expect(sql(`select description from public.addons where id=${f.addon}`)).toBe('Legitimate work after concurrent recovery.');
 });

 test('unbanning updates the original row without bringing back its completed action',async({page})=>{
  const f=fixture();
  const member=`${f.name}Member`;
  const id=sql(`begin;
   insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${member}"}');
   select set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated')::text,true) from public.profiles where username='owner';
   select public.set_banned(id,true) from public.profiles where username='${member}';
   select id from public.activity_log where action='user.ban' and subject='${member}' order by id desc limit 1;
   commit;`).split('\n').at(-1);
  await loginAs(page,'owner');
  await page.goto(`/admin/log?kind=user&q=${member}`);
  const row=page.locator(`#log-${id}`);
  await row.getByRole('button',{name:'Lift the ban',exact:true}).click();
  await confirm(page,'Lift the ban');
  await expect(row).toContainText(`${member} can post again.`);
  await expect(row.getByRole('button',{name:'Lift the ban',exact:true})).toHaveCount(0);
 });

 test('conflict review displays readable changes and saves a logged manual resolution from current content',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:1000});
  const f=fixture();
  sql(`begin;
   select set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated')::text,true) from public.profiles where username='owner';
   update public.addons set description='Later description with valid improvements.',category='PvP' where id=${f.addon};
   commit;`);
  await loginAs(page,'owner');
  await page.goto(`/admin/log?by=${f.reviewer}`);
  const row=page.locator(`#log-${f.edit}`);
  await expect(row).toContainText('Conflicts with later changes');
  await expect(row.getByRole('button',{name:'Revert',exact:true})).toHaveCount(0);
  await row.getByText('View changes',{exact:true}).click();
  await expect(row.getByRole('heading',{name:'Current content',exact:true})).toBeVisible();
  await expect(row).toContainText('Later description with valid improvements.');
  await row.getByRole('link',{name:'Edit current addon',exact:true}).click();
  await expect(page.getByLabel('Description',{exact:true})).toHaveValue('Later description with valid improvements.');
  await expect(page.getByLabel('Category',{exact:true})).toHaveValue('PvP');
  await expect(page.getByRole('region',{name:'Recovery review'})).toContainText('Original description for recovery.');
  await page.screenshot({path:testInfo.outputPath('manual-review-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:testInfo.outputPath('manual-review-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByLabel('Description',{exact:true}).fill('Resolved description preserving valid improvements.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page).toHaveURL(/\/addon\//);
  expect(sql(`select category from public.addons where id=${f.addon}`)).toBe('PvP');
  await page.goto(`/admin/log?by=${f.reviewer}`);
  await expect(row).toContainText('Recovered by owner');
 });

 test('a change arriving during confirmation stops recovery without overwriting it',async({page})=>{
  const f=fixture();
  await loginAs(page,'owner');
  await page.goto(`/admin/log?by=${f.reviewer}`);
  const row=page.locator(`#log-${f.edit}`);
  await row.getByRole('button',{name:'Revert',exact:true}).click();
  sql(`update public.addons set description='New work arriving during confirmation.' where id=${f.addon}`);
  await confirm(page,'Revert');
  await expect(row).toContainText('Conflicts with later changes');
  expect(sql(`select description from public.addons where id=${f.addon}`)).toBe('New work arriving during confirmation.');
 });

 test('permanent entry links open older entries directly, expand comparisons and survive reload',async({page})=>{
  const f=fixture(120);
  await loginAs(page,'owner');
  await page.goto(`/admin/log?entry=${f.edit}&by=Nobody&kind=report#log-${f.edit}`);
  const row=page.locator(`#log-${f.edit}`);
  await expect(row).toBeVisible();
  await expect(row.locator('details[data-comparison]')).toHaveAttribute('open','');
  await expect(row.getByRole('region',{name:'Description comparison'})).toContainText('Damaged description for recovery.');
  await expect(row.getByRole('link',{name:'Link to entry',exact:true})).toHaveAttribute('href',`/admin/log?entry=${f.edit}#log-${f.edit}`);
  await expect(page.locator('[id^="log-"][tabindex="-1"]')).toHaveCount(1);
  await page.reload();
  await expect(row).toBeVisible();
  await expect(row.locator('details[data-comparison]')).toHaveAttribute('open','');
  await page.getByRole('link',{name:'Show the whole log',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/log$/);
  await expect(page.getByRole('button',{name:'Show older lines',exact:true})).toBeVisible();
  await expect(row).toHaveCount(0);
 });
 test('an unavailable entry has a clear message and a way back to the log',async({page})=>{
  await loginAs(page,'owner');
  await page.goto('/admin/log?entry=9000000000000');
  await expect(page.getByText('This log entry is unavailable or no longer exists.',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Show the whole log',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/log$/);
 });
 test('permanent entry links retain admin access restrictions',async({page})=>{
  const f=fixture();
  await loginAs(page,'member');
  await page.goto(`/admin/log?entry=${f.edit}`);
  await expect(page.getByText('This part of the site is for admins.',{exact:true})).toBeVisible();
  await expect(page.locator(`#log-${f.edit}`)).toHaveCount(0);
 });
