// Real importer, offline hosts. Barriers prove overlap without timing assumptions.
const scenario = process.env.NIGHTLY_CONCURRENCY_FIXTURE;
const hosts = ['gitlab.com', 'codeberg.org', 'gitea.com'];
const calls = [];
const maximum = {};
const active = {};
let activeWrites = 0;
let maximumWrites = 0;
let refused = false;
const gates = hosts.map(() => Promise.withResolvers());
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type':'application/json', ...headers}});
const hash = 'a'.repeat(40);
const links = [
	{key:'github.com/a/addon', url:'https://github.com/a/addon', readme:true},
	...hosts.flatMap((host) => Array.from({length:4}, (_, i) => ({key:`${host}/a/addon${i}`, url:`https://${host}/a/addon${i}`, readme:true})))
];
globalThis.fetch = async (url, init = {}) => {
	if (url.includes('octowow.st/git/api/v1/repos/search')) return json({ok:true,data:[]});
	if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse:{revid:1, wikitext:'===Full Addons List===\n* [https://github.com/a/addon Addon] description\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections=='}});
	if (url.includes('/rest/v1/rpc/')) {
		const name = url.split('/').at(-1);
		const {token, ...args} = JSON.parse(init.body);
		if (name === 'nightly_links') return json(links);
		if (name === 'nightly_waiting') return json({ reports: 0, suggestions: 0, imports: 0 });
		calls.push({name, args});
		if (name.startsWith('store_')) {
			maximumWrites = Math.max(maximumWrites, ++activeWrites);
			// Keep a write outstanding while other producers finish their checks.
			await new Promise((resolve) => setImmediate(resolve));
			activeWrites--;
			if (scenario === 'store-failure' && name === 'store_repo_stats' && !refused) {
				refused = true;
				calls.at(-1).failed = true;
				return json({message:'Fixture refuses the first statistics checkpoint'}, 400);
			}
		}
		return json(0);
	}
	if (url === 'https://api.github.com/graphql') {
		const query = JSON.parse(init.body).query;
		const phase = query.includes('stargazerCount') ? 'metadata' : 'details';
		calls.push({name:'github-start', phase});
		if (scenario === 'barriers' && phase === 'metadata') await Promise.all(gates.map((gate) => gate.promise));
		calls.push({name:'github-end', phase});
		return json({data:{r0:phase === 'metadata'
			? {id:'github', nameWithOwner:'a/addon', stargazerCount:1, pushedAt:null, isArchived:false, parent:null, head:{oid:hash}}
			: {nameWithOwner:'a/addon', code:{history:{nodes:[{committedDate:'2024-01-01T00:00:00Z'}]}}, top:{oid:hash, entries:[]}}
		}});
	}
	const parsed = new URL(url);
	const host = parsed.hostname;
	if (!hosts.includes(host)) throw new Error('Unexpected fixture endpoint: ' + url);
	maximum[host] = Math.max(maximum[host] ?? 0, active[host] = (active[host] ?? 0) + 1);
	calls.push({name:'rest-start', host, url});
	try {
		const project = decodeURIComponent(parsed.pathname).match(/a\/addon(\d)/)?.[0];
		const index = Number(project?.at(-1));
		const metadata = !parsed.search && /addon\d$/.test(parsed.pathname);
		if (metadata) {
			if (scenario === 'barriers') {
				if (index === 2) gates[hosts.indexOf(host)].resolve();
				if (index === 0) await gates[hosts.indexOf(host)].promise;
			}
			if (scenario === 'rate-limit' && host === 'gitlab.com') return json({}, 429, {'retry-after':'3600'});
			return json(host === 'gitlab.com'
				? {id:index, path_with_namespace:project, default_branch:'main', star_count:2, archived:false, last_activity_at:null}
				: {id:index, full_name:project, default_branch:'main', stars_count:2, archived:false, updated_at:null}, 200, {etag:'"fixture"'});
		}
		if (parsed.pathname.endsWith('/commits')) return json(host === 'gitlab.com'
			? [{id:hash, committed_date:'2024-01-01T00:00:00Z'}]
			: [{sha:hash, commit:{committer:{date:'2024-01-01T00:00:00Z'}}}]);
		if (parsed.pathname.endsWith('/repository/tree') || parsed.pathname.includes('/contents/')) return json([]);
		throw new Error('Unexpected fixture endpoint: ' + url);
	} finally {
		active[host]--;
		calls.push({name:'rest-end', host, url});
	}
};
await import('../../scripts/nightly.mjs');
console.log('__CONCURRENCY_RESULT__' + JSON.stringify({calls, maximum, maximumWrites}));
