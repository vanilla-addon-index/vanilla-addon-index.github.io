import { expect, type Locator, type Page } from '@playwright/test';
import { LOCAL_ACCOUNTS } from '../../src/lib/local-accounts.ts';

export type Who = 'owner' | 'admin' | 'admin2' | 'member' | 'member2' | 'leaver' | 'banned';

/** Logs in as one of the seeded test accounts, through the login page like anyone would. */
export async function loginAs(page: Page, who: Who) {
	const account = LOCAL_ACCOUNTS.find((a) => a.username === who)!;
	await page.goto('/login');
	await page.getByRole('button', { name: `Log in as ${account.label}`, exact: true }).click();
	await expect(page.getByRole('navigation').getByRole('link', { name: who, exact: true })).toBeVisible();
}

/** The site's own prompt: "are you sure?", or a notice with one button. */
export const prompt = (page: Page) => page.locator('dialog[open]');

/** Answers the open prompt with the button of that name. */
export async function confirm(page: Page, action: string) {
	await prompt(page).getByRole('button', { name: action, exact: true }).click();
	await expect(prompt(page)).toHaveCount(0);
}

/** A name no other test uses, so tests can run in any order against the shared database. */
export const unique = (name: string) => `${name} ${Date.now().toString(36).slice(-5)}`;

/** Posts an addon through the submit form and lands on its page. Returns that page's address. */
export async function postAddon(page: Page, name: string, extra: { category?: string; description?: string } = {}) {
	await page.goto('/submit');
	await page.getByLabel('Name', { exact: true }).fill(name);
	// Not a GitHub link, so the form does not go looking for a README.
	await page.getByLabel('Link to the addon').fill(`https://gitlab.com/e2e/${name.replace(/\W+/g, '-')}`);
	await page.getByLabel('Category', { exact: true }).selectOption(extra.category ?? 'Combat');
	await page.getByLabel('Description', { exact: true }).fill(extra.description ?? `${name} was posted by a browser test.`);
	await page.getByRole('button', { name: 'Post addon' }).click();
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	return new URL(page.url()).pathname;
}

/** The line of the admin log about this addon or account that says this, newest first. */
export const logLine = (page: Page, text: string | RegExp): Locator =>
	page.locator('.panel > div').filter({ hasText: text }).first();
