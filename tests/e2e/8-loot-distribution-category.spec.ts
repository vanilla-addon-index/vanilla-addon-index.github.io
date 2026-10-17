import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

test('Loot Distribution is available for posting and filtering',async({page})=>{
	await loginAs(page,'admin');
	const name=unique('LootCouncil');
	await postAddon(page,name,{category:'Loot Distribution'});
	await expect(page.getByRole('link',{name:'Loot Distribution',exact:true})).toBeVisible();
	await page.goto('/');
	await page.getByRole('button',{name:/^Loot Distribution/}).click();
	await page.getByLabel('Search addons').fill(name);
	await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
	await expect(page).toHaveURL(/cat=Loot(?:\+|%20)Distribution/);
});
