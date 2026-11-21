import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { addons, mirror, ORIGIN, SUPABASE } from './fixture.mjs';

const work = resolve('node_modules/.cache/performance');
const build = join(work, 'build');
const snapshot = join(work, 'static', 'addons.json');
mkdirSync(join(work, 'static'), { recursive: true });
rmSync(snapshot, { force: true });

// Run the real exporter against fixtures. Every request is answered in-process.
const cwd = process.cwd();
const fetch = globalThis.fetch;
try {
	process.chdir(work);
	globalThis.fetch = async (input) => {
		const url = new URL(input);
		const rows = url.pathname === '/rest/v1/addons' ? addons : [mirror];
		assert.ok(['/rest/v1/addons', '/rest/v1/published_addon_mirrors'].includes(url.pathname), url.pathname);
		const offset = Number(url.searchParams.get('offset'));
		const limit = Number(url.searchParams.get('limit'));
		const columns = url.searchParams.get('select').split(',');
		return Response.json(rows.slice(offset, offset + limit).map(row => Object.fromEntries(
			columns.map(column => {
				assert.ok(Object.hasOwn(row, column), `Missing fixture field ${column}`);
				return [column, row[column]];
			})
		)));
	};
	await import('../../scripts/export.mjs');
} finally {
	process.chdir(cwd);
	globalThis.fetch = fetch;
}

execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
	stdio: 'inherit',
	env: {
		...process.env,
		PUBLICATION_SNAPSHOT: snapshot,
		PERFORMANCE_BUILD_DIR: build,
		VITE_SUPABASE_URL: SUPABASE,
		VITE_SUPABASE_ANON_KEY: 'sb_publishable_performance_fixture'
	}
});

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2'
};
const compress = new Set(['.html', '.json', '.js', '.css', '.svg']);
const files = new Map();

async function asset(file) {
	if (!files.has(file)) {
		const extension = extname(file);
		const compressed = compress.has(extension);
		const raw = await readFile(file);
		const body = compressed ? gzipSync(raw) : raw;
		files.set(file, {
			body, headers: {
				'content-type': contentTypes[extension] ?? 'application/octet-stream',
				'content-length': body.length,
				...(compressed ? { 'content-encoding': 'gzip' } : {})
			}
		});
	}
	return files.get(file);
}

const server = createServer(async (request, response) => {
	const { pathname } = new URL(request.url, ORIGIN);
	const path = resolve(build, '.' + pathname);
	const inside = relative(build, path);
	if (isAbsolute(inside) || inside.startsWith('..')) return response.writeHead(404).end();
	const candidates = pathname === '/addons.json' ? [snapshot] :
		pathname === '/' ? [join(build, 'index.html')] : [path, path + '.html', join(path, 'index.html')];
	for (const file of candidates) {
		try {
			const { body, headers } = await asset(file);
			return response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : body);
		} catch (error) {
			if (!['ENOENT', 'EISDIR'].includes(error.code)) {
				console.error(error);
				return response.writeHead(500).end();
			}
		}
	}
	response.writeHead(404).end();
});
server.listen(Number(new URL(ORIGIN).port), '127.0.0.1');
