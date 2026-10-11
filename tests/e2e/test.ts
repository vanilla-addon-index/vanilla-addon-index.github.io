import { expect, test as base } from '@playwright/test';

// The test every browser test file uses. It adds one check to all of them: nothing the
// site did was refused by its Content-Security-Policy (see vite.config.ts). The policy
// lists what a page may load and talk to, and the browser drops anything else without
// telling the page, so a thing left off the list shows up as a feature that quietly
// stopped working. The browser does say so in its console, which is what this reads.
export const test = base.extend<{ policy: void }>({
	policy: [
		async ({ page }, use) => {
			const refused: string[] = [];
			page.on('console', (message) => {
				if (/Content Security Policy/i.test(message.text())) refused.push(message.text());
			});
			await use();
			expect(refused, 'refused by the Content-Security-Policy').toEqual([]);
		},
		{ auto: true }
	]
});

export { expect };
