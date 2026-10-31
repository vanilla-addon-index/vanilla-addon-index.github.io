import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, logLine, unique } from './helpers.ts';

const sql = (input: string) => execFileSync('docker', ['exec', '-i', 'supabase_db_vanilla-addon-index', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], {input,encoding:'utf8'}).trim();
function closedReport(outcome: 'dismissed' | 'handled') {
 const name=unique('ReportRecovery').replace(/[^a-zA-Z0-9]/g,'');
 const reviewer=`${name}Admin`;
 const result=sql(`begin;
  do $$ declare reviewer uuid; reporter uuid; addon bigint; report bigint; begin
   insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${reviewer}"}') returning id into reviewer;
   insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"user_name":"${name}Member"}') returning id into reporter;
   update public.profiles set is_admin=true where id=reviewer;
   insert into public.addons(name,description,category,versions)
    values('${name}','Report recovery browser test.','Combat','[{"url":"https://github.com/e2e/${name}"}]') returning id into addon;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',reporter,'role','authenticated')::text,true);
   perform public.report_addon(addon,'harmful','Original harmful-download evidence for ${name}.');
   select r.id into report from public.reports r where r.addon_id=addon;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
   perform public.decide_report(report,'${outcome}');
  end $$;
  select json_build_object('report',r.id,'addon',a.id) from public.reports r join public.addons a on a.id=r.addon_id where a.name='${name}';
  commit;`);
 return {name,reviewer,...JSON.parse(result)} as {name:string;reviewer:string;report:number;addon:number};
}

test('owner rollback previews and reopens a dismissed harmful report in the review queue', async ({ page }) => {
 const fixture=closedReport('dismissed');
 await loginAs(page,'owner');
 await page.goto(`/admin/users/profile?name=${fixture.reviewer}`);
 await page.getByRole('button',{name:'Show what would change'}).click();
 await expect(page.getByText(new RegExp(`Reopen the report about.*${fixture.name}`))).toBeVisible();
 expect(sql(`select status from public.reports where id=${fixture.report}`)).toBe('dismissed');
 await page.getByRole('button',{name:'Roll back 1 change',exact:true}).click();
 await confirm(page,'Roll back');
 await expect(page.getByText(`Rolled back 1 change by ${fixture.reviewer}.`,{exact:true})).toBeVisible();
 await page.goto('/admin/reports');
 await expect(page.getByRole('link',{name:fixture.name,exact:true})).toBeVisible();
 await expect(page.getByText(`Original harmful-download evidence for ${fixture.name}.`,{exact:true})).toBeVisible();
 expect(sql(`select status from public.reports where id=${fixture.report}`)).toBe('open');
});

test('History offers reopening only to the owner and returns handled reports to review', async ({ page }) => {
 const fixture=closedReport('handled');
 await loginAs(page,'admin');
 await page.goto(`/admin/log?addon=${fixture.addon}`);
 await expect(logLine(page,new RegExp(`handled a report about\\s+${fixture.name}`))).toBeVisible();
 await expect(page.getByRole('button',{name:'Reopen report',exact:true})).toHaveCount(0);
 await page.goto('/account');
 await page.getByRole('button',{name:'Log out',exact:true}).click();
 await expect(page.getByRole('link',{name:'Log in',exact:true})).toBeVisible();
 await loginAs(page,'owner');
 await page.goto(`/admin/log?addon=${fixture.addon}`);
 await logLine(page,new RegExp(`handled a report about\\s+${fixture.name}`)).getByRole('button',{name:'Reopen report',exact:true}).click();
 await confirm(page,'Reopen report');
 await expect(page.getByText(`The report about "${fixture.name}" is open again.`,{exact:true})).toBeVisible();
 await expect(logLine(page,new RegExp(`reopened a report about\\s+${fixture.name}`))).toBeVisible();
 expect(sql(`select status from public.reports where id=${fixture.report}`)).toBe('open');
});
