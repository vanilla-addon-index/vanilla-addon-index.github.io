import {expect,test} from './test.ts';
import {loginAs,postAddon,unique} from './helpers.ts';

for(const who of ['admin','owner'] as const) test(`${who} can keep community submissions out of Your addons`, async({page})=>{
 await loginAs(page,who);
 const personal=unique(`Personal ${who}`), community=unique(`Community ${who}`);
 await page.goto('/submit');
 await expect(page.getByRole('checkbox',{name:'Post as a community listing',exact:true})).not.toBeChecked();
 await postAddon(page,personal);
 await page.getByRole('link',{name:'Edit',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'Post as a community listing',exact:true})).toHaveCount(0);
 await page.goto('/submit');
 await page.getByLabel('Addon name',{exact:true}).fill(community);
 await page.getByLabel('Link to the addon').fill(`https://gitlab.com/e2e/${community.replace(/\W+/g,'-')}`);
 await page.getByLabel('Category',{exact:true}).selectOption('Combat');
 await page.getByLabel('Description',{exact:true}).fill('A community addon listed without account ownership.');
 await page.getByRole('checkbox',{name:'Post as a community listing',exact:true}).check();
 await page.getByRole('button',{name:'Post addon',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name:community})).toBeVisible();
 await page.getByRole('button',{name:'Close wiki helper',exact:true}).click();
 const communityPath=new URL(page.url()).pathname;
 await expect(page.getByRole('region',{name:'Admin controls'}).getByText(`Posted by ${who}`,{exact:true})).toHaveCount(0);
 await page.goto('/account');
 await page.getByRole('navigation',{name:'Account sections'}).getByRole('button',{name:'Your addons',exact:true}).click();
 await expect(page.getByRole('link',{name:personal,exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:community,exact:true})).toHaveCount(0);
 await page.reload();
 await expect(page.getByRole('link',{name:personal,exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:community,exact:true})).toHaveCount(0);
 await page.goto(`/?q=${encodeURIComponent(community)}`);
 await expect(page.getByRole('link',{name:community,exact:true})).toBeVisible();
 await page.goto(communityPath);
 await page.getByRole('link',{name:'Edit',exact:true}).click();
 await page.getByLabel('Description',{exact:true}).fill('Staff can still maintain this community addon after submission.');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.getByText('Staff can still maintain this community addon after submission.',{exact:true})).toBeVisible();
});

test('ordinary members never see the submission ownership option',async({page})=>{
 await loginAs(page,'member');
 await page.goto('/submit');
 await expect(page.getByRole('heading',{name:'Submit addon',exact:true})).toBeVisible();
 await expect(page.getByRole('checkbox',{name:'Post as a community listing',exact:true})).toHaveCount(0);
});
