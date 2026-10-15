import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test('importing a same-name link adds reviewed screenshots to the existing page', async ({page}) => {
 const keep = 'https://i.imgur.com/import-keep.png';
 const remove = 'https://i.imgur.com/import-remove.png';
 await page.route('https://i.imgur.com/import-*.png', route => route.fulfill({
  contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1kAAAAASUVORK5CYII=','base64')
 }));
 // Supply two queue previews; approval must honor the admin's retained selection.
 await page.route('**/rest/v1/import_queue?*',async route => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  const body = await response.json();
  if (Array.isArray(body)) for (const row of body) if(row.name === 'BagHelper') row.images = [keep,remove];
  await route.fulfill({response,json:body});
 });
 await loginAs(page,'admin');
 await page.goto('/admin/import');
 const entry=page.locator('[data-entry]').filter({has:page.getByRole('button',{name:'Add link to BagHelper',exact:true})});
 await expect(entry).toBeVisible();
 await expect(entry.getByText(/\+2 pictures/)).toBeVisible();
 await entry.getByRole('button',{name:'Remove this screenshot'}).last().click();
 await entry.getByRole('button',{name:'Add link to BagHelper',exact:true}).click();
 await expect(entry).toHaveCount(0);
 await page.goto('/addon/baghelper');
 await expect(page.locator(`main img[src="${keep}"]`)).toBeVisible();
 await expect(page.locator(`main img[src="${remove}"]`)).toHaveCount(0);
});
