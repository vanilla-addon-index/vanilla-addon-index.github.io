import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addonSearch } from '../../src/lib/addon-search.ts';
const a = {name:'SimpleAuras',description:'Tracks buffs.',author:'Example',versions:[{url:'https://github.com/example/simple'}],similar_addons:'MPOWA, WeakAuras'};
test('similar names match case and spacing without replacing ordinary descriptions', () => {
 for(const q of ['weakauras','WEAK AURAS','weak']) assert.deepEqual(addonSearch(a,q),{matches:true,hint:'WeakAuras'});
 assert.equal(addonSearch(a,'buffs weakauras').matches,true);
 assert.deepEqual(addonSearch(a,'buffs'),{matches:true,hint:''});
 assert.equal(addonSearch(a,'outfitter').matches,false);
 assert.equal(addonSearch({...a,similar_addons:undefined},'weakauras').matches,false);
 assert.deepEqual(addonSearch(a,''),{matches:true,hint:''});
});
