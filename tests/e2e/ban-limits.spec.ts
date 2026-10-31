import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, unique } from './helpers.ts';

const sql = (input: string) => execFileSync('docker', ['exec', '-i', 'supabase_db_vanilla-addon-index', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8' }).trim();

for (const window of ['hour', 'day'] as const) {
 test(`ban ${window} limit is shown in the admin interface and leaves the member unchanged`, async ({ page }) => {
  const name = unique('BanLimit').replace(/[^a-zA-Z0-9]/g,'');
  const budget = `${name}Budget`;
  sql(`insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${name}"}');
   insert into public.activity_log(actor,action,subject,at)
   select p.id,case when i%2=0 then 'user.ban' else 'user.unban' end,'${budget}',
    now()-interval '${window === 'hour' ? '0' : '2'} hours'
   from public.profiles p,generate_series(1,${window === 'hour' ? 5 : 15}) i where username='admin';`);
  try {
   await loginAs(page,'admin');
   await page.goto(`/admin/users/profile?name=${name}`);
   await page.getByRole('button',{name:'Ban',exact:true}).click();
   await confirm(page,'Ban');
   const message = window === 'hour'
    ? 'You can make at most 5 ban or unban changes an hour. Try again later.'
    : 'You can make at most 15 ban or unban changes a day. Try again tomorrow.';
   await expect(page.getByText(message,{exact:true})).toBeVisible();
   expect(sql(`select banned from public.profiles where username='${name}'`)).toBe('f');
   await expect(page.getByRole('button',{name:'Ban',exact:true})).toBeVisible();
  } finally {
   sql(`delete from public.activity_log where subject='${budget}';
    delete from auth.users where id=(select id from public.profiles where username='${name}');`);
  }
 });
}
