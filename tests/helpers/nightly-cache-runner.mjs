// Offline child-process fixture for the real importer. No endpoint reaches the network.
const options = JSON.parse(process.env.NIGHTLY_CACHE_FIXTURE);
const cache = structuredClone(options.cache ?? {});
const calls = [];
const hash = (char) => char.repeat(40);
const head = options.head ?? hash('a');
const tree = options.tree ?? hash('b');
const toc = options.toc ?? hash('c');
const readme = options.readme ?? hash('d');
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (url, init = {}) => {
	if (url.includes('octowow.st/git/api/v1/repos/search')) return json({ok:true,data:[]});
	if (url.includes('turtle-wow.fandom.com/api.php')) return json({ parse: { revid: 1, wikitext: '===Full Addons List===\n* [https://github.com/a/addon Addon] description\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==' } });
	if (url.includes('/rest/v1/rpc/')) {
		const name = url.split('/').at(-1);
		const { token, ...args } = JSON.parse(init.body);
		calls.push({ name, args });
		if (options.fail === name) return json({ message: 'Fixture store failure' }, 400);
		if (name === 'nightly_links') return json((options.links ?? [{ key: 'github.com/a/addon', url: 'https://github.com/a/addon', readme: true }]).map((link) => ({ ...link, images: options.imageFailure ? ['https://i.imgur.com/wiki.png'] : [], cache: cache[link.url] })));
		if (name === 'nightly_waiting') return json({ reports: 0, suggestions: 0, imports: 0 });
		if (name === 'prune_repo_check_cache') return json(options.pruned ?? 0);
		if (name === 'store_repo_stats' && options.writeReport) return json({accepted:args.stats.length,
			facts_written:0, facts_unchanged:args.stats.length, checks_written:args.stats.length});
		if (name === 'store_repo_check_cache') for (const item of args.items) cache[item.url] = item.state;
		return json(0);
	}
	if (url === 'https://i.imgur.com/wiki.png') return new Response('', { status: 403 });
	if (url.startsWith('https://codeberg.org/api/v1/')) {
		calls.push({name:'rest',url,headers:init.headers});
		if (url.endsWith('/repos/a/Addon')) {
			if (options.http304) return new Response(null,{status:304});
			if (options.httpMissing) return new Response(null,{status:404});
			return json({id:1,full_name:'a/Addon',default_branch:options.emptyRepo ? '' : 'main',stars_count:options.stars ?? 3,archived:false,updated_at:'2026-10-14T12:00:00Z'},200,{etag:'"repo-v1"'});
		}
		if (url.includes('/commits?')) {
			const ref = new URL(url).searchParams.get('sha');
			const branchHead = options.branchHeads?.[ref] ?? head;
			const date = new URL(url).searchParams.get('path') ? '2020-01-01T00:00:00Z' : options.dates?.[branchHead] ?? '2024-01-01T00:00:00Z';
			return json([{sha:branchHead,commit:{committer:{date}}}]);
		}
		if (url.includes('/contents/')) return json([]);
		throw new Error('Unexpected REST fixture endpoint: '+url);
	}
	if (url !== 'https://api.github.com/graphql') throw new Error('Unexpected fixture endpoint: ' + url);
	const query = JSON.parse(init.body).query;
	const phase = query.includes('stargazerCount') ? 'metadata' : query.includes('code:') || query.includes('top:') ? 'details' : query.includes('f0:') ? 'toc' : 'readme';
	calls.push({ name: phase, query });
	const data = {};
	const errors = [];
	const aliases = [...query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"/g)];
	for (const [index, match] of aliases.entries()) {
		const [,alias,owner,name] = match;
		const fragment = query.slice(match.index, aliases[index+1]?.index ?? query.length);
		let value;
		if (phase === 'metadata') value = {
			id: options.identity ?? 'repo-' + owner.toLowerCase() + '/' + name.toLowerCase(),
			nameWithOwner: options.canonical ?? owner.toLowerCase() + '/' + name.toLowerCase(), stargazerCount: options.stars ?? 3,
			pushedAt: '2026-01-01T00:00:00Z', isArchived: Boolean(options.archived), parent: null,
			head: options.fail === 'head' ? null : { oid: head }
		};
		if (phase === 'metadata') for (const [,field,expression] of fragment.matchAll(/(head\d*): object\(expression: ("(?:[^"\\]|\\.)*")\)/g)) {
			const ref = JSON.parse(expression);
			value[field] = options.fail === 'head' ? null : {oid:options.branchHeads?.[ref] ?? head};
		}
		if (phase === 'metadata' && (options.missing || options.fail === 'metadata')) {
			value = null;
			errors.push({ type: options.missing ? 'NOT_FOUND' : 'INTERNAL', path: [alias] });
		}
		if (phase === 'details') {
			const path = JSON.parse(/history\(first: 1, path: ("(?:[^"\\]|\\.)*")/.exec(fragment)?.[1] ?? '""');
			const commit = JSON.parse(/code: object\(expression: ("(?:[^"\\]|\\.)*")/.exec(fragment)?.[1] ?? '""');
			value = { nameWithOwner: options.canonical ?? owner.toLowerCase() + '/' + name.toLowerCase(),
				code: { history: { nodes: [{ committedDate: options.pathDates?.[path] ?? options.dates?.[commit] ?? options.date ?? '2024-01-01T00:00:00Z' }] } },
				top: options.empty ? { oid: tree, entries: [] } : { oid: tree, entries: [
					{ name: 'Addon.toc', type: 'blob', oid: toc }, { name: 'README.md', type: 'blob', oid: readme }
				] }
			};
			for (const [failure, field] of [['history', 'code'], ['directory', 'top']]) if (options.fail === failure) {
				value[field] = null; errors.push({ type: 'INTERNAL', path: [alias, field] });
			}
		}
		if (phase === 'toc') {
			value = {};
			for (const [, index] of query.matchAll(/f(\d+):/g)) value['f' + index] = { oid: toc, text: '## Interface: ' + (options.interface ?? 11200) };
			if (options.fail === 'toc') { value.f0 = null; errors.push({ type: 'INTERNAL', path: [alias, 'f0'] }); }
		}
		if (phase === 'readme') {
			value = { readme: { oid: readme, text: 'No screenshots.' } };
			if (options.fail === 'readme') { value.readme = null; errors.push({ type: 'INTERNAL', path: [alias, 'readme'] }); }
		}
		data[alias] = value;
	}
	return json({ data, errors });
};
await import('../../scripts/nightly.mjs');
console.log('__CACHE_RESULT__' + JSON.stringify({ cache, calls }));
