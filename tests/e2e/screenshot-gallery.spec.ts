import { expect, test } from './test.ts';

test('screenshots wait until nearby, appear independently, and keep the viewer on the selected image', async ({ page }) => {
	const name = 'Screenshot gallery';
	const address = 'https://i.imgur.com/';
	const images = ['gallery-slow.png', 'gallery-early.png', 'gallery-broken.png', 'gallery-last.png'];
	const proxied = Buffer.from(address + images[1]).toString('hex');
	const camo = (signature: string) => `https://camo.githubusercontent.com/${signature}/${proxied}`;
	const lastImage = `https://raw.githubusercontent.com/example/addon/main/${images[3]}`;
	const githubAlias = `https://github.com/example/addon/raw/main/${images[3]}`;
	const description = Array(150).fill('A long addon description keeps the screenshots well below the first screen.').join('\n');
	const requested: string[] = [];
	let releaseSlow!: () => void;
	const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=', 'base64');

	await page.setViewportSize({ width: 1280, height: 720 });
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: [{
		id: 98002, slug: 'screenshot-gallery', name, description, category: 'Combat', versions: [],
		images: [address + images[0], camo('abc'), camo('def'), address + images[2], githubAlias, lastImage],
		similar_addons: 'More addons'
	}] }));
	await page.route('**/rest/v1/rpc/addon_mirrors', route => route.fulfill({ json: [] }));
	await page.route('https://static.cloudflareinsights.com/**', route => route.abort());
	let proxyRequests = 0;
	await page.route('https://camo.githubusercontent.com/**', route => {
		proxyRequests++;
		return route.fulfill({ status: 403 });
	});
	await page.route(githubAlias, route => route.fulfill({ contentType: 'image/png', body: png }));
	await page.route(lastImage, route => {
		requested.push(images[3]);
		return route.fulfill({ contentType: 'image/png', body: png });
	});
	await page.route('https://i.imgur.com/gallery-*.png', async route => {
		const image = new URL(route.request().url()).pathname.slice(1);
		requested.push(image);
		if (image === images[0]) await slow;
		if (image === images[2]) return route.fulfill({ status: 404 });
		return route.fulfill({ contentType: 'image/png', body: png });
	});

	const gallery = page.locator('ul[aria-label="Screenshots"]');
	const shots = page.getByRole('button', { name: /^View screenshot/ });
	const shot = (index: number) => page.getByRole('button', { name: `View screenshot ${index} of ${name} full size` });
	const viewer = page.getByRole('dialog', { name: 'Screenshot viewer' });
	const followingText = page.getByText('More addons', { exact: true });
	const followingPosition = () => followingText.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
	try {
		await page.goto('/addon/screenshot-gallery');
		await expect(gallery).toBeAttached();
		await page.waitForLoadState('networkidle');
		expect(requested).toEqual([]);
		expect(await gallery.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(0);
		const before = await followingPosition();

		await gallery.scrollIntoViewIfNeeded();
		await expect(shot(2)).toBeVisible();
		await expect(shot(4)).toBeVisible();
		await expect(shots).toHaveCount(2);
		expect([...requested].sort()).toEqual([...images].sort());
		expect(proxyRequests).toBe(0);
		expect(await followingPosition()).toBeCloseTo(before);

		await shot(2).click();
		await expect(viewer.getByRole('img')).toHaveAttribute('src', address + images[1]);
		releaseSlow();
		await expect(shot(1)).toBeAttached();
		await expect(viewer.getByRole('img')).toHaveAttribute('src', address + images[1]);
		await page.keyboard.press('ArrowLeft');
		await expect(viewer.getByRole('img')).toHaveAttribute('src', address + images[0]);
		await page.keyboard.press('ArrowLeft');
		await expect(viewer.getByRole('img')).toHaveAttribute('src', lastImage);
		await page.keyboard.press('Escape');
		await expect(viewer).toBeHidden();
		await expect(shot(2)).toBeFocused();
		await expect(shots).toHaveCount(3);
		expect(await followingPosition()).toBeCloseTo(before);
	} finally {
		releaseSlow();
	}
});
