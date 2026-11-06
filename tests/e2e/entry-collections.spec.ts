import { expect, test } from './test.ts';
import { confirm, loginAs, unique } from './helpers.ts';

for (const width of [1280, 390]) {
 test(`collections switch and retain shareable state at ${width}px`, async ({ page }) => {
  await page.setViewportSize({width,height:900});
  const rows = [
   {id:99001,slug:'regular-sample',name:'RegularSample',description:'An ordinary addon.',category:'Combat',entry_type:'addon',versions:[],images:[],group_id:null,is_main:false},
   {id:99002,slug:'dll-sample',name:'ClientSample',description:'A client extension.',category:'Miscellaneous',entry_type:'dll',versions:[],images:[],group_id:null,is_main:false},
   {id:99003,slug:'legacy-sample',name:'LegacySample',description:'An older snapshot addon.',category:'Combat',versions:[],images:[],group_id:null,is_main:false}
  ];
  await page.route('**/rest/v1/addons?*',route => route.fulfill({json:rows}));
  await page.goto('/');
  await expect(page.getByRole('link',{name:'RegularSample',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'LegacySample',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toHaveCount(0);
  const toggle=page.getByRole('group',{name:'Collection'}).filter({visible:true});
  await toggle.getByRole('button',{name:'DLL',exact:true}).click();
  await expect(page).toHaveURL(/type=dll/);
  await expect(page.getByRole('link',{name:'Submit addon',exact:true})).toHaveAttribute('href','/submit');
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toHaveAttribute('href','/dll/dll-sample');
  await expect(page.getByRole('link',{name:'RegularSample',exact:true})).toHaveCount(0);
  await expect(page.getByRole('searchbox',{name:'Search DLL mods',exact:true})).toBeVisible();
  if (width >= 768) {
   await expect(page.locator('aside .panel button:enabled')).toHaveCount(0);
   await expect(page.locator('aside .panel button[aria-pressed="true"]')).toHaveCount(0);
   await expect(page.locator('aside .panel button span:last-child')).toHaveText(Array(23).fill('0'));
  } else {
   await expect(page.getByLabel('Category',{exact:true})).toBeDisabled();
  }
  await page.goto('/?type=dll&cat=Combat');
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toBeVisible();
  await expect(page).not.toHaveURL(/cat=/);

  await page.reload();
  await expect(toggle.getByRole('button',{name:'DLL',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'ClientSample',exact:true})).toHaveAttribute('href','/dll/dll-sample');
  await page.screenshot({path:`test-results/collections-${width}.png`,fullPage:true});
  await toggle.getByRole('button',{name:'Addons',exact:true}).click();
  await expect(page).not.toHaveURL(/type=dll/);
  await expect(page.getByRole('link',{name:'LegacySample',exact:true})).toBeVisible();
  if (width >= 768) await expect(page.locator('aside .panel button:enabled')).toHaveCount(23);
  else await expect(page.getByLabel('Category',{exact:true})).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 });
}

test('admins classify DLL mods with the normal submit and edit forms', async ({page}) => {
 // Leave the primary admin's shared edit budget for the existing moderation journeys.
 await loginAs(page,'admin2');
 const name=unique('DLL Preview');
 await page.goto('/submit?type=dll');
 await expect(page.getByLabel('Type',{exact:true})).toHaveValue('addon');
 await expect(page.getByLabel('Ownership',{exact:true})).toHaveValue('false');
 await page.getByLabel('Type',{exact:true}).selectOption('dll');
 await page.getByLabel('Addon name',{exact:true}).fill(name);
 await page.getByLabel('Link to the addon').fill(`https://gitlab.com/e2e/${name.replace(/\W+/g,'-')}`);
 await expect(page.getByLabel('Category',{exact:true})).toBeDisabled();
 await expect(page.getByLabel('Category',{exact:true})).toHaveValue('');
 await page.getByLabel('Description',{exact:true}).fill('A local browser test of the DLL collection.');
 await page.getByRole('button',{name:'Post addon',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
 const helper=page.getByRole('button',{name:'Close wiki helper',exact:true});
 if (await helper.isVisible()) await helper.click();
 const detail=page.url();
 await expect(page.getByRole('link',{name:/All DLL mods/,exact:false})).toBeVisible();
 await page.getByRole('link',{name:/All DLL mods/}).click();
 await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
 await page.goto('/');
 await expect(page.getByRole('link',{name,exact:true})).toHaveCount(0);
 await page.goto(detail);
 await page.getByRole('link',{name:'Edit',exact:true}).click();
 await expect(page.getByLabel('Type',{exact:true})).toHaveValue('dll');
 await page.getByLabel('Type',{exact:true}).selectOption('addon');
 await expect(page.getByLabel('Category',{exact:true})).toBeEnabled();
 await expect(page.getByLabel('Category',{exact:true})).toHaveValue('Miscellaneous');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.getByRole('link',{name:/All addons/})).toBeVisible();
 await page.goto('/');
 await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
 await page.goto(detail);
 await page.getByRole('button',{name:'Delete',exact:true}).filter({visible:true}).click();
 await confirm(page,'Delete');
});


test('the shared import queue filters types and offers classification in each entry', async ({page}) => {
 await loginAs(page,'admin');
 await page.route('**/rest/v1/import_queue?*', async route => {
  if (route.request().method() !== 'GET') return route.continue();
  const item={id:99004,key:'gitlab.com/example/client-review',name:'ClientReview',url:'https://gitlab.com/example/client-review',description:'An extension awaiting review.',category:'',entry_type:'dll',images:[],alts:[],parent:null,obsolete:false,status:'pending',problem:null,rejected_by_owner:false};
  await route.fulfill({json:[item]});
 });
 await page.goto('/admin/import');
 const entry=page.locator('[data-entry]').filter({has:page.getByRole('textbox',{name:'Name',exact:true})});
 await expect(entry).toHaveCount(1);
 await expect(entry.getByLabel('Publish to',{exact:true})).toHaveValue('dll');
 await expect(entry.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
 await expect(entry.getByLabel('Category',{exact:true})).toBeDisabled();
 const filter=page.getByLabel('Type',{exact:true}).filter({has:page.locator('option[value=""]')});
 await filter.selectOption('addon');
 await expect(entry).toHaveCount(0);
 await filter.selectOption('dll');
 await expect(entry).toHaveCount(1);
 await entry.getByLabel('Publish to',{exact:true}).selectOption('addon');
 await expect(entry.getByLabel('Publish to',{exact:true})).toHaveValue('addon');
 await expect(entry.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
 await entry.getByLabel('Publish to',{exact:true}).selectOption('dll');
 let submitted: {input: {entry_type: string; category: string}} | undefined;
 await page.route('**/rest/v1/rpc/publish_import',async route=>{
  submitted=route.request().postDataJSON();
  await route.fulfill({json:99004});
 });
 await entry.getByRole('button',{name:'Approve',exact:true}).click();
 await expect.poll(()=>submitted?.input.entry_type).toBe('dll');
 expect(submitted?.input.category).toBe('Miscellaneous');
 await expect(entry).toHaveCount(0);
});


test('DLL detail addresses and old links resolve to the right collection', async ({page}) => {
 const rows=[
  {id:99101,slug:'client-route',aliases:['old-client-route'],name:'ClientRoute',description:'A DLL routing example.',category:'Libraries',entry_type:'dll',versions:[],images:[],group_id:null,is_main:false},
  {id:99102,slug:'addon-route',aliases:[],name:'AddonRoute',description:'An addon routing example.',category:'Combat',entry_type:'addon',versions:[],images:[],group_id:null,is_main:false}
 ];
 await page.route('**/rest/v1/addons?*',route=>route.fulfill({json:rows}));
 await page.goto('/dll/client-route');
 await expect(page.getByRole('heading',{level:1,name:'ClientRoute'})).toBeVisible();
 await expect(page).toHaveURL(/\/dll\/client-route$/);
 await page.reload();
 await expect(page.getByRole('heading',{level:1,name:'ClientRoute'})).toBeVisible();
 await page.goto('/addon/old-client-route?from=old#downloads');
 await expect(page).toHaveURL(/\/dll\/client-route\?from=old#downloads$/);
 await page.goto('/dll/addon-route');
 await expect(page).toHaveURL(/\/addon\/addon-route$/);
 await expect(page.getByRole('heading',{level:1,name:'AddonRoute'})).toBeVisible();
});


test('members do not get a Type field, even through a DLL submission link', async ({page}) => {
 await loginAs(page,'member');
 await page.goto('/submit?type=dll');
 await expect(page.getByLabel('Addon name',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Type',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Category',{exact:true})).toBeVisible();
});

test('the site owner retains DLL publishing controls', async ({page}) => {
 await loginAs(page,'owner');
 await page.goto('/submit?type=dll');
 await expect(page.getByLabel('Type',{exact:true})).toHaveValue('addon');
 await expect(page.getByLabel('Ownership',{exact:true})).toHaveValue('false');
 await page.getByLabel('Type',{exact:true}).selectOption('dll');
});
