import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CATEGORIES, IMAGE_HOSTS, LINK_HOSTS } from '../../src/lib/config.ts';
import { hostAllowed } from '../../src/lib/hosts.ts';
import { creditFor, githubPlace, linkAuthor, linkKey } from '../../src/lib/links.ts';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, alice, bob, refused, call, live;
beforeEach(async () => {
	({ db, owner, admin, alice, bob, refused, call, live } = await createRulesContext());
});
afterEach(() => db.close());

describe('posting and editing', () => {
	test('a visitor can read but not post', async () => {
		await post(db, alice, addon('Atlas'));
		assert.equal((await db.asVisitor((q) => q('select name from public.addons'))).length, 1);
		await refused(() =>
			db.asVisitor((q) => q(`insert into public.addons (slug, name, versions) values ('x', 'Xx', '[]')`))
		);
	});

	test('a member can edit and delete only their own addons', async () => {
		const mine = await post(db, alice, addon('Atlas'));
		const theirs = await post(db, bob, addon('Bagnon'));

		await call(alice, `update public.addons set author = 'Maps' where id = $1`, [mine.id]);
		const touched = await call(alice, `update public.addons set author = 'Hacked' where id = $1 returning id`, [
			theirs.id
		]);
		assert.equal(touched.length, 0);
		assert.equal((await call(alice, 'delete from public.addons where id = $1 returning id', [theirs.id])).length, 0);
		assert.deepEqual(await live(), ['Atlas', 'Bagnon']);

		await call(alice, 'delete from public.addons where id = $1', [mine.id]);
		assert.deepEqual(await live(), ['Bagnon']);
	});

	test('an admin can edit and delete anyone\'s addon', async () => {
		const theirs = await post(db, alice, addon('Atlas'));
		await call(admin, `update public.addons set category = 'Map & Minimap' where id = $1`, [theirs.id]);
		await call(admin, 'delete from public.addons where id = $1', [theirs.id]);
		assert.deepEqual(await live(), []);
	});

	test('nobody can post as someone else or take over an addon', async () => {
		await refused(() => post(db, alice, { ...addon('Atlas'), owner: bob.id }));
		const mine = await post(db, alice, addon('Atlas'));
		await refused(() => call(alice, 'update public.addons set owner = $1 where id = $2', [bob.id, mine.id]));
	});

	test('the address comes from the name, whatever the poster sends', async () => {
		const slugOf = async (fields) => (await post(db, alice, fields)).slug;
		assert.equal(await slugOf(addon('Junk Entry', 'https://github.com/alice/junk', { slug: 'pfui' })), 'junk-entry');
		assert.equal(await slugOf(addon('Big Wigs!', 'https://github.com/alice/bigwigs')), 'big-wigs');
		await refused(() => slugOf(addon('Big Wigs', 'https://github.com/Bob/BigWigs')), /already exists/);
		// An address that still leads to an addon merged into another cannot be taken.
		await db.sql(`update public.addons set aliases = '{old-name}' where slug = 'big-wigs'`);
		assert.equal(await slugOf(addon('Old Name', 'https://github.com/dave/old')), 'old-name-dave');
		await refused(() => call(alice, `update public.addons set slug = 'pfui' where slug = 'junk-entry'`));
	});

	test('same-name submissions share one page and address', async () => {
 const first = await post(db,alice,addon('Atlas'));
 const [{id}] = await call(bob,'select public.submit_addon($1::jsonb) as id',[JSON.stringify({name:'Atlas',versions:[{url:'https://github.com/bob/Atlas'}]})]);
 assert.equal(id,first.id);
 assert.deepEqual(await live(),['Atlas']);
 });

	test('a member needs a description of 15 characters; an admin does not', async () => {
		await refused(() => post(db, alice, addon('Atlas', undefined, { description: 'Too short' })), /15 characters/);
		await post(db, admin, addon('Atlas', undefined, { description: 'Maps' }));
		assert.deepEqual(await live(), ['Atlas']);
	});

	test('an addon cannot be posted without a category', async () => {
		const { category, ...rest } = addon('Atlas');
		await refused(() => post(db, alice, rest));
		await refused(() => post(db, admin, { ...rest, category: '' }));
		await post(db, alice, { ...rest, category });
	});

	test('the category is one from the site\'s list, for admins too', async () => {
		await refused(() => post(db, alice, addon('Atlas', undefined, { category: 'Cheats' })));
		await refused(() => post(db, admin, addon('Atlas', undefined, { category: 'x'.repeat(5000) })));
		// Every category the site offers is one the database accepts.
		for (const [i, category] of CATEGORIES.entries()) await post(db, admin, addon(`Addon${i}`, undefined, { category }));
	});

	test('the name is tidied, and cannot be blank', async () => {
		const row = await post(db, alice, addon('Atlas', undefined, { name: '  Big\n\tWigs  ', author: ' Some\nOne ' }));
		assert.deepEqual([row.name, row.author], ['Big Wigs', 'Some One']);
		await refused(() => post(db, alice, addon('Blank', undefined, { name: '      ' })));
		await refused(() => call(alice, `update public.addons set name = E' \n ' where id = $1`, [row.id]));
	});

});

describe('links and versions', () => {
	test('different spellings of one repository count as the same link', async () => {
		const key = async (url) => (await db.sql('select public.link_key($1) as k', [url]))[0].k;
		assert.equal(await key('https://github.com/Shagu/pfQuest'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://github.com/shagu/pfQuest.git'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://www.github.com/shagu/pfQuest/tree/master'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://gitlab.com/group/sub/addon/-/tree/main'), 'gitlab.com/group/sub/addon');
	});

	test('a folder of a repository is a link of its own, whichever branch it is read from', async () => {
		const key = async (url) => (await db.sql('select public.link_key($1) as k', [url]))[0].k;
		const atlas = 'github.com/someone/collection/a/atlas';
		assert.equal(await key('https://github.com/Someone/Collection/tree/master/a/Atlas'), atlas);
		assert.equal(await key('https://github.com/someone/collection/tree/main/a/Atlas/'), atlas);
		assert.equal(await key('https://github.com/someone/collection/blob/238c6d6/a/Atlas?tab=readme'), atlas);
		// A branch alone is still the repository.
		assert.equal(await key('https://github.com/someone/collection/tree/vanilla'), 'github.com/someone/collection');

		await post(db, alice, addon('Atlas', 'https://github.com/someone/collection/tree/master/a/Atlas'));
		await post(db, bob, addon('Bagnon', 'https://github.com/someone/collection/tree/master/b/Bagnon'));
		await post(db, bob, addon('Whole collection', 'https://github.com/someone/collection'));
		await refused(
			() => post(db, bob, addon('Atlas again', 'https://github.com/someone/collection/tree/main/a/atlas')),
			/already listed under "Atlas"/
		);
	});

	test('the site and the database make the same key from a link', async () => {
		const links = [
			'https://github.com/Shagu/pfQuest',
			'https://github.com/shagu/pfQuest.git',
			'http://www.github.com/shagu/pfQuest/',
			'https://github.com/shagu/pfQuest?tab=readme-ov-file#install',
			'https://github.com/shagu/pfQuest/tree/master',
			'https://github.com/shagu/pfQuest/tree/master/',
			'https://github.com/shagu/pfQuest/releases/download/v1/pfQuest.zip',
			'https://github.com/shagu/pfQuest/archive/refs/heads/master.zip',
			'https://github.com/shagu/pfQuest/issues/12',
			'https://github.com/ericraio/vanilla-wow-addons/tree/238c6d633d5a5b8a0cc4ee7a8cbb548ea80da081/p/Parchment',
			'https://github.com/xVitali2/Addons-for-Vanilla-1.12.1/tree/master/BGAssistRU',
			'https://github.com/laytya/Vanilla-Addons/blob/master/Cryolysis.zip',
			'https://github.com/Arthur-Helias/BetterCharacterPanel/tree/main?tab=readme-ov-file',
			'https://github.com/someone/collection/tree/feature/x/Addon//',
			'https://github.com/someone/collection/tree/',
			'https://github.com/someone',
			'  https://github.com/Someone/Addon  ',
			'https://gitlab.com/group/sub/addon/-/tree/main',
			'https://gitlab.com/group/addon.git',
			'https://codeberg.org/someone/addon/',
			'https://example.com/addons/thing.zip?download=1',
			'https://legacy-wow.com/vanilla-addons/atlas/#comments'
		];
		for (const url of links) {
			const [{ k }] = await db.sql('select public.link_key($1) as k', [url]);
			assert.equal(linkKey(url), k, url);
		}
	});

	test('the site and the database read the same owner from a link, on every site that names one', async () => {
		const owners = {
			'https://github.com/Shagu/pfQuest': 'Shagu',
			'http://www.github.com/shagu/pfQuest.git': 'shagu',
			'https://github.com/laytya/Vanilla-Addons/blob/master/Cryolysis.zip': 'laytya',
			'  https://github.com/Someone/Addon  ': 'Someone',
			'https://github.com/someone': '',
			'https://gitlab.com/Artur91425/Automaton': 'Artur91425',
			'https://gitlab.com/group/sub/addon/-/tree/main': 'group',
			'https://GitLab.com/aead/aBindings?ref=x#top': 'aead',
			'https://codeberg.org/someone/addon/': 'someone',
			'https://bitbucket.org/Team/addon/src/master/': '',
			'https://gitea.com/someone/addon': 'someone',
			'https://octowow.st/git/ShempError/BulwarkFrame': 'ShempError',
			'https://octowow.st/git/ShempError': '',
			'https://octowow.st/forum/someone/thread': '',
			'https://sourceforge.net/projects/thing/files': '',
			'https://example.com/addons/thing.zip?download=1': '',
			'gitlab.com/owner/addon': 'owner',
			'not a link': '',
			'': ''
		};
		for (const [url, owner] of Object.entries(owners)) {
			assert.equal(linkAuthor(url), owner, url);
			assert.equal((await db.sql('select public.link_author($1) as a', [url]))[0].a, owner, url);
		}
	});

	test('where on GitHub a link points: repository, branch and folder, as the link spells them', () => {
		const place = (url) => githubPlace(url) && Object.values(githubPlace(url)).join(' | ');
		assert.equal(place('https://github.com/Lanrutcon/ABreathBeneath'), 'Lanrutcon | ABreathBeneath |  | ');
		assert.equal(place('https://github.com/Lanrutcon/ABreathBeneath/tree/Vanilla-Port'), 'Lanrutcon | ABreathBeneath | Vanilla-Port | ');
		assert.equal(place('https://www.github.com/Owner/Repo.git'), 'Owner | Repo |  | ');
		assert.equal(place('https://github.com/Owner/Collection/tree/master/Addons/Atlas/?tab=readme#top'), 'Owner | Collection | master | Addons/Atlas');
		assert.equal(place('https://github.com/Owner/Repo/blob/main/My%20Addon/Addon.zip'), 'Owner | Repo | main | My Addon/Addon.zip');
		assert.equal(place('https://github.com/Owner/Repo/issues/3'), 'Owner | Repo |  | ');
		assert.equal(place('https://gitlab.com/Owner/Repo/-/tree/main'), null);
	});

	test('a link that is already listed is refused, however it is spelled', async () => {
		await post(db, alice, addon('pfQuest', 'https://github.com/shagu/pfQuest'));
		await refused(
			() => post(db, bob, addon('pfQuest copy', 'https://github.com/Shagu/pfquest.git')),
			/already listed under "pfQuest"/
		);
	});

	test('a link keeps its address and note only, and links and screenshots have a length limit', async () => {
		const versions = JSON.stringify([
			{ url: 'https://github.com/a/atlas', note: 'main', added_by: 'owner', junk: 'x'.repeat(10000) },
			{ url: 'https://gitlab.com/a/atlas' }
		]);
		const row = await post(db, admin, addon('Atlas', undefined, { versions }));
		assert.deepEqual(row.versions, [
			{ url: 'https://github.com/a/atlas', note: 'main' },
			{ url: 'https://gitlab.com/a/atlas', note: '' }
		]);

		const long = (length) => `https://example.com/${'a'.repeat(length)}`;
		await refused(() => post(db, alice, addon('Long', long(300))), /at most 300/);
		await refused(() => post(db, alice, addon('Shots', undefined, { images: `{${long(500)}}` })), /at most 500/);
		await post(db, admin, addon('Shots', undefined, { images: `{${long(200)}}` }));
	});

	test('a member\'s link and screenshots must be on a known site; an admin is not held to that', async () => {
		const shots = (...urls) => ({ images: `{${urls.join(',')}}` });
		await refused(() => post(db, alice, addon('Own site', 'https://my-own-site.example/addon.zip')), /The link must be on one of these sites: github\.com/);
		await refused(() => post(db, alice, addon('Tracker', undefined, shots('https://my-own-site.example/pixel.png'))), /Screenshots must be kept on one of these sites/);
		// Dressed up as GitHub: the site is the part before the first slash, and nothing else.
		await refused(() => post(db, alice, addon('Trick1', 'https://github.com@evil.example/a/b')), /must be on one of these sites/);
		await refused(() => post(db, alice, addon('Trick2', 'https://github.com.evil.example/a/b')), /must be on one of these sites/);
		await refused(() => post(db, alice, addon('Trick3', 'https://evil.example/github.com/a/b')), /must be on one of these sites/);

		// One part of a site can be allowed without the rest of it.
		await post(db, alice, addon('Octo', 'https://octowow.st/git/Ade/AdeAlts'));
		await refused(() => post(db, alice, addon('Octo2', 'https://octowow.st/forum/thread/1')), /must be on one of these sites/);
		await refused(() => post(db, alice, addon('Octo3', 'https://octowow.st/git/../forum/thread/1')), /must be on one of these sites/);
		// GitHub serves many pictures from addresses with no ending; the site is what counts.
		await post(db, alice, addon('Shot', undefined, shots('https://github.com/user-attachments/assets/140e2cf7', 'https://camo.githubusercontent.com/abc/def')));

		const mine = await post(db, alice, addon('Mine', 'https://codeberg.org/alice/mine', shots('https://raw.githubusercontent.com/a/b/main/shot.png', 'https://i.imgur.com/abc.png')));
		// An admin lists one kept elsewhere, and can give any addon a link or picture from anywhere.
		const theirs = await post(db, admin, addon('Elsewhere', 'https://octowow.st/addon', shots('https://static.example/shot.png')));
		await call(admin, `update public.addons set images = '{https://static.example/other.png}' where id = $1`, [mine.id]);

		// What an addon already has stays when a member edits it; only something new is checked.
		await call(alice, `update public.addons set description = 'Edited, with the picture an admin gave it.' where id = $1`, [mine.id]);
		await refused(
			() => call(alice, `update public.addons set images = '{https://static.example/other.png,https://static.example/new.png}' where id = $1`, [mine.id]),
			/Screenshots must be kept/
		);
		await refused(() => call(alice, `update public.addons set versions = $1 where id = $2`, [JSON.stringify([{ url: 'https://my-own-site.example/a', note: '' }]), mine.id]), /The link must be/);
		assert.equal((await db.sql('select repo_url from public.addons where id = $1', [theirs.id]))[0].repo_url, 'https://octowow.st/addon');
	});

	test('the site and the database agree on which sites are allowed', async () => {
		for (const [kind, list] of [['link', LINK_HOSTS], ['image', IMAGE_HOSTS]]) {
			assert.deepEqual((await db.sql('select public.allowed_hosts($1) as hosts', [kind]))[0].hosts, list);
		}
		const samples = [
			'https://github.com/a/b',
			'https://www.GitHub.com/a/b',
			'https://github.com:443/a/b',
			'https://github.com',
			'https://gist.github.com/a/b',
			'https://raw.githubusercontent.com/a/b/main/x.png',
			'https://githubusercontent.com/a.png',
			'https://evilgithubusercontent.com/a.png',
			'https://i.imgur.com/a.png',
			'https://github.com@evil.example/a',
			'https://github.com:443@evil.example/a',
			'https://evil.example\\@github.com/a',
			'https://github.com\\.evil.example/a',
			'https://github.com.evil.example/a',
			'https://evil.example/?https://github.com/a',
			'https://evil.example#github.com',
			'http://github.com/a/b',
			'https://git.sr.ht/~someone/addon',
			'https://octowow.st/git/Ade/AdeAlts',
			'https://octowow.st/git',
			'https://octowow.st/git/',
			'https://octowow.st/gitea/x',
			'https://octowow.st/',
			'https://octowow.st/forum/git/x',
			'https://octowow.st/git/../forum',
			'https://octowow.st/git/%2E%2e/forum',
			'https://octowow.st/Git/x',
			'https://www.octowow.st/git/x?tab=readme#top',
			'https://i.imgur.com/a.PNG',
			'https://i.imgur.com/a.png?x=1#y',
			'https://i.imgur.com/a.png.exe',
			'https://i.imgur.com/a',
			'https://i.imgur.com/a.',
			'https://i.imgur.com/a.jpeg',
			'https://i.imgur.com/a.svg',
			'https://i.imgur.com/page?file=a.png',
			'github.com/a/b',
			''
		];
		for (const kind of ['link', 'image']) {
			for (const url of samples) {
				const [{ ok }] = await db.sql('select public.host_allowed($1, $2) as ok', [url, kind]);
				assert.equal(ok, hostAllowed(url, kind), `${kind}: ${url}`);
			}
		}
		assert.equal(hostAllowed('https://octowow.st/git/Ade/AdeAlts', 'link'), true);
		assert.equal(hostAllowed('https://octowow.st/git/../forum', 'link'), false);
		assert.equal(hostAllowed('https://octowow.st/forum/git/x', 'link'), false);
	});

	test('the first version is the main link', async () => {
		const versions = JSON.stringify([
			{ url: 'https://github.com/brues-code/pfUI', note: 'maintained' },
			{ url: 'https://github.com/shagu/pfUI', note: 'original' }
		]);
		const row = await post(db, admin, { ...addon('pfUI'), versions });
		assert.equal(row.repo_url, 'https://github.com/brues-code/pfUI');
		assert.deepEqual(row.link_keys.sort(), ['github.com/brues-code/pfui', 'github.com/shagu/pfui']);
	});

	test('a second link makes a page admin-managed, while members can submit links by name', async () => {
 const row = await post(db,alice,addon('Mine'));
 const links = [{url:row.repo_url,note:''},{url:'https://github.com/another/Mine',note:''}];
 await refused(()=>call(alice,'update public.addons set versions = $1 where id = $2',[JSON.stringify(links),row.id]),/Only an admin/);
 await call(admin,'update public.addons set versions = $1 where id = $2',[JSON.stringify(links),row.id]);
 assert.deepEqual(await call(alice,'update public.addons set author = $1 where id = $2 returning id',['wrong',row.id]),[]);
 await call(bob,'select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Mine',versions:[{url:'https://github.com/bob/Mine'}]})]);
 assert.equal((await db.sql('select jsonb_array_length(versions) as n from public.addons'))[0].n,2);
 const [request] = await db.sql("select id from public.addon_link_requests where status='pending'");
 await call(admin,'select public.decide_addon_link($1,true)',[request.id]);
 assert.equal((await db.sql('select jsonb_array_length(versions) as n from public.addons'))[0].n,3);
 });

	test('links must be https, and an addon needs at least one', async () => {
		await refused(() => post(db, alice, { ...addon('A1'), versions: '[]' }), /between 1 and 100 links/);
		await refused(() => post(db, alice, addon('A2', 'http://example.com/a')), /https/);
	});

});

test('shared catalog credit follows the leading link rather than inherited author text', () => {
 const entry={author:'rivi-s',repo_url:'https://octowow.st/git/lightblade/pfQuest-turtle'};
 assert.equal(creditFor({...entry,shared:true}),'lightblade');
 assert.equal(creditFor({...entry,shared:false}),'rivi-s');
});

test('renaming changes the address and keeps every previous address reserved', async () => {
 const row=await post(db,alice,addon('Atlas'));
 const rename=async name=>(await call(alice,'update public.addons set name=$1 where id=$2 returning slug,aliases',[name,row.id]))[0];
 assert.deepEqual(await rename('Atlas Maps'),{slug:'atlas-maps',aliases:['atlas']});
 assert.deepEqual(await rename('Atlas World'),{slug:'atlas-world',aliases:['atlas','atlas-maps']});
 assert.deepEqual(await rename('Atlas'),{slug:'atlas',aliases:['atlas-maps','atlas-world']});
 assert.deepEqual(await rename('ATLAS!'),{slug:'atlas',aliases:['atlas-maps','atlas-world']});
 const other=await post(db,bob,addon('Atlas Maps','https://github.com/bob/Maps'));
 assert.equal(other.slug,'atlas-maps-bob');
 await refused(()=>rename('Atlas Maps'),/already exists/);
});

test('renaming to a reserved address picks a free address without stealing an old link', async () => {
 const first=await post(db,alice,addon('First'));
 await call(alice,'update public.addons set name=$1 where id=$2',['Second',first.id]);
 const other=await post(db,bob,addon('Other','https://github.com/bob/Other'));
 const [renamed]=await call(bob,'update public.addons set name=$1 where id=$2 returning slug,aliases',['First',other.id]);
 assert.equal(renamed.slug,'first-bob'); assert.deepEqual(renamed.aliases,['other']);
 const [holder]=await db.asVisitor(q=>q("select id from public.addons where 'first'=any(aliases)"));
 assert.equal(holder.id,first.id);
});
