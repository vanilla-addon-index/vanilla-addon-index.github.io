import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositoryName } from '../../src/lib/repository-name.ts';

test('repository names follow supported host and folder URL structures', () => {
 for (const [url,name] of [
  ['https://github.com/author/MyAddon','MyAddon'],
  ['https://www.github.com/author/MyAddon.git/?tab=readme#readme','MyAddon'],
  ['https://github.com/author/Pack/tree/main/AddOns/QuestHelper','QuestHelper'],
  ['https://github.com/author/Pack/blob/main/AddOns/QuestHelper/QuestHelper.toc','QuestHelper'],
  ['https://github.com/author/MyAddon/tree/main','MyAddon'],
  ['https://gitlab.com/team/subteam/MyAddon','MyAddon'],
  ['https://gitlab.com/team/subteam/MyAddon/-/tree/main','MyAddon'],
  ['https://codeberg.org/author/MyAddon.git','MyAddon'],
  ['https://gitea.com/author/MyAddon/src/branch/main','MyAddon'],
  ['https://octowow.st/git/lightblade/pfQuest-turtle','pfQuest-turtle']
 ]) assert.equal(repositoryName(url),name,url);
});

test('invalid, unsupported and incomplete links do not suggest a name', () => {
 for (const url of ['', 'test', 'http://github.com/author/Addon', 'https://github.com/author',
  'https://example.com/author/Addon', 'https://octowow.st/author/Addon',
  'https://github.com@evil.com/author/Addon', 'https://github.com/author/%zz',
  'https://github.com/author/a%2Fb', 'https://github.com/author/'+'a'.repeat(61)])
  assert.equal(repositoryName(url),'',url);
});
