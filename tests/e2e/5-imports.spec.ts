import { expect, test } from './test.ts';
import { loginAs, logLine, postAddon, unique, chooseImportCategory } from './helpers.ts';

// submitted imports
test('a member submission clears its pending import without an admin approval', async ({ page }) => {
 await loginAs(page, 'admin');
 await page.goto('/admin/import');
 const entry = page.locator('[data-entry]').first();
 await expect(entry).toBeVisible();
 const queuedName = await entry.getByLabel('Name', {exact:true}).inputValue();
 const url = await entry.locator('a[href^="https://"]').first().getAttribute('href');
 expect(url).toBeTruthy();
 await page.goto('/account');
 await page.getByRole('button', {name:'Log out',exact:true}).click();
 await expect(page.getByRole('link', {name:'Log in',exact:true})).toBeVisible();
 await loginAs(page, 'member2');
 const name = unique('Independently submitted');
 await page.goto('/submit');
 await page.getByLabel('Addon name', { exact: true }).fill(name);
 await page.getByLabel('Link to the addon').fill(url!);
 await page.getByLabel('Category', {exact:true}).selectOption('Combat');
 await page.getByLabel('Description', {exact:true}).fill('Details written by the member, rather than the wiki.');
 await page.getByRole('button', {name:'Post addon',exact:true}).click();
 await expect(page.getByRole('heading', {level:1,name})).toBeVisible();
 await expect(page.getByRole('link', {name:'Edit',exact:true})).toBeVisible();
 await page.goto('/account');
 await page.getByRole('button', {name:'Log out',exact:true}).click();
 await expect(page.getByRole('link', {name:'Log in',exact:true})).toBeVisible();
 await loginAs(page, 'admin');
 await page.goto('/admin/import');
 await page.getByLabel('Search', {exact:true}).fill(queuedName);
 await expect(page.locator('[data-entry]')).toHaveCount(0);
 const submitted = page.locator('dl > div').filter({hasText:'Submitted by users'}).locator('dd');
 await expect(submitted).not.toHaveText('0');
 await page.goto('/admin/log?kind=import');
 await expect(logLine(page, /member2 submitted a link already waiting for import:/)).toBeVisible();
});

// import screenshots
test('importing an unchecked same-name link fetches README screenshots for review', async ({page}) => {
 const name = unique('Import screenshots');
 await loginAs(page,'admin');
 const address = await postAddon(page,name);
 let candidateId: number | undefined;
 const keep = 'https://i.imgur.com/import-keep.png';
 const remove = 'https://i.imgur.com/import-remove.png';
 await page.route(/^https:\/\/api\.github\.com\/repos\/wiki\d+\/[^/]+\/readme$/, route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
  content: Buffer.from(`![Keep](${keep})\n![Remove](${remove})`).toString('base64'),
  download_url: 'https://raw.githubusercontent.com/e2e/import/main/README.md'
 } }));
 await page.route('https://i.imgur.com/import-*.png', route => route.fulfill({
  contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=','base64')
 }));
 // Use a remaining pending candidate, rather than a seed entry another test
 // may have approved. Give its preview our fresh page's name and no checked README.
 // Approval sends these reviewed fields through the real database function.
 await page.route(/\/rest\/v1\/(?:import_queue|pending_imports)\?/,async route => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  const body = await response.json();
  if (Array.isArray(body)) {
   candidateId ??= body.find(row => row.status === 'pending')?.id;
   for (const row of body) if(row.id === candidateId) {
    row.name = name;
    row.images = [];
    row.readme_checked_at = null;
   }
  }
  await route.fulfill({response,json:body});
 });
 await page.goto('/admin/import');
 const entry=page.locator('[data-entry]').filter({has:page.getByRole('button',{name:`Add link to ${name}`,exact:true})});
 await expect(entry).toBeVisible();
 await entry.getByLabel('Name', { exact: true }).click();
 await expect(entry.getByText(/\+2 pictures/)).toBeVisible();
 await entry.getByRole('button',{name:'Remove this screenshot'}).last().click();
 await chooseImportCategory(entry);
 await entry.getByRole('button',{name:`Add link to ${name}`,exact:true}).click();
 await expect(entry).toHaveCount(0);
 await page.goto(address);
 await expect(page.locator(`main img[src="${keep}"]`)).toBeVisible();
 await expect(page.locator(`main img[src="${remove}"]`)).toHaveCount(0);
});

// fork imports
test('renamed forks suggest their published parent and keep separate approval explicit',async({page})=>{
 await loginAs(page,'admin');
 const name=unique('Fork parent');
 const address=await postAddon(page,name);
 const forkName=unique('Renamed fork');
 const parentKey=`gitlab.com/e2e/${name.replace(/\W+/g,'-')}`.toLowerCase();
 let known=false;
 let candidateId:number|undefined;
 await page.route(/\/rest\/v1\/(?:import_queue|pending_imports)\?/,async route=>{
  if(route.request().method()!=='GET') return route.continue();
  const url = new URL(route.request().url());
  const searching = url.searchParams.has('search_document');
  url.searchParams.delete('search_document');
  const response=await route.fetch({url:url.href});const rows=await response.json();
  if(Array.isArray(rows)){
   candidateId??=rows.find(row=>row.status==='pending')?.id;
   for(const row of rows) if(row.id===candidateId) {
    row.name=forkName;row.description='';
    row.review_stats={...row.review_stats,fork_of:known?parentKey:'github.com/unlisted/parent'};
   }
  }
  await route.fulfill({response,json:searching ? rows.filter(row => row.id === candidateId) : rows});
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
 await expect(entry.getByLabel('Category',{exact:true})).toHaveValue('');
 await expect(entry.getByRole('button',{name:'Approve separately',exact:true})).toBeDisabled();
 await expect(entry.getByRole('button',{name:`Add link to ${name}`,exact:true})).toBeEnabled();
 await entry.getByRole('button',{name:`Add link to ${name}`,exact:true}).click();
 await expect(entry).toHaveCount(0);
 await page.goto(address);
 await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
 await expect(page.getByText(`${name} was posted by a browser test.`,{exact:true})).toBeVisible();
});
for (const group of [false,true]) {
 test(`similar names offer separate approval or optional grouping (${group ? 'group' : 'separate'})`,async({page})=>{
  await loginAs(page,'admin');
  const name=unique('Aux');
  const address=await postAddon(page,name);
  const version=`${name}-Revamped-Opaque`;
  let candidateId:number|undefined;
  await page.route(/\/rest\/v1\/(?:import_queue|pending_imports)\?/,async route=>{
   if(route.request().method()!=='GET') return route.continue();
   const url = new URL(route.request().url());
   const searching = url.searchParams.has('search_document');
   url.searchParams.delete('search_document');
   const response=await route.fetch({url:url.href});const rows=await response.json();
   if(Array.isArray(rows)){
    candidateId??=rows.find(row=>row.status==='pending')?.id;
    for(const row of rows) if(row.id===candidateId) {
     row.name=version;row.description='A separately named version with its own description.';
     if(row.review_stats) row.review_stats.fork_of=null;
    }
   }
   await route.fulfill({response,json:searching ? rows.filter(row => row.id === candidateId) : rows});
  });
  await page.goto('/admin/import');
  await page.getByLabel('Search',{exact:true}).fill(version);
  const entry=page.locator('[data-entry]');
  await expect(entry).toHaveCount(1);
  await expect(entry.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
  await expect(entry.getByRole('button',{name:`Add link to ${name}`,exact:true})).toBeVisible();
  // Persist the preview's reviewed title through the edited-import path.
  await entry.getByLabel('Name',{exact:true}).fill(`${version} `);
  await expect(entry.getByRole('button',{name:`Add link to ${name}`,exact:true})).toBeEnabled();
  if(!group) await chooseImportCategory(entry);
  await entry.getByRole('button',{name:group?`Add link to ${name}`:'Approve',exact:true}).click();
  await expect(entry).toHaveCount(0);
  if(group){
   await page.goto(address);
   await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
   await expect(page.getByText(`${name} was posted by a browser test.`,{exact:true})).toBeVisible();
  }else{
   const importedName=version.replace(/\s+/g,'');
   await page.goto('/');
   await page.getByLabel('Search addons').fill(importedName);
   await page.getByRole('link',{name:importedName,exact:true}).click();
   await expect(page.getByRole('heading',{level:1,name:importedName})).toBeVisible();
  }
 });
}
