import { readFileSync } from 'node:fs';
import { SITE_URL } from '#lib/config.ts';
import type { Addon } from '#lib/types.ts';

// Build time only: the list of pages search engines should know about, from the daily snapshot.
export const prerender = true;

export function GET() {
	const addons: Addon[] = JSON.parse(readFileSync('static/addons.json', 'utf8'));
	const pages = [
		`<url><loc>${SITE_URL}/</loc></url>`,
		...addons.map(
			(a) => `<url><loc>${SITE_URL}/addon/${a.slug}</loc><lastmod>${a.updated_at.slice(0, 10)}</lastmod></url>`
		)
	];
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.join('\n')}\n</urlset>\n`,
		{ headers: { 'Content-Type': 'application/xml' } }
	);
}
