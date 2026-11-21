import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test('the import queue continues past a removed row and searches beyond the first page', async ({ page }) => {
	await loginAs(page, 'admin');
	const rows = Array.from({ length: 120 }, (_, index) => ({
		id: 90000 + index, key: `github.com/fixture/${index}`, name: `Queue fixture ${index}`,
		sort_name: index === 49 || index === 50 ? 'queue fixture 049, "same"' : `queue fixture ${String(index).padStart(3, '0')}`,
		url: `https://github.com/fixture/${index}`, category: '', description: '', status: 'pending',
		images: [], alts: [], review_stats: { key: `github.com/fixture/${index}`, stars: index }
	}));
	const pages: (string | null)[] = [];
	const removed = new Set<number>();
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
		expect(params.get('offset')).toBeNull();
		expect(params.get('limit')).toBe('51');
		const predicate = params.get('or');
		pages.push(predicate);
		const after = predicate && rows.find(row => row.id === Number(predicate.match(/id\.gt\.(\d+)/)?.[1]));
		const source = params.has('search_document') ? rows.slice(-1) : rows;
		const matches = source.filter(row => !removed.has(row.id) && (!after ||
			row.sort_name > after.sort_name || (row.sort_name === after.sort_name && row.id > after.id)));
		return route.fulfill({ json: matches.slice(0, 51) });
	});
	await page.goto('/admin/import');
	const entries = page.locator('[data-entry]');
	await expect(entries).toHaveCount(50);
	const summary = (index: number) => entries.nth(index).locator('button[data-act="review"]');
	await expect(summary(0)).toHaveAttribute('aria-expanded', 'true');
	await expect(entries.nth(1).getByLabel('Name')).toBeHidden();
	const firstName = entries.first().getByLabel('Name');
	await firstName.fill('Local draft');
	await summary(1).click();
	await expect(firstName).toBeHidden();
	await expect(entries.nth(1).getByLabel('Name')).toBeVisible();
	await page.keyboard.press('k');
	await expect(summary(0)).toBeFocused();
	await expect(firstName).toHaveValue('Local draft');
	await summary(0).press('Enter');
	await expect(firstName).toBeVisible();
	await expect(entries.locator('[data-act="review"][aria-expanded="true"]')).toHaveCount(1);
	await page.keyboard.press('e');
	await expect(firstName).toBeFocused();
	expect(pages).toEqual([null]);
	expect(counts).toBe(1);
	expect(decided).toBe(0);
	expect(allStats).toBe(0);
	removed.add(rows[10].id);
	removed.add(rows[49].id);
	expect(pages).toHaveLength(1);
	await page.getByRole('button', { name: 'Show more imports' }).click();
	await expect(entries).toHaveCount(100);
	await expect(entries.nth(50).getByLabel('Name')).toHaveValue(rows[50].name);
	const sortName = JSON.stringify(rows[49].sort_name);
	const keyset = `(sort_name.gt.${sortName},and(sort_name.eq.${sortName},id.gt.${rows[49].id}))`;
	expect(pages).toEqual([null, keyset]);
	await page.getByLabel('Search', { exact: true }).fill('fixture 119');
	await expect(entries).toHaveCount(1);
	await expect(entries.getByLabel('Name')).toHaveValue('Queue fixture 119');
	expect(pages).toEqual([null, keyset, null]);
	expect(counts).toBe(1);
});
