import { existsSync, readFileSync } from 'node:fs';

// Refuses to run the browser tests against anything but the backend on this computer.
// `npm run test:e2e` starts and fills that backend first, which writes this file.
export default function setup() {
	const file = '.env.localdb';
	const local = existsSync(file) && /^VITE_SUPABASE_URL=http:\/\/(localhost|127\.0\.0\.1)[:/]/m.test(readFileSync(file, 'utf8'));
	if (!local) {
		throw new Error(
			'The local backend has not been set up. Run the browser tests with "npm run test:e2e", which starts and fills it first.'
		);
	}
}
