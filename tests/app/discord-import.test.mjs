import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { discordMessages, readDiscordExport } from '../../src/lib/discord-import.ts';
import { linkAuthor } from '../../src/lib/links.ts';

const opener = {id:'123',channel_id:'123',content:'An addon! https://github.com/Author/Addon/releases/latest/download/addon.zip https://example.com/no'};
test('Discord imports only verified opening posts and deduplicates supported repositories', () => {
 const reply = {id:'124',channel_id:'123',content:'https://github.com/other/reply'};
 assert.equal(discordMessages([reply]), null);
 assert.deepEqual(discordMessages([reply, opener]).map(i => i.url), ['https://github.com/Author/Addon']);
 assert.equal(discordMessages({channel:{id:'123'},messages:[{...opener,channel_id:undefined}]}).length,1);
 const archive = zipSync({'one.json':strToU8(JSON.stringify([reply,opener])), 'two.json':strToU8(JSON.stringify([opener])), 'missing.json':strToU8(JSON.stringify([reply])), 'README.html':strToU8('ignored')});
 const preview = readDiscordExport('export.zip',archive);
 assert.equal(preview.items.length,1);
 assert.equal(preview.starters,2);
 assert.equal(preview.skipped,1);
 assert.equal(preview.items[0].description,opener.content);
 assert.throws(() => readDiscordExport('bad.json',strToU8('{}')),/Nothing was imported/);
 assert.throws(() => readDiscordExport('bad.zip',zipSync({'bad.json':strToU8('oops')})),/Nothing was imported/);
});

test('only the first supported Git link is selected; later links, attachments and embeds are ignored', () => {
 const content = [
  'https://github.com/a/Addon https://github.com/a/Addon/releases/latest',
  'https://gitlab.com/a/Other https://codeberg.org/a/Third',
  'https://gitea.com/a/Fourth https://octowow.st/git/a/Fifth',
  'https://octowow.st/git/a https://github.com/a',
  'https://github.com.evil.example/a/no https://example.com/a/no'
 ].join('\n');
 const found = discordMessages([{...opener,content,embeds:[{url:'https://github.com/a/Embed'}],attachments:[{url:'https://github.com/a/Attachment'}]}]);
 assert.equal(found.length,1);
 assert.deepEqual(found.map(i=>i.name),['Addon']);
});

test('Aegis Exchange uses its primary repository identity rather than its dependency', () => {
 const url = 'https://github.com/Torchlite-bit/Aegis_Exchange.git';
 const content = `Get it here: ${url}\nScans fastest with https://github.com/brues-code/AuctionQueryThrottle.git\nDownload or clone: ${url}`;
 const [found, extra] = discordMessages([{...opener,content}]);
 assert.equal(found.url,url);
 assert.equal(found.name,'Aegis_Exchange');
 assert.equal(linkAuthor(found.url),'Torchlite-bit');
 assert.equal(extra,undefined);
});

test('unsupported and incomplete links are skipped before choosing the first repository', () => {
 for (const url of ['https://gitlab.com/a/Other','https://codeberg.org/a/Third','https://gitea.com/a/Fourth','https://octowow.st/git/a/Fifth']) {
  const [found] = discordMessages([{...opener,content:`https://example.com/a/b https://github.com/a https://octowow.st/git/a ${url} https://github.com/a/Dependency`}]);
  assert.equal(found.url,url);
 }
});
