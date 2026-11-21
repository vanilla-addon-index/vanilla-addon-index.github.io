import { execFileSync } from 'node:child_process';
import type { Locator } from '@playwright/test';
import { test, expect } from './test';
import { loginAs, unique } from './helpers';

test('wiki download links appear as ordinary import cards and group through normal approvals', async ({ page }) => {
	const name=unique('WikiLinks').replace(/\W/g,'');
	execFileSync('docker',['exec','-i','supabase_db_vanilla-addon-index','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:`insert into public.import_queue(key,url,name,description) values('turtle-wow.fandom.com/wiki/${name.toLowerCase()}','https://turtle-wow.fandom.com/wiki/${name}','Old${name}','Old listing description.');`,encoding:'utf8'});
	await page.route('https://turtle-wow.fandom.com/api.php?*',route=>route.fulfill({json:{parse:{title:name,redirects:[{from:'Old'+name,to:name}],revid:123,wikitext:`Automates repetitive interactions.\n\n== Git links ==\n[https://github.com/wiki-first/${name} First]\n'''[https://github.com/wiki-second/${name} Second]'''\n*[https://github.com/wiki-recommended/${name} Third] - Recommended`}}}));
	// The main admin account can reach its hourly edit limit in the full suite.
	await loginAs(page,'admin2');
	await page.goto('/admin/import');
	await page.getByLabel('Search',{exact:true}).fill(name);
	await expect(page.locator('[data-entry]')).toHaveCount(3);
	await expect(page.getByRole('button',{name:'Review wiki links',exact:true})).toHaveCount(0);
	const row = (host: string) => page.locator('[data-entry]').filter({
		has: page.locator('a[href="https://github.com/' + host + '/' + name + '"]')
	});
	const expand = async (entry: Locator) => {
		const toggle = entry.locator('button[data-act="review"]');
		if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
	};
	const recommended = row('wiki-recommended');
	await expand(recommended);
	await expect(recommended.getByText('Wiki recommended · pins on approval', { exact: false })).toBeVisible();
	const first = row('wiki-first');
	await expand(first);
	await first.getByLabel('Category',{exact:true}).selectOption('Miscellaneous');
	await first.getByRole('button',{name:'Approve',exact:true}).click();
	await expect(page.locator('[data-entry]')).toHaveCount(2);
	const second = row('wiki-second');
	await expand(second);
	await second.getByRole('button',{name:`Add link to ${name}`,exact:true}).click();
	await expect(page.locator('[data-entry]')).toHaveCount(1);
	await expand(recommended);
	await recommended.getByRole('button',{name:`Add link to ${name}`,exact:true}).click();
	await expect(page.locator('[data-entry]')).toHaveCount(0);
	await page.goto(`/addon/${name.toLowerCase()}`);
	await expect(page.getByRole('heading',{level:1,name})).toBeVisible();
	await expect(page.getByRole('link',{name:`https://github.com/wiki-recommended/${name}`,exact:true})).toBeVisible();
});

test('unreadable articles remain visible with a paste fallback',async({page})=>{
	await page.route('https://turtle-wow.fandom.com/api.php?*',route=>route.fulfill({status:403,body:'Unavailable'}));
	await loginAs(page,'admin');
	await page.route(/\/rest\/v1\/(?:import_queue|pending_imports)\?/,async route=>{
		const url=new URL(route.request().url());
		if(route.request().method()!=='GET'||url.searchParams.get('status')!=='eq.pending') return route.continue();
		await route.fulfill({json:[{id:99999,key:'turtle-wow.fandom.com/wiki/lazypig',url:'https://turtle-wow.fandom.com/wiki/LazyPig',name:'LazyPig',description:'An addon for lazy people.',category:'',images:[],alts:[],status:'pending',problem:null}]});
	});
	await page.goto('/admin/import');
	await expect(page.getByRole('button',{name:'Retry reading wiki'})).toBeVisible();
	await expect(page.getByLabel('Paste repository links or wiki source')).toBeHidden();
	await expect(page.getByLabel('Category', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Author', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /Open wiki article/ })).toHaveAttribute('href', 'https://turtle-wow.fandom.com/wiki/LazyPig');
	const paste = page.getByRole('button', { name: 'Paste links manually' });
	await paste.click();
	await expect(paste).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByLabel('Paste repository links or wiki source')).toBeVisible();
	await expect(page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
});
