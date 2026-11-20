import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test('the import queue requests only the active page and searches beyond it', async ({ page }) => {
	await loginAs(page, 'admin');
	const rows = Array.from({ length: 120 }, (_, index) => ({
		id: 90000 + index, key: `github.com/fixture/${index}`, name: `Queue fixture ${index}`,
		url: `https://github.com/fixture/${index}`, category: '', description: '', status: 'pending',
		images: [], alts: [], review_stats: { key: `github.com/fixture/${index}`, stars: index }
	}));
	const pages: [number, number][] = [];
	let counts = 0;
	let decided = 0;
	let allStats = 0;
	page.on('request', request => {
		const path = new URL(request.url()).pathname;
		if (path === '/rest/v1/decided_imports') decided++;
		if (path === '/rest/v1/repo_stats_current') allStats++;
	});
	await page.route('**/rest/v1/rpc/import_review_counts', route => {
		counts++;
		return route.fulfill({ json: {
			pending: 120, waiting: 120, incomplete: 120, fine: 0, duplicate: 0, wiki: 0,
			mirrors: 0, rejected: 0, dead: 0, approved: 0, submitted: 0, discord: 0
		} });
	});
	await page.route('**/rest/v1/pending_imports?*', route => {
		if (route.request().method() !== 'GET') return route.continue();
		const params = new URL(route.request().url()).searchParams;
		const offset = Number(params.get('offset')), limit = Number(params.get('limit'));
		pages.push([offset, limit]);
		const matches = params.has('search_document') ? rows.slice(-1) : rows;
		return route.fulfill({
			headers: {
				'content-range': `${offset}-${Math.min(offset + limit, matches.length) - 1}/${matches.length}`,
				'access-control-expose-headers': 'content-range'
			},
			json: matches.slice(offset, offset + limit)
		});
	});
	await page.goto('/admin/import');
	const entries = page.locator('[data-entry]');
	await expect(entries).toHaveCount(50);
	expect(pages).toEqual([[0, 50]]);
	expect(counts).toBe(1);
	expect(decided).toBe(0);
	expect(allStats).toBe(0);
	await page.getByRole('button', { name: 'Show 50 more of 120' }).click();
	await expect(entries).toHaveCount(100);
	expect(pages).toEqual([[0, 50], [50, 50]]);
	await page.getByLabel('Search', { exact: true }).fill('fixture 119');
	await expect(entries).toHaveCount(1);
	await expect(entries.getByLabel('Name')).toHaveValue('Queue fixture 119');
	expect(pages).toEqual([[0, 50], [50, 50], [0, 50]]);
	expect(counts).toBe(1);
});
