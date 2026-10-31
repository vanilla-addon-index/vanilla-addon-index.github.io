import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, logLine, unique } from './helpers.ts';

const sql = (input: string) => execFileSync('docker', ['exec', '-i', 'supabase_db_vanilla-addon-index', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], {input,encoding:'utf8'}).trim();

test('History shows the rate-limit error and keeps the page unchanged; the owner can recover it', async ({ page }) => {
 const name = unique('LimitedHistory').replace(/[^a-zA-Z0-9]/g, '');
 const id = sql(`begin;
  insert into public.addons(name,description,category,versions)
   values('${name}','Original history description.','Combat','[{"url":"https://github.com/e2e/${name}"}]');
  update public.addons set description='Damaged history description.' where name='${name}';
  insert into public.activity_log(actor,action,subject)
   select p.id,'addon.revert','${name}Budget' from public.profiles p,generate_series(1,30) where username='admin';
  select id from public.addons where name='${name}';
  commit;`);
 try {
  await loginAs(page,'admin');
  await page.goto(`/admin/log?addon=${id}`);
  const edited = logLine(page,new RegExp(`edited\\s+${name}`));
  await edited.getByText('View changes').click();
  await edited.getByRole('button',{name:'Revert',exact:true}).click();
  await confirm(page,'Revert');
  await expect(page.getByText('You can make at most 30 edits an hour. Try again later.',{exact:true})).toBeVisible();
  expect(sql(`select description from public.addons where id=${id}`)).toBe('Damaged history description.');
  await page.goto('/account');
  await page.getByRole('button',{name:'Log out',exact:true}).click();
  await expect(page.getByRole('link',{name:'Log in',exact:true})).toBeVisible();
  await loginAs(page,'owner');
  await page.goto(`/admin/log?addon=${id}`);
  const recovery = logLine(page,new RegExp(`edited\\s+${name}`));
  await recovery.getByText('View changes').click();
  await recovery.getByRole('button',{name:'Revert',exact:true}).click();
  await confirm(page,'Revert');
  await expect(page.getByText(`"${name}" is back to how it was before that edit.`,{exact:true})).toBeVisible();
  expect(sql(`select description from public.addons where id=${id}`)).toBe('Original history description.');
 } finally {
  sql(`delete from public.activity_log where subject='${name}Budget';`);
 }
});
