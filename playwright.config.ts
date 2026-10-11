import { defineConfig } from '@playwright/test';

// Browser tests: the real site in a real browser, against the copy of the backend on this
// computer. `npm run test:e2e` wipes and fills that copy first; see scripts/local.mjs.
export default defineConfig({
	testDir: 'tests/e2e',
	globalSetup: './tests/e2e/setup.ts',
	// The tests share one database, so they run one after another, in file order.
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: { timeout: 7_000 },
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:5174',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'npm run dev:local',
		url: 'http://localhost:5174',
		reuseExistingServer: true,
		timeout: 60_000
	}
});
