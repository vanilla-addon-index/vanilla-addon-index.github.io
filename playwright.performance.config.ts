import { defineConfig } from '@playwright/test';
import { ORIGIN } from './tests/performance/fixture.mjs';

export default defineConfig({
	testDir: 'tests/performance',
	workers: 1,
	timeout: 30_000,
	reporter: 'list',
	use: {
		baseURL: ORIGIN,
		serviceWorkers: 'block',
		launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] },
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'node tests/performance/serve.mjs',
		url: ORIGIN,
		reuseExistingServer: false,
		timeout: 90_000
	}
});
