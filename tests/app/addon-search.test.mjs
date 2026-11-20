import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addonSearch, matchesAddonSearch, prepareAddonQuery, prepareAddonSearch } from '../../src/lib/addon-search.ts';
const a = {name:'SimpleAuras',description:'Tracks buffs.',author:'Example',versions:[{url:'https://github.com/example/simple'}],similar_addons:'MPOWA, WeakAuras'};
test('similar names match case and spacing without replacing ordinary descriptions', () => {
 for(const q of ['weakauras','WEAK AURAS','weak']) assert.deepEqual(addonSearch(a,q),{matches:true,hint:'WeakAuras'});
 assert.equal(addonSearch(a,'buffs weakauras').matches,true);
 assert.deepEqual(addonSearch(a,'buffs'),{matches:true,hint:''});
 assert.equal(addonSearch(a,'outfitter').matches,false);
 assert.equal(addonSearch({...a,similar_addons:undefined},'weakauras').matches,false);
 assert.deepEqual(addonSearch(a,''),{matches:true,hint:''});
});

test('prepared queries match across descriptions, authors, links and similar names', () => {
 const addon = prepareAddonSearch(a);
 for (const value of ['BUFFS  example', 'example github.com', 'buffs WeakAuras', 'WEAK-AURAS', '  ']) {
  assert.equal(matchesAddonSearch(addon, prepareAddonQuery(value)), true, value);
 }
 for (const value of ['buffs outfitter', 'buffs weak-auras', '.unknown']) {
  assert.equal(matchesAddonSearch(addon, prepareAddonQuery(value)), false, value);
 }
 assert.deepEqual(addonSearch(a, 'buffs weak'), { matches: true, hint: 'WeakAuras' });
});
