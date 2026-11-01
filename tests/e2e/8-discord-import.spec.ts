import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';
import { zipSync, strToU8 } from 'fflate';

test('owner uploads opening posts into the shared review queue; admin cannot upload', async ({page: adminPage,browser}) => {
 const context = await browser.newContext({baseURL:'http://localhost:5174'});
 const page = await context.newPage();
 await loginAs(adminPage,'admin');
 await adminPage.goto('/admin/import');
 await expect(adminPage.getByText('Import Discord',{exact:true})).toHaveCount(0);
 await loginAs(page,'owner');
 await page.goto('/admin/import');
 await expect(page.getByText('Import Discord',{exact:true})).toBeVisible();
 const name = `DiscordOpeningAddon${Date.now()}`;
 const messages = JSON.stringify([
  {id:'900',channel_id:'900',content:`Discord opener description https://github.com/discord-fixture/${name}`},
  {id:'901',channel_id:'900',content:'https://github.com/discord-fixture/ReplyAddon'}
 ]);
 await page.getByLabel('Choose Discord export').setInputFiles({name:'discord.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'thread/messages.json':strToU8(messages)}))});
 await expect(page.getByRole('button',{name:'Add to import queue',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Add to import queue',exact:true}).click();
 await expect(page.getByText(/1 new links queued/)).toBeVisible();
 await page.getByLabel('Choose Discord export').setInputFiles({name:'discord.json',mimeType:'application/json',buffer:Buffer.from(messages)});
 await page.getByRole('button',{name:'Add to import queue',exact:true}).click();
 await expect(page.getByText(/0 new links queued.*1 already listed/)).toBeVisible();
 await adminPage.reload();
 await adminPage.getByPlaceholder('Search the queue').fill(name);
 await expect(adminPage.locator('[data-entry]').filter({hasText:name})).toBeVisible();
 await expect(adminPage.getByText('Import Discord',{exact:true})).toHaveCount(0);
 let clears = 0;
 await page.route('**/rest/v1/rpc/clear_pending_discord_imports', route => {
  clears++;
  return route.fulfill({json:1});
 });
 await page.getByRole('button',{name:'Clear pending',exact:true}).click();
 await page.locator('dialog[open]').getByRole('button',{name:'Cancel',exact:true}).click();
 expect(clears).toBe(0);
 await page.getByRole('button',{name:'Clear pending',exact:true}).click();
 await page.locator('dialog[open]').getByRole('button',{name:'Clear imports',exact:true}).click();
 await expect(page.getByText('1 pending Discord imports cleared.',{exact:true})).toBeVisible();
 expect(clears).toBe(1);
 await context.close();
});
