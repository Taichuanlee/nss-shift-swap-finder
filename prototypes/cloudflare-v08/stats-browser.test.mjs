import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {buildIntegrated} from './build-integrated.mjs';
import {MemoryKV,prepare,startLocal} from './local-harness.mjs';
import {counterFixture} from './stats-test-support.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const {a}=await prepare(),pack=await buildIntegrated(),worker=(await import(pathToFileURL(path.join(pack.output,'worker.mjs')).href)).default;
test('real search UI: zero candidates, repeated clicks, retries, invalid conditions/errors, failure isolation and private dashboard',async()=>{
 const kv=new MemoryKV(),counter=counterFixture(),yes={limit:async()=>({success:true})};kv.values.set('schedule:active',{value:a});
 const env={ACCESS_CODE:'test-nurse',ADMIN_ACCESS_CODE:'test-admin',STATS_ACCESS_CODE:'test-separate-stats-secret',SCHEDULE_KV:kv,LOGIN_LIMITER:yes,STATS_LOGIN_LIMITER:yes,STATS_EVENT_LIMITER:yes,SEARCH_STATS:{idFromName:n=>n,get:()=>counter.object},ASSETS:{fetch:async r=>{
  const file=new URL(r.url).pathname.slice(1);return new Response(await readFile(path.join(pack.assets,file)),{headers:{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'}});
 }}};
 const server=await startLocal(env,worker),profile=await mkdtemp(path.join(os.tmpdir(),'ssf-stats-browser-'));let browser;
 const summary=async()=>(await (await counter.send({action:'summary'})).json()).cycles.reduce((n,c)=>n+c.totalSearches,0);
 try {
  browser=await chromium.launchPersistentContext(profile,{headless:true,ignoreHTTPSErrors:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage(),sent=[];page.on('request',r=>{if(r.url().endsWith('/api/stats/events'))sent.push(JSON.parse(r.postData()));});
  await page.goto(server.origin);await page.locator('#central-code').fill(env.ACCESS_CODE);await page.locator('#central-login button').click();
  await page.locator('#employee-search').fill('SYNTHETIC001');await page.locator('.employee-option').click();await page.locator('#confirm-identity').click();
  await page.locator('.want-day[data-date="2026-11-12"]').click();await page.locator('#exchange-dates input[value="2026-11-13"]').check();
  const writes=kv.writes.length;
  await page.locator('#search-swaps').click();await page.waitForResponse(r=>r.url().endsWith('/api/stats/events'));
  assert.equal(await summary(),1);assert.equal(await page.locator('.swap-candidate').count(),1);
  await page.locator('#search-swaps').click();await page.waitForResponse(r=>r.url().endsWith('/api/stats/events'));assert.equal(await summary(),2);assert.notEqual(sent[0].eventId,sent[1].eventId);
  // Lose the first response AFTER the backend counted; retry must deduplicate.
  let first=true;await page.route('**/api/stats/events',async route=>{if(first){first=false;await route.fetch();await route.abort();}else await route.continue();});
  await page.locator('#search-swaps').click();await page.waitForFunction(()=>document.getElementById('swap-status').textContent.includes('找到'));
  await page.waitForResponse(r=>r.url().endsWith('/api/stats/events'));
  assert.equal(await summary(),3);assert.equal(sent[2].eventId,sent[3].eventId);await page.unroute('**/api/stats/events');
  // Every candidate excludes this date pair: still one completed search.
  await page.locator('#exchange-dates input[value="2026-11-13"]').uncheck();await page.locator('#exchange-dates input[value="2026-11-14"]').check();
  await page.locator('#search-swaps').click();await page.waitForResponse(r=>r.url().endsWith('/api/stats/events'));assert.equal(await page.locator('.swap-candidate').count(),0);assert.equal(await summary(),4);
  // A program error before rendering cannot emit an event.
  await page.evaluate(()=>{const ns=window.NSSShiftSwapFinder;const original=ns.SwapEngine;ns.SwapEngine={...original,search(){throw Error('synthetic search error');}};window.restoreEngine=()=>{ns.SwapEngine=original;};});
  await page.locator('#search-swaps').click();assert.equal(await page.locator('#swap-status').textContent(),'synthetic search error');assert.equal(sent.length,5);await page.evaluate(()=>window.restoreEngine());
  // Missing selections also cannot emit, including a programmatic button click.
  await page.locator('#exchange-dates input[value="2026-11-14"]').uncheck();await page.evaluate(()=>{document.getElementById('search-swaps').disabled=false;document.getElementById('search-swaps').click();});assert.equal(sent.length,5);
  await page.locator('#exchange-dates input[value="2026-11-13"]').check();
  await page.locator('#exchange-dates input[value="2026-11-14"]').check();
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/stats/events')),page.locator('#search-swaps').click()]);assert.equal(await summary(),5);
  await page.route('**/api/stats/events',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  const failures=[];page.on('response',r=>{if(r.url().endsWith('/api/stats/events')&&r.status()===503)failures.push(r);});
  await page.locator('#search-swaps').click();assert.equal(await page.locator('.swap-candidate').count(),1);
  while(failures.length<2)await page.waitForResponse(r=>r.url().endsWith('/api/stats/events')&&r.status()===503);
  await page.unroute('**/api/stats/events');assert.equal(await summary(),5);assert.equal(kv.writes.length,writes);
  const dashboard=await browser.newPage();await dashboard.goto(server.origin+'/stats.html');assert.equal(await dashboard.locator('#stats-content').isVisible(),false);
  await dashboard.locator('#stats-code').fill(env.ACCESS_CODE);await dashboard.locator('#stats-login button').click();await dashboard.waitForFunction(()=>document.getElementById('stats-status').textContent.includes('密碼錯誤'));
  await dashboard.locator('#stats-code').fill(env.STATS_ACCESS_CODE);await dashboard.locator('#stats-login button').click();await dashboard.waitForSelector('#stats-content:visible');
  assert.match(await dashboard.locator('#stats-cycles').textContent(),/總搜尋次數：5；被選取不同員工數：1/);assert.equal(await dashboard.locator('#stats-code').inputValue(),'');
  await dashboard.setViewportSize({width:320,height:900});assert.equal(await dashboard.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await dashboard.locator('#stats-logout').click();assert.equal(await dashboard.locator('#stats-cycles').textContent(),'');
 }finally{await browser?.close();await server.close();}
});
