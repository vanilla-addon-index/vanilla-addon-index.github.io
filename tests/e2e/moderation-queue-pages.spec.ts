import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test('reports, edit proposals, and link suggestions page independently and search beyond loaded rows', async ({ page }) => {
	await loginAs(page, 'admin');
	const pages: { queue: string; after_id: number; search: string; include_report_counts: boolean }[] = [];
	let reportCount = 53;
	await page.route('**/rest/v1/rpc/moderation_queue_page', route => {
		const input = route.request().postDataJSON();
		pages.push(input);
		const { queue, after_id, search, include_report_counts } = input;
		const rows = Array.from({ length: queue === 'reports' ? reportCount : 53 }, (_, index) => {
			const id = index + 1;
			const row = { id, addon_id: 1, proposer: { username: 'fixture' } };
			if (queue === 'reports') return {
				...row, reason: 'broken', note: `Report sample ${id}`, reported_by_name: 'fixture',
				created_at: '2026-11-19T00:00:00Z'
			};
			if (queue === 'edits') return { ...row, status: 'pending', base: {}, changes: { description: `Proposal sample ${id}` } };
			return { ...row, url: `https://github.com/fixture/link-${id}`, images: id === 53 ? ['https://github.com/fixture/screenshot.png'] : [] };
		});
		return route.fulfill({
			json: {
				rows: rows.filter(row => row.id > after_id && (!search || (queue === 'links' && 'url' in row && row.url?.includes(search)))).slice(0, 51),
				report_counts: include_report_counts ? { broken: reportCount } : null
			}
		});
	});

	await page.goto('/admin/reports');
	const reportToggle = (id: number) => page.locator('#report-' + id + ' [data-act="review"]');
	await expect(reportToggle(1)).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByText('Report sample 50', { exact: true })).toBeHidden();
	await reportToggle(50).click();
	await expect(page.getByText('Report sample 50', { exact: true })).toBeVisible();
	await expect(reportToggle(1)).toHaveAttribute('aria-expanded', 'false');
	await reportToggle(50).press('Enter');
	await expect(reportToggle(50)).toHaveAttribute('aria-expanded', 'true');
	expect(pages).toEqual([{ queue: 'reports', after_id: 0, search: '', include_report_counts: true }]);
	await expect(page.getByText('Report sample 51', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show more reports' }).click();
	await expect(reportToggle(50)).toHaveAttribute('aria-expanded', 'true');
	await reportToggle(53).click();
	await expect(page.getByText('Report sample 53', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show more reports' })).toHaveCount(0);
	expect(pages.at(-1)).toEqual({ queue: 'reports', after_id: 50, search: '', include_report_counts: false });

	reportCount = 2;
	await page.reload();
	await reportToggle(2).click();
	await expect(page.getByText('Report sample 2', { exact: true })).toBeVisible();
	const beforeSearch = pages.length;
	await page.getByRole('searchbox', { name: 'Search reports' }).fill('Report sample 1');
	await expect(page.getByText('Report sample 2', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Report sample 1', { exact: true })).toBeVisible();
	expect(pages).toHaveLength(beforeSearch);

	await page.goto('/admin/edits');
	const more = page.getByRole('button', { name: 'Show more reviews' });
	const reviewToggle = (kind: 'edit' | 'link', id: number) => page.locator('#' + kind + '-review-' + id + ' [data-act="review"]');
	await expect(more).toBeVisible();
	await expect(reviewToggle('edit', 1).getByText('Edit proposal', { exact: true })).toBeVisible();
	await expect(reviewToggle('link', 1).getByText('Link suggestion', { exact: true })).toBeVisible();
	await expect(page.locator('.panel').filter({ has: reviewToggle('edit', 1) }).filter({ has: reviewToggle('link', 1) })).toHaveCount(1);
	await expect(page.locator('main [data-act="review"][aria-expanded="true"]')).toHaveCount(1);
	await more.click();
	await expect(more).toHaveCount(0);
	expect(pages.slice(-2).map(p => [p.queue, p.after_id]).sort()).toEqual([['edits', 50], ['links', 50]]);
	const proposal = page.locator('#edit-review-53');
	await reviewToggle('edit', 53).click();
	await expect(proposal.getByText('Proposal sample 53', { exact: true })).toBeVisible();
	await proposal.getByRole('checkbox', { name: 'Description', exact: true }).uncheck();
	await reviewToggle('link', 53).click();
	await expect(page.getByRole('link', { name: 'https://github.com/fixture/link-53', exact: true })).toBeVisible();
	await expect(page.getByAltText('Suggested screenshot')).toBeVisible();
	await expect(reviewToggle('edit', 53)).toHaveAttribute('aria-expanded', 'false');
	await reviewToggle('edit', 53).click();
	await expect(proposal.getByRole('checkbox', { name: 'Description', exact: true })).not.toBeChecked();

	await page.route('**/rest/v1/rpc/decide_addon_edit', route => route.fulfill({ status: 204 }));
	await proposal.getByRole('button', { name: 'Reject proposal' }).click();
	await expect(proposal).toHaveCount(0);
	await expect(reviewToggle('edit', 52)).toHaveAttribute('aria-expanded', 'true');

	await page.getByRole('searchbox', { name: 'Search edit reviews' }).fill('link-53');
	await expect.poll(() => pages.filter(p => p.search === 'link-53').map(p => [p.queue, p.after_id]).sort()).toEqual([['edits', 0], ['links', 0]]);
	await expect(page.getByRole('link', { name: 'https://github.com/fixture/link-53', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'https://github.com/fixture/link-1', exact: true })).toHaveCount(0);
});
