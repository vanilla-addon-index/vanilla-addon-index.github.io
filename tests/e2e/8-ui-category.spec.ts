import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

test('UI & Appearance is available for posting and browsing',async({page})=>{
 await loginAs(page,'admin');
 const name=unique('Visual theme');
 await postAddon(page,name,{category:'UI & Appearance'});
 await expect(page.getByRole('link',{name:'UI & Appearance',exact:true})).toBeVisible();
 await page.goto('/submit');
 const categories=page.getByLabel('Category',{exact:true});
 await expect(categories.locator('option',{hasText:'UI & Appearance'})).toHaveCount(1);
 await expect(categories.locator('option',{hasText:'Interface Suites'})).toHaveCount(0);
 await page.goto('/');
 await page.getByRole('button',{name:/^UI & Appearance/}).click();
 await page.getByLabel('Search addons').fill(name);
 await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
});
