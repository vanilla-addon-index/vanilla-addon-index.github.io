import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

for (const who of ['admin', 'owner'] as const) {
 test(`${who} restore controls respect owner rejections`, async ({ page }) => {
  await loginAs(page, who);
  await page.route('**/rest/v1/import_queue?*', async route => {
   if (route.request().method() !== 'GET' || !route.request().url().includes('status=eq.rejected')) return route.continue();
   const response = await route.fetch();
   const rows = await response.json();
   await route.fulfill({response, json: [
    {...rows[0], id:900001, name:'OwnerRejectedImport', rejected_by_owner:true},
    {...rows[0], id:900002, name:'AdminRejectedImport', rejected_by_owner:false}
   ]});
  });
  let restores = 0;
  await page.route('**/rest/v1/rpc/decide_imports', route => {
   restores++;
   return route.fulfill({json:1});
  });
  await page.goto('/admin/import');
  await page.getByRole('button', {name:/^Rejected/}).click();
  const owned = page.locator('[data-entry]').filter({hasText:'OwnerRejectedImport'});
  const other = page.locator('[data-entry]').filter({hasText:'AdminRejectedImport'});
  const restore = owned.getByRole('button', {name:'Put back in the queue',exact:true});
  await expect(owned.getByText(/Rejected by owner/)).toBeVisible();
  await expect(other.getByRole('button', {name:'Put back in the queue',exact:true})).toBeEnabled();
  if (who === 'admin') {
   await expect(restore).toBeDisabled();
   await owned.click();
   await page.getByRole('region', {name:'Import entries',exact:true}).focus();
   await page.keyboard.press('u');
   await expect(page.getByText('Only the owner can restore this rejection.',{exact:true})).toBeVisible();
   expect(restores).toBe(0);
   await other.getByRole('button', {name:'Put back in the queue',exact:true}).click();
   await expect(other).toHaveCount(0);
  } else {
   await expect(restore).toBeEnabled();
   await restore.click();
   await expect(owned).toHaveCount(0);
  }
  expect(restores).toBe(1);
 });
}
