import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleLinks, repositoryUrl } from '../../src/lib/wiki-article.ts';

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
