import {expect,test} from './test.ts';
import {confirm,loginAs,postAddon,unique,type Who} from './helpers.ts';
import type {Page} from '@playwright/test';

async function switchUser(page:Page,user:Who) {
 await page.goto('/account');
 await page.getByRole('button',{name:'Log out',exact:true}).click();
 await expect(page.getByRole('link',{name:'Log in',exact:true})).toBeVisible();
 await loginAs(page,user);
}

test('contributors propose reviewed edits, remove their own links, and keep access to empty shared pages',async({page})=>{
 await loginAs(page,'member2');
 const name=unique('Reviewed');
 const address=await postAddon(page,name);
 const description= `${name} was posted by a browser test.`;
 await switchUser(page,'admin');
 await page.goto('/submit');
 await page.getByLabel('Name',{exact:true}).fill(name);
 await page.getByLabel('Link to the addon').fill('https://gitlab.com/e2e/'+name.replace(/\W+/g,'-')+'-fork');
 await page.getByRole('button',{name:'Add link',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
 await switchUser(page,'member2');
 await page.goto(address);
 await expect(page.getByRole('link',{name:'Propose edits',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Remove my link',exact:true}).click();
 await confirm(page,'Remove my link');
 await expect(page.getByRole('button',{name:'Remove my link',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Edit',exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Propose edits',exact:true}).click();
 await page.getByLabel('Description',{exact:true}).fill('A new description for review, not yet published.');
 await page.getByLabel('Addon author',{exact:true}).fill('Reviewed author');
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await expect(page.getByText('Your edit is waiting for admin review.')).toBeVisible();
 await expect(page.getByText(description,{exact:true})).toBeVisible();
 await switchUser(page,'admin');
 await page.goto('/admin/edits');
 const request=page.getByRole('region',{name:'Edit proposal for '+name});
 await expect(request.getByText('Reviewed author',{exact:true})).toBeVisible();
 await request.getByRole('checkbox',{name:'Description',exact:true}).uncheck();
 await request.getByRole('button',{name:'Accept selected fields'}).click();
 await expect(request).toHaveCount(0);
 await page.goto(address);
 await expect(page.getByText('Reviewed author',{exact:true})).toBeVisible();
 await expect(page.getByText(description,{exact:true})).toBeVisible();
 // Admins can remove the final link without deleting the shared page.
 await page.getByRole('link',{name:'Edit',exact:true}).click();
 await page.getByLabel('Link to the addon').fill('');
 await page.getByRole('button',{name:'Save changes'}).click();
 await expect(page.getByText('No download links currently listed.')).toBeVisible();
 await expect(page.locator('dl').getByText('Unknown',{exact:true})).toBeVisible();
 await switchUser(page,'member2');
 await page.goto(address);
 await expect(page.getByText('No download links currently listed.')).toBeVisible();
 await page.getByRole('link',{name:'Propose edits',exact:true}).click();
 await page.getByLabel('Addon author',{exact:true}).fill('Another proposed author');
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await page.getByRole('link',{name:'Propose edits',exact:true}).click();
 await expect(page.getByLabel('Addon author',{exact:true})).toHaveValue('Another proposed author');
 await page.getByLabel('Addon author',{exact:true}).fill('Revised author proposal');
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await page.getByRole('button',{name:'Withdraw proposal',exact:true}).click();
 await expect(page.getByText('Your edit is waiting for admin review.')).toHaveCount(0);
 await expect(page.getByText('Reviewed author',{exact:true})).toBeVisible();
});
