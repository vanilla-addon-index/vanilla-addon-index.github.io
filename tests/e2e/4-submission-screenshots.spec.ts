import { expect, test } from './test.ts';
import { loginAs, postAddon, unique } from './helpers.ts';

const stable = 'https://github.com/user-attachments/assets/39f10b7d-8916-4150-a547-09a24fa2efd8';
const signed = 'https://private-user-images.githubusercontent.com/29808955/641515915-39f10b7d-8916-4150-a547-09a24fa2efd8.png?jwt=' + 'x'.repeat(800);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=';

for (const who of ['admin', 'member'] as const) test(`same-name ${who} submission carries screenshots and normalizes signed GitHub images`, async ({ page }) => {
 await page.route('https://github.com/user-attachments/assets/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
 await loginAs(page, who);
 const name = unique('Screenshot ' + who);
 const address = await postAddon(page, name);
 await page.goto('/submit');
 await page.getByLabel('Addon name', { exact: true }).fill(name);
 await page.getByLabel('Link to the addon', { exact: true }).fill(`https://gitlab.com/e2e/${name.replace(/\W+/g, '-')}-mirror`);
 await expect(page.getByLabel('Category', { exact: true })).toBeDisabled();
 const input = page.getByLabel('Screenshots', { exact: true });
 await expect(input).toBeEnabled();
 await input.fill(signed);
 await page.getByRole('button', { name: 'Add', exact: true }).click();
 await expect(page.locator('fieldset img')).toHaveAttribute('src', stable);
 await expect(page.getByText('1 / 5', { exact: true })).toBeVisible();
 for (let i = 2; i <= 5; i++) {
  await input.fill(stable + '?shot=' + i);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(`${i} / 5`, { exact: true })).toBeVisible();
 }
 await expect(input).toBeDisabled();
 await page.getByRole('button', { name: who === 'admin' ? 'Add link' : 'Submit for review', exact: true }).click();
 await expect(page).toHaveURL(address);
 if (who === 'member') {
  await expect(page.getByRole('button', { name: /^View screenshot/ })).toHaveCount(0);
  await page.goto('/account');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
  await loginAs(page, 'admin');
  await page.goto('/admin/edits');
  const request = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'New link for ' + name, exact: true }) });
  await expect(request.getByAltText('Suggested screenshot')).toHaveCount(5);
  await request.getByRole('button', { name: 'Approve link', exact: true }).click();
  await expect(request).toHaveCount(0);
  await page.goto(address);
 }
 await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
 await expect(page.getByRole('button', { name: /^View screenshot/ })).toHaveCount(5);
 await expect(page.locator('main button[aria-label^="View screenshot"] img').first()).toHaveAttribute('src', stable);
});


test('a matching submission still fetches screenshots from its repository README', async ({ page }) => {
 const name = unique('Readme screenshots');
 const repository = 'ScreenshotFork-' + name.replace(/\W+/g, '-');
 await page.route('https://github.com/user-attachments/assets/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
 await page.route(`https://api.github.com/repos/e2e/${repository}/readme`, route => route.fulfill({ json: {
  content: Buffer.from(`![shot](${stable})`).toString('base64'),
  download_url: `https://raw.githubusercontent.com/e2e/${repository}/main/README.md`
 } }));
 await loginAs(page, 'admin');
 const address = await postAddon(page, name);
 await page.goto('/submit');
 await page.getByLabel('Addon name', { exact: true }).fill(name);
 await page.getByLabel('Link to the addon', { exact: true }).fill(`https://github.com/e2e/${repository}`);
 await page.getByRole('button', { name: 'Fetch README images', exact: true }).click();
 await expect(page.locator('fieldset img')).toHaveAttribute('src', stable);
 await page.getByRole('button', { name: 'Add link', exact: true }).click();
 await expect(page).toHaveURL(address);
 await expect(page.getByRole('button', { name: /^View screenshot/ })).toHaveCount(1);
});


test('editing a release URL saves on the first click without fetching images', async ({ page }) => {
 await loginAs(page, 'admin');
 const name = unique('Save repository');
 const address = await postAddon(page, name);
 await page.getByRole('link', { name: 'Edit', exact: true }).click();
 let reads = 0;
 await page.route('https://api.github.com/repos/**/readme', route => { reads++; return route.abort(); });
 await page.getByLabel('Link to the addon', { exact: true }).fill(`https://github.com/e2e/${name.replace(/\W+/g, '-')}/releases/latest/download/addon.zip`);
 await page.getByRole('button', { name: 'Save changes', exact: true }).click();
 await expect(page).toHaveURL(address);
 expect(reads).toBe(0);
 await page.getByRole('link', { name: 'Edit', exact: true }).click();
 await expect(page.getByLabel('Link to the addon', { exact: true })).toHaveValue(`https://github.com/e2e/${name.replace(/\W+/g, '-')}`);
});
