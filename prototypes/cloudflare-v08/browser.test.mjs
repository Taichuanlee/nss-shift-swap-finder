// Actual HTTPS Chrome/Cookie test; Worker runtime and KV remain local adapters.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {MemoryKV,prepare,startLocal} from './local-harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
test('same-origin HTTPS login, HttpOnly persistence across browser restart, expiry and logout',async()=>{
  const {worker,a,b}=await prepare(),kv=new MemoryKV();await kv.put('schedule:active',a);
  const code=randomBytes(24).toString('base64url');
  const env={SCHEDULE_KV:kv,LOGIN_LIMITER:{limit:async()=>({success:true})},ACCESS_CODE_SHA256:createHash('sha256').update(code).digest('hex'),SESSION_TTL_SECONDS:3600};
  const server=await startLocal(env,worker),profile=await mkdtemp(path.join(os.tmpdir(),'nss-v08-browser-'));
  const options={headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ignoreHTTPSErrors:true,viewport:{width:390,height:844}};
  let browser;const errors=[],requests=[];
  async function launch() {
    browser=await chromium.launchPersistentContext(profile,options);
    browser.on('request',r=>requests.push(r.url()));
    const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));return page;
  }
  try {
    let page=await launch();await page.goto(server.origin);
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('到期'));
    assert.equal(await page.evaluate(async()=> (await fetch('/api/schedule')).status),401);
    await page.locator('#code').fill('x'.repeat(32));await page.locator('#login button').click();
    await page.waitForFunction(()=>document.getElementById('code').value==='');
    assert.equal(await page.locator('#authenticated').isVisible(),false);
    await page.locator('#code').fill(code);await page.locator('#login button').click();
    await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('2 位'));
    const cookies=await browser.cookies(server.origin);assert.equal(cookies.length,1);
    const cookie=cookies[0];assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);assert.equal(cookie.sameSite,'Strict');
    assert.ok(cookie.expires>Date.now()/1000);assert.equal(await page.evaluate(()=>document.cookie),'');
    assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
    await browser.close();page=await launch();await page.goto(server.origin);
    await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('2 位'));
    assert.equal(await page.locator('#login').isVisible(),false);
    // Observe a controlled old->new KV response; this is not a latency benchmark.
    kv.staleSchedule=a;await kv.put('schedule:active',b);
    const revision=createHash('sha256').update(b).digest('hex');await page.locator('#expected').fill(revision);
    await page.locator('#observe').click();await page.waitForFunction(()=>document.getElementById('observations').textContent.includes('local'));
    kv.staleSchedule=null;
    await page.waitForFunction(()=>document.getElementById('observation-status').textContent.includes('已觀察到'),undefined,{timeout:15000});
    assert.ok((await page.locator('#observations').textContent()).includes(revision));
    // Keep cookie and KV entry, but expire server-side session: must reject.
    for(const [key,row] of kv.values)if(key.startsWith('session:')) {
      const value=JSON.parse(row.value);value.expiresAt=Date.now()-1;kv.values.set(key,{value:JSON.stringify(value)});
    }
    await page.locator('#reload').click();await page.waitForFunction(()=>document.getElementById('authenticated').hidden);
    assert.equal(await page.locator('#schedule').textContent(),'');
    await page.locator('#code').fill(code);await page.locator('#login button').click();
    await page.waitForFunction(()=>document.getElementById('summary').textContent.includes('2 位'));
    await page.locator('#logout').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='已登出。');
    assert.equal((await browser.cookies(server.origin)).length,0);
    assert.equal(await page.evaluate(async()=> (await fetch('/api/schedule')).status),401);
    assert.ok(requests.every(url=>url.startsWith(server.origin+'/')));assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await server.close();}
});
