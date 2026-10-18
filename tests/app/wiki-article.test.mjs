import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleLinks, repositoryUrl, readArticle } from '../../src/lib/wiki-article.ts';

test('extracts LazyPig forks and recommendation only from download sections', () => {
 const text = `== Dependencies ==
*[https://github.com/other/dependency Required]
== Git links ==
*[https://github.com/thezephyrsong/_LazyPig '''(thezephyrsong)'''] - Recommended
*[https://github.com/Otari98/_LazyPig (Otari98)]
*[https://github.com/jrc13245/_LazyPig (jrc13245)]
*[https://github.com/Otari98/_LazyPig Duplicate]
== See also ==
*[https://github.com/other/unrelated Other]`;
 const links = articleLinks(text);
 assert.equal(links.length,3);
 assert.equal(links[0].recommended,true);
 assert.equal(links[1].recommended,false);
 assert.equal(links[2].url,'https://github.com/jrc13245/_LazyPig');
});

test('rejects insecure, unsupported, profile and credential URLs', () => {
 for (const value of ['javascript:alert(1)','http://github.com/a/b','https://github.com/a','https://evil.test/a/b','https://user:pass@github.com/a/b']) assert.equal(repositoryUrl(value),null);
});

test('standalone and bold-wrapped source links work without including contributors or optional addons', () => {
 const links=articleLinks(`== Git links ==
[https://github.com/Road-block/wow-saiket/tree/_Nameplates (Road-block)]
'''[https://github.com/Otari98/AddOnOrganizer (Otari98)]'''
== Contributors ==
*[https://github.com/other/unrelated Other]
== Optional ==
[https://github.com/other/optional Optional]`);
 assert.equal(links.length,2);
 assert.equal(links[0].url,'https://github.com/Road-block/wow-saiket/tree/_Nameplates');
});

test('installation links are a fallback and never added to a curated Git list', () => {
 const install=`== How to install ==\n#Go to [https://github.com/celguar/wow-voiceover/releases/tag/1.5.0 GitHub].`;
 assert.equal(articleLinks(install)[0].url,'https://github.com/celguar/wow-voiceover/releases/tag/1.5.0');
 assert.deepEqual(articleLinks(install+'\n== Git links ==\n[https://github.com/other/curated Curated]'),[{url:'https://github.com/other/curated',recommended:false}]);
});

test('article reads request redirect resolution and return destination metadata', async t => {
 t.mock.method(globalThis,'fetch',async url=>{
  assert.equal(new URL(url).searchParams.get('redirects'),'1');
  return Response.json({parse:{title:'BigWigs',revid:23794,redirects:[{from:'Addon BigWigs',to:'BigWigs'}],wikitext:'BigWigs provides timers and alerts.\n\n== Git links ==\n*[https://github.com/prodigeomix/BigWigs Recommended] - Recommended'}});
 });
 const article=await readArticle('https://turtle-wow.fandom.com/wiki/Addon_BigWigs');
 assert.equal(article.title,'BigWigs');assert.equal(article.redirected,true);
 assert.equal(article.description,'BigWigs provides timers and alerts.');
 assert.equal(article.links[0].recommended,true);
});
