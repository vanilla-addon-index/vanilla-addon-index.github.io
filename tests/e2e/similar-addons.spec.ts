import {expect, test} from './test.ts';
import {loginAs, postAddon, unique} from './helpers.ts';

test('admins edit similar addons inline; visitors and members never see the tool', async ({page})=>{
 await loginAs(page,'admin');
 const name=unique('Search comparisons');
 const path=await postAddon(page,name,{description:'Tracks buffs with customizable icons.'});
 const similarTool=page.getByRole('region',{name:'Admin controls'}).locator('summary').filter({hasText:'Similar addons'});
 await similarTool.focus();
 await similarTool.press('Enter');
 await page.getByRole('button',{name:'Add similar addons',exact:true}).click();
 await page.getByLabel('Similar addons',{exact:true}).fill('MPOWA, WeakAuras');
 await page.getByRole('button',{name:'Save similar addons',exact:true}).click();
 const configuredNames=similarTool.locator('..').getByText('MPOWA, WeakAuras',{exact:true});
 await expect(configuredNames).toBeVisible();
 await page.getByRole('button',{name:'Edit similar addons',exact:true}).click();
 await expect(page.getByLabel('Similar addons',{exact:true})).toHaveValue('MPOWA, WeakAuras');
 await page.getByLabel('Similar addons',{exact:true}).fill('Unsaved');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('button',{name:'Edit similar addons',exact:true})).toBeFocused();
 await expect(configuredNames).toBeVisible();
 await page.getByRole('link',{name:'Edit',exact:true}).click();
 await expect(page.getByLabel('Similar addons',{exact:false})).toHaveCount(0);
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.locator('article > .panel').getByText('MPOWA, WeakAuras',{exact:true})).toBeVisible();
 await page.goto('/?q=weak%20auras');
 const row=page.locator('.addon-list > div').filter({has:page.getByRole('link',{name,exact:true})});
 await expect(row).toContainText('Tracks buffs with customizable icons.');
 await expect(row).not.toContainText('WeakAuras');
 await page.setViewportSize({width:390,height:844});
 await expect(row).not.toContainText('WeakAuras');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.goto(path);
 await similarTool.click();
 await page.getByRole('button',{name:'Edit similar addons',exact:true}).click();
 await page.getByLabel('Similar addons',{exact:true}).fill('');
 await page.getByRole('button',{name:'Save similar addons',exact:true}).click();
 await expect(page.getByRole('button',{name:'Add similar addons',exact:true})).toBeVisible();
 await expect(page.getByText('MPOWA, WeakAuras',{exact:true})).toHaveCount(0);
 // A direct entry edit updates that cached row and leaves the rest available offline.
 const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('addons-v3') ?? '[]'));
 expect(cached).toEqual(expect.arrayContaining([
  expect.objectContaining({slug:'raidhelper'}),
  expect.objectContaining({name,similar_addons:''})
 ]));
 await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
 await page.context().clearCookies();
 await page.goto(path);
 await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/^(Add|Edit) similar addons$/})).toHaveCount(0);
 await loginAs(page,'member');
 await page.goto(path);
 await expect(page.getByRole('button',{name:/^(Add|Edit) similar addons$/})).toHaveCount(0);
 await page.goto('/submit');
 await expect(page.getByLabel('Similar addons',{exact:false})).toHaveCount(0);
});
