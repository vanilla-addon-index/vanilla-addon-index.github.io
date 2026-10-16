import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishedForkParent} from '../src/lib/import-review.ts';
const addon = (id,name,url) => ({id,name,versions:[{url}]});
test('fork grouping follows the published parent link regardless of name',()=>{
 const parent=addon(1,'Original UI','https://github.com/Owner/Original.git');
 assert.equal(publishedForkParent('github.com/owner/original',[parent]),parent);
 assert.equal(publishedForkParent('https://github.com/Owner/Original/tree/main',[parent]),parent);
 assert.equal(publishedForkParent('github.com/other/Original',[parent]),undefined);
 assert.equal(publishedForkParent(null,[parent]),undefined);
 assert.equal(publishedForkParent('github.com/owner/original',[parent,addon(2,'Other page',parent.versions[0].url)]),undefined);
 assert.equal(publishedForkParent('github.com/owner/collection',[addon(3,'Folder','https://github.com/owner/collection/tree/main/Folder')]),undefined);
});
