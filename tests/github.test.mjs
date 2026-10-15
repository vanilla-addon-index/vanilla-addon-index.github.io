// What the README reader makes of a README: which links in it are pictures worth showing.
// See src/lib/github.ts. Nothing here talks to GitHub.
//
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { imagesIn, uncamo } from '../src/lib/github.ts';

const base = 'https://raw.githubusercontent.com/Owner/Addon/HEAD/README.md';

describe('pictures in a README', () => {
	test('markdown and html pictures are found, in the order they appear', () => {
		const readme = '# Addon\n![The window](https://i.imgur.com/AL5w5HE.png)\ntext\n<img width="300" src="https://user-images.githubusercontent.com/1/2.png">';
		assert.deepEqual(imagesIn(readme, base), ['https://i.imgur.com/AL5w5HE.png', 'https://user-images.githubusercontent.com/1/2.png']);
	});

	test('a picture kept in the repository resolves next to the README, and a page link to the file itself', () => {
		const readme = '![a](img/shot.png) ![b](./other.jpg) ![c](https://github.com/Owner/Addon/blob/master/docs/third.png)';
		assert.deepEqual(imagesIn(readme, base), [
			'https://raw.githubusercontent.com/Owner/Addon/HEAD/img/shot.png',
			'https://raw.githubusercontent.com/Owner/Addon/HEAD/other.jpg',
			'https://raw.githubusercontent.com/Owner/Addon/master/docs/third.png'
		]);
	});

	test('badges, donation buttons and insecure links are not screenshots, and one picture counts once', () => {
		const readme = '![build](https://img.shields.io/badge/x-y-green) ![logo](logo.svg) ![d](https://ko-fi.com/img/button.png) ![h](http://example.com/a.png) ![a](a.png) ![again](a.png)';
		assert.deepEqual(imagesIn(readme, base), ['https://raw.githubusercontent.com/Owner/Addon/HEAD/a.png']);
	});

	test('an address of GitHub\'s image proxy is turned back into the picture behind it', () => {
		const proxied = 'https://camo.githubusercontent.com/31a9cfffe7757716f2b94cd60b95e49c8fd67e82/687474703a2f2f692e696d6775722e636f6d2f4763616c5472482e676966';
		// The address is spelled out in hexadecimal after the signature; http becomes https.
		assert.equal(uncamo(proxied), 'https://i.imgur.com/GcalTrH.gif');
		assert.equal(uncamo('https://i.imgur.com/GcalTrH.gif'), 'https://i.imgur.com/GcalTrH.gif');
		// Not an address behind it: left as it is.
		assert.equal(uncamo('https://camo.githubusercontent.com/abc/6e6f742061206c696e6b'), 'https://camo.githubusercontent.com/abc/6e6f742061206c696e6b');
		assert.equal(uncamo('https://camo.githubusercontent.com/abc/zz'), 'https://camo.githubusercontent.com/abc/zz');
	});

	test('at most six, and none from a README without any', () => {
		const readme = Array.from({ length: 8 }, (_, i) => `![s](s${i}.png)`).join('\n');
		assert.equal(imagesIn(readme, base).length, 6);
		assert.deepEqual(imagesIn('Just words.', base), []);
	});
});
