import { expect, test } from './test.ts';
import { confirm, loginAs, postAddon, prompt, unique } from './helpers.ts';

// An ordinary account: posts, edits and deletes its own addons, reports others, and gets
// no further.

test('a member posts an addon, edits it and deletes it', async ({ page }) => {
	await loginAs(page, 'member');
	const name = unique('Posted');
	const address = await postAddon(page, name);

	await page.goto('/account');
	await page.getByRole('navigation', { name: 'Account sections' }).getByRole('button', { name: 'Your addons', exact: true }).click();
	await expect(page.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();

	await page.goto(address);
	await page.getByRole('link', { name: 'Edit' }).click();
	await page.getByLabel('Addon author').fill('Someone Else');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(page.getByText('Someone Else')).toBeVisible();

	await page.getByRole('button', { name: 'Delete' }).click();
	await confirm(page, 'Delete');
	await expect(page).toHaveURL('/');
	await page.goto(address);
	await expect(page.getByRole('heading', { name: 'Addon not found' })).toBeVisible();
});

test('logging in brings you back to the page you logged in from', async ({ page }) => {
	const member = page.getByRole('button', { name: 'Log in as a member', exact: true });

	// From an addon's page, to report it.
	await page.goto('/addon/raidhelper');
	await page.getByRole('link', { name: 'Log in to report this addon' }).click();
	await expect(page).toHaveURL('/login?next=%2Faddon%2Fraidhelper');
	await member.click();
	await expect(page).toHaveURL('/addon/raidhelper');
	await expect(page.getByRole('button', { name: 'Report this addon' })).toBeVisible();

	// From the submit page, keeping what it was asked to edit.
	await page.goto('/account');
	await page.getByRole('button', { name: 'Log out' }).click();
	await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
	await page.goto('/submit?edit=raidhelper');
	await page.getByRole('main').getByRole('link', { name: 'Log in' }).click();
	await member.click();
	await expect(page).toHaveURL('/submit?edit=raidhelper');
});

test('a login link cannot send you to another site', async ({ page }) => {
	for (const next of ['https://example.com/', '//example.com/', '/\\example.com', '/login?next=/login']) {
		await page.goto(`/login?next=${encodeURIComponent(next)}`);
		await page.getByRole('button', { name: 'Log in as a member', exact: true }).click();
		await expect(page.getByRole('navigation').getByRole('link', { name: 'member', exact: true })).toBeVisible();
		await expect(page).toHaveURL('/');
		await page.goto('/account');
		await page.getByRole('button', { name: 'Log out' }).click();
		await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
	}
});

test('the form refuses a description that is too short, and a link that is already listed', async ({ page }) => {
	await loginAs(page, 'member');
	await page.goto('/submit');
	await page.getByLabel('Name', { exact: true }).fill(unique('Short'));
	await page.getByLabel('Link to the addon').fill('https://gitlab.com/e2e/short');
	await page.getByLabel('Category', { exact: true }).selectOption('Combat');
	await page.getByLabel('Description', { exact: true }).fill('Too short');
	await expect(page.getByText(/At least 15 characters · 6 to go/)).toBeVisible();
	await page.getByRole('button', { name: 'Post addon' }).click();
	await expect(page.getByText('The description needs at least 15 characters.')).toBeVisible();

	// The link of an addon that is already live, spelled differently.
	await page.getByLabel('Link to the addon').fill('https://github.com/Member/member-bags.git');
	await expect(page.getByText('This link is already listed as')).toBeVisible();
});

test('a member cannot edit what someone else posted, or reach the admin pages', async ({ page }) => {
	await loginAs(page, 'member');
	await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

	await page.goto('/addon/second-member-chat');
	await expect(page.getByRole('heading', { level: 1, name: 'Second Member Chat' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

	await page.goto('/submit?edit=second-member-chat');
	await expect(page.getByText('Only the person who posted this addon can edit it.')).toBeVisible();
	await page.goto('/admin/log');
	await expect(page.getByText('This part of the site is for admins.')).toBeVisible();
});

test('the eleventh edit within an hour is refused with a pop-up', async ({ page }) => {
	await loginAs(page, 'member2');
	const address = await postAddon(page, unique('Edited'));
	const slug = address.split('/').pop();
	for (let i = 1; i <= 11; i++) {
		await page.goto(`/submit?edit=${slug}`);
		await page.getByLabel('Addon author').fill(`Draft ${i}`);
		await page.getByRole('button', { name: 'Save changes' }).click();
		if (i <= 10) await expect(page.getByText(`Draft ${i}`, { exact: true })).toBeVisible();
	}
	await expect(prompt(page).getByRole('heading', { name: 'Limit reached' })).toBeVisible();
	await expect(prompt(page).getByText('You can make at most 10 edits an hour. Try again later.')).toBeVisible();
	await confirm(page, 'OK');
});

test('a member reports an addon', async ({ page }) => {
	await loginAs(page, 'member');
	await page.goto('/addon/questhelper');
	await page.getByRole('button', { name: 'Report this addon' }).click();
	await prompt(page).getByLabel('What is wrong with it?').selectOption('harmful');
	await prompt(page).getByLabel('Details').fill('Reported by a browser test.');
	await prompt(page).getByRole('button', { name: 'Send report' }).click();
	await expect(prompt(page).getByText('Thank you. An admin will take a look.')).toBeVisible();
});

test('a banned member can browse but not post', async ({ page }) => {
	await loginAs(page, 'banned');
	await expect(page.getByText('Your account is suspended. You can browse, but not post or edit.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Submit addon' })).toHaveCount(0);
	await page.goto('/addon/banned-tooltip');
	await expect(page.getByRole('heading', { level: 1, name: 'Banned Tooltip' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Report this addon' })).toHaveCount(0);
});

test('a member deletes their own account, and what they posted stays in the list', async ({ page }) => {
	await loginAs(page, 'leaver');
	const name = unique('Leaver Bars');
	const address = await postAddon(page, name);

	await page.goto('/account');
	await page.getByRole('button', { name: 'Delete account' }).click();
	await expect(prompt(page).getByText(/stays in the list, belonging to nobody/)).toBeVisible();
	// A click alone does nothing: the account's name has to be typed out first.
	const confirmButton = prompt(page).getByRole('button', { name: 'Delete account' });
	await expect(confirmButton).toBeDisabled();
	await prompt(page).getByLabel(/To confirm, type leaver below/).fill('leave');
	await expect(confirmButton).toBeDisabled();
	await prompt(page).getByLabel(/To confirm, type leaver below/).fill('leaver');
	await confirmButton.click();

	// Logged out, on the home page, with the account gone for good.
	await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
	await page.goto(address);
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
	await page.goto('/login');
	await page.getByRole('button', { name: 'Log in as a member who leaves', exact: true }).click();
	await expect(page.getByText(/invalid login/i)).toBeVisible();
});


test('a matching name submits a link for review and never grants control of the shared page', async ({page}) => {
 await loginAs(page,'member');
 await page.goto('/submit');
 await page.getByLabel('Name',{exact:true}).fill('raidhelper');
 await expect(page.getByLabel('Description',{exact:true})).toBeDisabled();
 await expect(page.getByLabel('Category',{exact:true})).toBeDisabled();
 await expect(page.getByLabel('Addon author',{exact:true})).toBeDisabled();
 const url='https://gitlab.com/e2e/shared-fork';
 await page.getByLabel('Link to the addon').fill(url);
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name:'RaidHelper'})).toBeVisible();
 await expect(page.getByRole('link',{name:url,exact:true})).toHaveCount(0);
 await expect(page.getByText('Your link is waiting for admin review.').first()).toBeVisible();
 await expect(page.getByRole('link',{name:'Edit',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Delete',exact:true})).toHaveCount(0);
});
