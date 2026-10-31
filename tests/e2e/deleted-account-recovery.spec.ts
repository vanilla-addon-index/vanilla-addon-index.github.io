import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, unique } from './helpers.ts';

test('the owner finds a deleted admin, previews recovery, and rolls back its damage', async ({ page }) => {
 const name = unique('RecoveryVictim').replace(/[^a-zA-Z0-9]/g, '');
 const result = execFileSync('docker', ['exec', '-i', 'supabase_db_vanilla-addon-index', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
  input: `begin;
   do $$ declare who uuid; victim bigint; begin
    insert into auth.users(id, raw_user_meta_data) values(gen_random_uuid(), '{"user_name":"${name}Admin"}') returning id into who;
    update public.profiles set is_admin=true where id=who;
    insert into public.addons(name,description,category,versions)
     values('${name}','Original recovery description.','Combat','[{"url":"https://github.com/e2e/${name}"}]') returning id into victim;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',who,'role','authenticated')::text,true);
    update public.addons set description='Damaged recovery description.' where id=victim;
    perform public.delete_account();
   end $$;
   select recovery_actor from public.activity_log where subject='${name}' and action='addon.update' and recovery_actor is not null;
   commit;`, encoding: 'utf8'
 });
 const recovery = result.trim();
 expect(recovery).toMatch(/^[0-9a-f-]{36}$/);
 await loginAs(page, 'owner');
 await page.goto('/admin/users');
 const section = page.getByRole('region', { name: 'Deleted account recovery' });
 await section.getByRole('link', { name: new RegExp(recovery.slice(0, 8)) }).click();
 await expect(page.getByRole('heading', { name: 'Deleted account', exact: true })).toBeVisible();
 await expect(page.getByRole('button', { name: /Make admin|Ban|Lift the ban/, exact: true })).toHaveCount(0);
 await page.getByRole('button', { name: 'Show what would change' }).click();
 await expect(page.getByText('Nothing has changed yet.', { exact: false })).toBeVisible();
 await expect(page.getByText(new RegExp(`Put back as it was:.*${name}`))).toBeVisible();
 await page.getByRole('button', { name: 'Roll back 1 change', exact: true }).click();
 await confirm(page, 'Roll back');
 await expect(page.getByText('Rolled back 1 change by Deleted account.', { exact: true })).toBeVisible();
 await page.getByRole('link', { name: 'Everything they did, in the log' }).click();
 await expect(page).toHaveURL(new RegExp(`recovery=${recovery}`));
 await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
 const description = execFileSync('docker', ['exec', 'supabase_db_vanilla-addon-index', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c', `select description from public.addons where name='${name}'`], {encoding: 'utf8'});
 expect(description.trim()).toBe('Original recovery description.');
});

test('ordinary admins do not see deleted-account recovery controls', async ({ page }) => {
 await loginAs(page, 'admin');
 await page.goto('/admin/users');
 await expect(page.getByRole('region', { name: 'Deleted account recovery' })).toHaveCount(0);
});
