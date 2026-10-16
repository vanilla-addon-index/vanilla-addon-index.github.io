import {expect, test} from './test.ts';
import {loginAs, postAddon, unique} from './helpers.ts';

test('Macros is available for posting and filtering the list', async ({page}) => {
	await loginAs(page, 'admin');
	const name = unique('MacroHelper');
	await postAddon(page, name, {category:'Macros'});
	await expect(page.getByRole('link', {name:'Macros', exact:true})).toBeVisible();
	await page.goto('/');
	await page.getByRole('button', {name:/^Macros/}).click();
	await page.getByLabel('Search addons').fill(name);
	await expect(page.getByRole('link', {name, exact:true})).toBeVisible();
	await expect(page).toHaveURL(/cat=Macros/);
});
