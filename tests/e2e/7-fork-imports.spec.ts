import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

test('renamed forks suggest their published parent and keep separate approval explicit',async({page})=>{
 await loginAs(page,'admin');
 const name=unique('Fork parent');
 const address=await postAddon(page,name);
 const forkName=unique('Renamed fork');
 const parentKey=`gitlab.com/e2e/${name.replace(/\W+/g,'-')}`.toLowerCase();
 let known=false;
 let candidateId:number|undefined;
 await page.route('**/rest/v1/import_queue?*',async route=>{
  if(route.request().method()!=='GET') return route.continue();
  const response=await route.fetch();const rows=await response.json();
  if(Array.isArray(rows)){
   candidateId??=rows.find(row=>row.status==='pending')?.id;
   for(const row of rows) if(row.id===candidateId) row.name=forkName;
  }
  await route.fulfill({response,json:rows});
 });
 await page.route('**/rest/v1/repo_stats_current?*',async route=>{
  const response=await route.fetch();const rows=await response.json();
  for(const row of rows) row.fork_of=known?parentKey:'github.com/unlisted/parent';
  await route.fulfill({response,json:rows});
 });
 await page.goto('/admin/import');
 await page.getByLabel('Search',{exact:true}).fill(forkName);
 const entry=page.locator('[data-entry]');
 await expect(entry).toHaveCount(1);
 await expect(entry.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 await expect(entry.getByRole('button',{name:/Add link to/})).toHaveCount(0);
 known=true;
 await page.reload();
 await page.getByLabel('Search',{exact:true}).fill(forkName);
 await expect(entry.getByRole('button',{name:`Add link to ${name}`,exact:true})).toBeVisible();
 await expect(entry.getByRole('button',{name:'Approve separately',exact:true})).toBeVisible();
 await expect(entry.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await entry.getByRole('button',{name:`Add link to ${name}`,exact:true}).click();
 await expect(entry).toHaveCount(0);
 await page.goto(address);
 await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
 await expect(page.getByText(`${name} was posted by a browser test.`,{exact:true})).toBeVisible();
});
