import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

test('Roleplay is available for posting and filtering',async({page})=>{
	await loginAs(page,'admin');
	const name=unique('RPProfile');
	await postAddon(page,name,{category:'Roleplay'});
	await expect(page.getByRole('link',{name:'Roleplay',exact:true})).toBeVisible();
	await page.goto('/');
	await page.getByRole('button',{name:/^Roleplay/}).click();
	await page.getByLabel('Search addons').fill(name);
	await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
	await expect(page).toHaveURL(/cat=Roleplay/);
});
