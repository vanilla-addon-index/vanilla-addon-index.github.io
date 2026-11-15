import { forgePlace, forgeReadme, type Ask } from '../../../src/lib/forges.ts';
import { imagesIn } from '../../../src/lib/github.ts';

const headers = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
};

const json = (body: object, status = 200) => Response.json(body, { status, headers });

Deno.serve(async (request) => {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
	if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

	const authorization = request.headers.get('Authorization');
	if (!authorization?.startsWith('Bearer ')) return json({ error: 'Log in first.' }, 401);
	const signal = AbortSignal.timeout(4500);
	try {
		const session = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
			headers: { authorization, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
			signal
		});
		if (!session.ok) return json({ error: 'Log in first.' }, 401);

		const { url } = await request.json().catch(() => ({})) ?? {};
		const place = typeof url === 'string' && url.length <= 500 ? forgePlace(url) : null;
		if (place?.host !== 'octowow.st') return json({ error: 'Use an OctoWoW Git repository link.' }, 400);

		const ask: Ask = async (address, as) => {
			const endpoint = new URL(address);
			if (endpoint.origin !== 'https://octowow.st' || !endpoint.pathname.startsWith('/git/api/v1/repos/')) return null;
			const response = await fetch(endpoint, { signal, redirect: 'error' });
			return {
				status: response.status,
				body: response.ok ? await (as === 'json' ? response.json() : response.text()) : undefined
			};
		};
		const readme = await forgeReadme(place, ask);
		if (readme === undefined) return json({ error: 'Could not read the OctoWoW README.' }, 502);
		return json({ images: readme ? imagesIn(readme.text, readme.base) : [] });
	} catch {
		return json({ error: 'Could not read the OctoWoW README.' }, 502);
	}
});
