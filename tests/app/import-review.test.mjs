import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishedForkParent,similarAddon,isWikiPage} from '../../src/lib/import-review.ts';
const addon = (id,name,url) => ({id,name,versions:[{url}]});

test('wiki review uses the actual wiki host and page path', () => {
	for (const url of ['https://turtle-wow.fandom.com/wiki/Addon_BigWigs', 'https://www.turtle-wow.fandom.com/wiki/SuperMacro?x=1#download']) assert.equal(isWikiPage(url), true, url);
	for (const url of ['https://github.com/a/addon/wiki/Install', 'https://turtle-wow.fandom.com.evil.test/wiki/Addon', 'https://evil.test/wiki/Addon?site=turtle-wow.fandom.com', 'https://turtle-wow.fandom.com/api.php', 'invalid']) assert.equal(isWikiPage(url), false, url);
});
test('fork grouping follows the published parent link regardless of name',()=>{
 const parent=addon(1,'Original UI','https://github.com/Owner/Original.git');
 assert.equal(publishedForkParent('github.com/owner/original',[parent]),parent);
 assert.equal(publishedForkParent('https://github.com/Owner/Original/tree/main',[parent]),parent);
 assert.equal(publishedForkParent('github.com/other/Original',[parent]),undefined);
 assert.equal(publishedForkParent(null,[parent]),undefined);
 assert.equal(publishedForkParent('github.com/owner/original',[parent,addon(2,'Other page',parent.versions[0].url)]),undefined);
 assert.equal(publishedForkParent('github.com/owner/collection',[addon(3,'Folder','https://github.com/owner/collection/tree/main/Folder')]),undefined);
});

test('similar-name suggestions recognize short addon names at word boundaries',()=>{
 const aux=addon(1,'Aux','https://github.com/a/aux');
 assert.equal(similarAddon('Aux-Revamped-Opaque',[aux]),aux);
 assert.equal(similarAddon('AUX revamped',[aux]),aux);
 assert.equal(similarAddon('Auxiliary',[aux]),undefined);
 assert.equal(similarAddon('Faux',[aux]),undefined);
 assert.equal(similarAddon('Aux',[aux]),undefined);
 const longer=addon(2,'Aux Revamped','https://github.com/b/aux');
 assert.equal(similarAddon('Aux-Revamped-Opaque',[aux,longer]),longer);
 assert.equal(similarAddon('Aux-Revamped-Opaque',[aux,{...aux,id:3}]),undefined);
 assert.equal(similarAddon('MyUI addon',[addon(4,'UI','https://github.com/a/ui')]),undefined);
});
