// Tests real SSF UI + Worker handlers over local HTTPS; Cloudflare bindings are adapters.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {buildIntegrated} from './build-integrated.mjs';
import {MemoryKV,prepare,startLocal} from './local-harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),XLSX=require('../../vendor/sheetjs/xlsx.full.min.js');
const {pdf,grid}=require('../../tests/fixtures.cjs');
const {a,b}=await prepare(),pack=await buildIntegrated();
const worker=(await import(pathToFileURL(path.join(pack.output,'worker.mjs')).href)).default;
const mime=file=>file.endsWith('.html')?'text/html':/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream';
function fixture() {
  const code=randomBytes(24).toString('base64url'),kv=new MemoryKV();kv.values.set('schedule:active',{value:a});
  const env={ACCESS_CODE_SHA256:createHash('sha256').update(code).digest('hex'),SCHEDULE_KV:kv,SESSION_TTL_SECONDS:3600,
    ASSETS:{fetch:async request=>{
      let file=new URL(request.url).pathname.slice(1)||'index.html';
      if(!pack.inventory.includes(file))return new Response('not found',{status:404});
      return new Response(request.method==='HEAD'?null:await readFile(path.join(pack.assets,file)),{headers:{'Content-Type':mime(file)}});
    }}};
  return {code,kv,env};
}
test('integrated package contains only public SSF resources and enforces same-origin static routing',async()=>{
  const {env}=fixture();
  assert.ok(pack.inventory.length>100);
  assert.ok(pack.inventory.includes('vendor/pdfjs/pdf.worker.mjs'));
  assert.ok(pack.inventory.every(f=>!/(secret|synthetic|test-data|\.env|\.json$|\.test\.)/.test(f)));
  const html=await readFile(path.join(pack.assets,'index.html'),'utf8');assert.match(html,/id="central-login"/);
  const root=await readFile(new URL('../../index.html',import.meta.url),'utf8');assert.ok(!root.includes('central-login'));
  const config=JSON.parse(await readFile(path.join(pack.output,'wrangler.jsonc'),'utf8'));
  assert.equal(config.name,'nss-ssf-v08-test');assert.equal(config.assets.binding,'ASSETS');assert.equal(config.assets.run_worker_first,true);
  for(const url of ['/','/js/app.js','/vendor/pdfjs/pdf.worker.mjs','/central-schedule.js']) {
    const response=await worker.fetch(new Request('https://test.example'+url),env);assert.equal(response.status,200);
  }
  for(const url of ['/dist/local-secrets.json','/synthetic-a.json','/worker.mjs','/.env','/api/publish'])
    assert.equal((await worker.fetch(new Request('https://test.example'+url),env)).status,404);
  assert.equal((await worker.fetch(new Request('https://test.example/api/schedule'),env)).status,401);
  delete env.ASSETS;assert.equal((await worker.fetch(new Request('https://test.example/'),env)).status,503);
});
test('central SSF: login, adapter, search, auto restore, revision switch, fallback, races and error cleanup',async()=>{
  const f=fixture(),server=await startLocal(f.env,worker),profile=await mkdtemp(path.join(os.tmpdir(),'nss-ssf-central-'));
  let browser;const requests=[],errors=[];
  try {
    browser=await chromium.launchPersistentContext(profile,{headless:true,ignoreHTTPSErrors:true,
      executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',viewport:{width:390,height:844}});
    browser.on('request',r=>requests.push({url:r.url(),method:r.method()}));
    const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(server.origin);
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('尚未登入'));
    assert.equal(await page.locator('#source-unit').isChecked(),true);
    assert.equal(await page.locator('#manual-workspace').isVisible(),false);
    assert.equal(await page.locator('#parse-result').isVisible(),false);
    assert.doesNotMatch(await page.locator('body').innerText(),/中央班表|手動上傳/);
    await page.locator('#central-code').fill('x'.repeat(32));await page.locator('#central-login button').click();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('存取碼錯誤'));
    await page.locator('#central-code').fill(f.code);await page.locator('#central-login button').click();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    assert.equal(await page.locator('#central-code').inputValue(),'');
    assert.equal(await page.locator('#source-unit').isChecked(),true);
    for(const id of ['manual-workspace','parse-result','date-review','cycle-confirmation','result-summary','issue-details','import-progress'])
      assert.equal(await page.locator('#'+id).isVisible(),false);
    assert.equal(await page.locator('#result-summary').textContent(),'');
    assert.equal(await page.locator('#identity-selection').isVisible(),true);
    await page.waitForFunction(()=>document.activeElement.id==='identity-selection');
    await page.setViewportSize({width:320,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(pack.output,'phase31-unit.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#export-publication').isVisible(),false);
    async function confirmCentral() {
      await page.locator('#employee-search').fill('SYNTHETIC001');await page.locator('.employee-option').click();
      await page.locator('#confirm-identity').click();
      await page.waitForFunction(()=>!document.getElementById('personal-schedule').hidden);
    }
    await confirmCentral();assert.equal(await page.locator('.personal-day').count(),28);
    await page.locator('.want-day[data-date="2026-11-12"]').click();
    await page.locator('#exchange-dates input[value="2026-11-13"]').check();
    await page.locator('#search-swaps').click();assert.equal(await page.locator('.swap-candidate').count(),1);
    // Central data must support unchanged personal corrections without writing KV.
    await page.locator('#edit-schedule').click();await page.locator('.edit-day[data-date="2026-11-12"]').click();
    await page.locator('#shift-options button[data-shift="N"]').click();
    assert.equal(await page.locator('.swap-candidate').count(),0);
    // Source selector clears identity/corrections even before an upload is chosen.
    await page.locator('#source-upload').check();
    assert.equal(await page.locator('#personal-schedule').isVisible(),false);
    assert.equal(await page.locator('#identity-selection').isVisible(),false);
    assert.equal(await page.locator('#manual-workspace').isVisible(),true);
    assert.equal(await page.locator('#central-login').isVisible(),false);
    assert.equal(await page.locator('#parse-result').isVisible(),false);
    assert.equal(await page.locator('.file-picker').isVisible(),true);
    await page.locator('#source-unit').check();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    assert.equal(await page.locator('#parse-result').isVisible(),false);
    await confirmCentral();
    assert.equal(await page.locator('.personal-day[data-date="2026-11-12"] strong').textContent(),'A');
    const writes=f.kv.writes.length;await f.kv.put('schedule:active',b);
    await page.locator('#central-load').click();
    const revB=createHash('sha256').update(b).digest('hex');
    await page.waitForFunction(revision=>document.getElementById('schedule-source').textContent.includes(revision),revB);
    assert.equal(await page.locator('#personal-schedule').isVisible(),false);
    assert.equal(await page.locator('.swap-candidate').count(),0);assert.equal(f.kv.writes.length,writes+1);
    await confirmCentral();assert.equal(await page.locator('.personal-day[data-date="2026-11-12"] strong').textContent(),'A');
    await page.reload();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    assert.equal(await page.locator('#central-login').isVisible(),false);
    assert.equal(await page.locator('#personal-schedule').isVisible(),false);
    // Delay central response, then switch to a local Excel import.
    let release,arrived;const reached=new Promise(resolve=>arrived=resolve);
    await page.route('**/api/schedule',async route=>{await new Promise(resolve=>{release=resolve;arrived();});try {await route.continue();}catch {}});
    await page.locator('#central-load').click();await reached;
    await page.locator('#source-upload').check();
    assert.equal(await page.locator('#manual-workspace').isVisible(),true);
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid()),'Synthetic');
    await page.locator('#schedule-file').setInputFiles({name:'synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(wb,{type:'array',bookType:'xlsx'}))});
    release();await page.unroute('**/api/schedule');await page.locator('#parse-button').click();
    await page.waitForFunction(()=>!document.getElementById('cycle-start').disabled);
    await page.locator('#confirm-cycle').click();
    assert.match(await page.locator('#schedule-source').textContent(),/自行上傳 Excel/);
    assert.equal(await page.evaluate(()=>NSSShiftSwapFinder.ImportController.getSource()),'manual');
    assert.equal(await page.locator('#cycle-start').isDisabled(),false);
    assert.equal(await page.locator('#parse-result').isVisible(),true);
    assert.equal(await page.locator('#date-review').isVisible(),true);
    assert.equal(await page.locator('#cycle-confirmation').isVisible(),true);
    assert.equal(await page.locator('#issue-details').isVisible(),true);
    // Logging out of central service must preserve an independently loaded manual model.
    // The logout operation still preserves local data; controls are hidden in upload mode.
    await page.evaluate(()=>document.getElementById('central-logout').click());await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('已登出'));
    assert.equal(await page.locator('#identity-selection').isVisible(),true);assert.match(await page.locator('#schedule-source').textContent(),/自行上傳/);
    await page.locator('#source-unit').check();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('尚未登入'));
    assert.equal(await page.locator('#identity-selection').isVisible(),false);
    await page.locator('#central-code').fill(f.code);await page.locator('#central-login button').click();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    assert.equal(await page.locator('#selected-file').isVisible(),false);
    // Malformed successful envelope: adapter rejects and leaves no old searchable data.
    await page.route('**/api/schedule',route=>route.fulfill({json:{revision:'a'.repeat(64),payload:{schemaVersion:99},expiresAt:new Date(Date.now()+3600000).toISOString()}}));
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('格式錯誤'));
    assert.equal(await page.locator('#parse-result').isVisible(),false);assert.equal(await page.locator('#identity-selection').isVisible(),false);
    await page.unroute('**/api/schedule');
    await f.kv.put('schedule:active','invalid-json');
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('格式錯誤'));
    assert.equal(await page.locator('#identity-selection').isVisible(),false);await f.kv.put('schedule:active',b);
    // Valid shape with an invalid 28-day cycle must fail background validation too.
    const invalidCycle=JSON.parse(b);invalidCycle.cycle.endDate=invalidCycle.cycle.startDate;
    await page.route('**/api/schedule',route=>route.fulfill({json:{revision:'b'.repeat(64),payload:invalidCycle,expiresAt:new Date(Date.now()+3600000).toISOString()}}));
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('格式錯誤'));
    assert.equal(await page.locator('#identity-selection').isVisible(),false);
    assert.equal(await page.locator('#parse-result').isVisible(),false);await page.unroute('**/api/schedule');
    await page.route('**/api/schedule',route=>route.abort('failed'));
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('無法連線'));
    assert.equal(await page.locator('.personal-day').count(),0);await page.unroute('**/api/schedule');
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    for(const [key,row] of f.kv.values)if(key.startsWith('session:')){const value=JSON.parse(row.value);value.expiresAt=Date.now()-1;f.kv.values.set(key,{value:JSON.stringify(value)});}
    await page.locator('#central-load').click();await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('已到期'));
    assert.equal(await page.locator('#central-login').isVisible(),true);assert.equal(await page.locator('#parse-result').isVisible(),false);
    await page.locator('#source-upload').check();
    // PDF fallback still uses the real local PDF.js module/worker and confirmation.
    await page.locator('#schedule-file').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdf([grid()])});
    await page.locator('#parse-button').click();await page.waitForFunction(()=>!document.getElementById('cycle-start').disabled);
    await page.locator('#confirm-cycle').click();assert.match(await page.locator('#schedule-source').textContent(),/自行上傳 PDF/);
    assert.equal(await page.locator('#identity-selection').isVisible(),true);
    // A known session deadline also clears central state without another API call.
    f.env.SESSION_TTL_SECONDS=3;
    await page.locator('#source-unit').check();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('尚未登入'));
    await page.locator('#central-code').fill(f.code);await page.locator('#central-login button').click();
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('單位班表已載入'));
    await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('登入已到期'),undefined,{timeout:6000});
    assert.equal(await page.locator('#parse-result').isVisible(),false);
    assert.equal(await page.locator('#identity-selection').isVisible(),false);
    assert.ok(requests.every(r=>r.url.startsWith(server.origin+'/')));
    assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.url.endsWith('/api/login')||r.url.endsWith('/api/logout')));
    for(const width of [320,1280]) {await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await server.close();}
});
