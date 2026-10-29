import { expect, test } from './test.ts';

// The repository state is supplied at the API boundary; lifecycle and recovery are
// exercised against real Postgres in database/dead-links.test.mjs.
test('only the affected link is labelled unavailable, and recovery clears the label', async ({ page }) => {
 const missing = 'https://github.com/example/missing';
 const healthy = 'https://github.com/example/healthy';
 let unavailable = true;
 const row = () => ({
  id: 999999, slug: 'availability-check', name: 'Availability Check',
  description: 'An addon with two independent download links.', category: 'Miscellaneous',
  author: 'example', versions: [{ url: missing, note: '' }, { url: healthy, note: '' }],
  repo_url: missing, aliases: [], images: [], source: '', group_id: null, is_main: false,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-29T00:00:00Z',
  code_update: null, link_code_updates: {}, shared: true, pinned_link: null,
  separate_name: false, unavailable_links: unavailable ? [missing] : []
 });
 await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: [row()] }));
 await page.route('**/addons.json', route => route.fulfill({ json: [row()] }));
 await page.goto('/addon/availability-check');
 await expect(page.getByRole('heading', { level: 1, name: 'Availability Check' })).toBeVisible();
 const links = page.locator('aside ol > li');
 await expect(links).toHaveCount(2);
 await expect(links.filter({ has: page.getByRole('link', { name: missing, exact: true }) }).getByText('Currently unavailable', { exact: true })).toBeVisible();
 await expect(links.filter({ has: page.getByRole('link', { name: healthy, exact: true }) }).getByText('Currently unavailable', { exact: true })).toHaveCount(0);
 await expect(page.getByRole('link', { name: missing, exact: true })).toHaveAttribute('href', missing);
 unavailable = false;
 await page.reload();
 await expect(page.getByRole('heading', { level: 1, name: 'Availability Check' })).toBeVisible();
 await expect(page.getByText('Currently unavailable', { exact: true })).toHaveCount(0);
});
