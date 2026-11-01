import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

test('admin can search for an unrelated live addon and explicitly merge an import',async({page})=>{
 await loginAs(page,'admin');
 const name=unique('ManualMergeTarget');
 await postAddon(page,name);
 let merged=false;
 await page.route('**/rest/v1/import_queue?*',async route=>{
  const request=route.request();
  if(request.method()!=='GET' || !request.url().includes('status=eq.pending')) return route.continue();
  return route.fulfill({json:merged?[]:[{
   id:990001,key:'github.com/fixture/obscure',url:'https://github.com/fixture/obscure',name:'ObscurePort',
   description:'',category:'',images:[],alts:[],source:'Discord',status:'pending',parent:null,group_key:null,problem:null
  }]});
 });
 await page.route('**/rest/v1/rpc/publish_import',async route=>{
  const input=route.request().postDataJSON();
  expect(input.queue_id).toBe(990001);
  expect(input.destination).toBeGreaterThan(0);
  expect(input.input.name).toBe(name);
  expect(input.input.category).toBe('Combat');
  merged=true;
  return route.fulfill({json:input.destination});
 });
 await page.goto('/admin/import');
 const entry=page.locator('[data-entry]').filter({has:page.getByLabel('Name',{exact:true})});
 await expect(entry.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
 await entry.getByRole('combobox',{name:'Merge into existing addon…'}).fill(name);
 expect(merged).toBe(false);
 await entry.getByRole('option').filter({hasText:name}).click();
 await expect(entry).toHaveCount(0);
 expect(merged).toBe(true);
});
