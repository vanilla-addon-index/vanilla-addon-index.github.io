import { execFileSync } from 'node:child_process';
import { expect, test } from './test.ts';
import { confirm, loginAs, unique } from './helpers.ts';

const sql = (input: string) => execFileSync('docker', ['exec','-i','supabase_db_vanilla-addon-index','psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'], {input,encoding:'utf8'}).trim();
const item = (id: number, name: string) => ({id,name,reason:'delete',deleted_by_name:'admin',deleted_at:new Date().toISOString(),addon:{slug:'fixture',description:'A trash search fixture.',category:'Combat',images:[],versions:[]}});

test('Trash and History find an older recoverable entry beyond the API row cap', async ({ page }) => {
 const prefix=unique('TrashPages').replace(/[^a-zA-Z0-9]/g,'');
 const name=`${prefix}Old`;
 const addonId=sql(`begin;
  insert into public.addon_trash(addon,name,reason,deleted_by_name)
   select '{"description":"Pagination filler.","category":"Combat","images":[],"versions":[]}'::jsonb,
    '${prefix}Filler'||i,'delete','PaginationDeleter' from generate_series(1,1105)i;
  insert into public.addons(name,description,category,versions)
   values('${name}','Original older recoverable addon.','Combat','[{"url":"https://github.com/e2e/${name}"}]');
  select id from public.addons where name='${name}';
  delete from public.addons where name='${name}';
  update public.addon_trash set deleted_at=now()-interval '2 hours' where name='${name}';
  commit;`);
 try {
  await loginAs(page,'admin');
  await page.goto(`/admin/log?addon=${addonId}`);
  await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();
  await page.goto('/admin/trash');
  const search=page.getByRole('searchbox',{name:'Search the trash'});
  await search.fill(prefix);
  await expect(page.getByRole('status')).toHaveText('Showing 100 of 1106 matching entries.');
  await expect(page.getByText(name,{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Load more entries'}).click();
  await expect(page.getByRole('status')).toHaveText('Showing 200 of 1106 matching entries.');
  await search.fill(name.toLowerCase());
  await expect(page.getByRole('status')).toHaveText('Showing 1 of 1 matching entries.');
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  await expect(page.getByText(`Restored "${name}".`,{exact:false})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Showing 0 of 0 matching entries.');
  expect(sql(`select name from public.addons where id=${addonId}`)).toBe(name);
 } finally {
  sql(`delete from public.addons where id=${addonId}; delete from public.addon_trash where name like '${prefix}%';`);
 }
});

test('a slower search response cannot overwrite the newer search results', async ({ page }) => {
 await loginAs(page,'admin');
 let releaseSlow: (() => void) | undefined;
 await page.route('**/rest/v1/rpc/list_trash',async route=>{
  const {search}=route.request().postDataJSON();
  if(search==='slow') await new Promise<void>(resolve=>releaseSlow=resolve);
  const items=search ? [item(search==='slow'?9001:9002,search==='slow'?'Slow result':'Fast result')] : [];
  await route.fulfill({json:{items,total:2,matching:items.length,more:false}});
 });
 await page.goto('/admin/trash');
 const search=page.getByRole('searchbox',{name:'Search the trash'});
 await search.fill('slow');
 await expect.poll(()=>Boolean(releaseSlow)).toBe(true);
 await search.fill('fast');
 await expect(page.getByText('Fast result',{exact:true})).toBeVisible();
 const slowDone=page.waitForResponse(response=>response.url().endsWith('/rpc/list_trash') && response.request().postDataJSON().search==='slow');
 releaseSlow!();
 await slowDone;
 await expect(page.getByText('Fast result',{exact:true})).toBeVisible();
 await expect(page.getByText('Slow result',{exact:true})).toHaveCount(0);
});

test('the owner can permanently delete one entry but cannot empty the whole trash', async ({ page }) => {
 await loginAs(page,'owner');
 let removed=false;
 let submitted: unknown;
 await page.route('**/rest/v1/rpc/list_trash',async route=>{
  const items=removed ? [item(9002,'Second entry')] : [item(9001,'First entry'),item(9002,'Second entry')];
  await route.fulfill({json:{items,total:items.length,matching:items.length,more:false}});
 });
 await page.route('**/rest/v1/rpc/purge_trash',async route=>{
  submitted=route.request().postDataJSON();
  removed=true;
  await route.fulfill({json:1});
 });
 await page.goto('/admin/trash');
 await expect(page.getByRole('status')).toHaveText('Showing 2 of 2 matching entries.');
 await expect(page.getByRole('button',{name:'Empty the trash',exact:true})).toHaveCount(0);
 const first=page.locator('.panel > div').filter({has:page.getByText('First entry',{exact:true})});
 await first.getByRole('button',{name:'Delete forever',exact:true}).click();
 await confirm(page,'Delete forever');
 expect(submitted).toEqual({ids:[9001]});
 await expect(page.getByText('Removed 1 for good.',{exact:true})).toBeVisible();
 await expect(page.getByRole('status')).toHaveText('Showing 1 of 1 matching entries.');
 await expect(page.getByText('Second entry',{exact:true})).toBeVisible();
});
