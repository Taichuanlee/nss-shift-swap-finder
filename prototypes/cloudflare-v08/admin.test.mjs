// Synthetic fixtures only; local HTTPS and binding doubles do not prove Cloudflare behavior.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {buildIntegrated} from './build-integrated.mjs';
import {MemoryKV,startLocal} from './local-harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),XLSX=require('../../vendor/sheetjs/xlsx.full.min.js');
const {pdf,grid,dates,metadataGrid}=require('../../tests/fixtures.cjs');
const pack=await buildIntegrated(),worker=(await import(pathToFileURL(path.join(pack.output,'worker.mjs')).href)).default;
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture() {
  const code='0'+String(crypto.getRandomValues(new Uint32Array(1))[0]%10000).padStart(4,'0'),nurse='1'+String(crypto.getRandomValues(new Uint32Array(1))[0]%100000).padStart(5,'0'),kv=new MemoryKV(),calls=[];
  const env={SCHEDULE_KV:kv,LOGIN_LIMITER:{limit:async()=>({success:true})},ACCESS_CODE:nurse,ADMIN_ACCESS_CODE:code,
    ADMIN_LOGIN_LIMITER:{limit:async({key})=>{calls.push(key);return {success:true};}},ASSETS:{fetch:async request=>{
      const file=new URL(request.url).pathname.slice(1)||'index.html';if(!pack.inventory.includes(file))return new Response('missing',{status:404});
      return new Response(request.method==='HEAD'?null:await readFile(path.join(pack.assets,file)),{headers:{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream'}});
    }}};
  return {env,kv,code,nurse,calls};
}
function call(f,route,options={}) {return worker.fetch(new Request('https://test.example'+route,options),f.env);}
function post(f,route,code,headers={}) {return call(f,route,{method:'POST',headers:{Origin:'https://test.example','Content-Type':'application/json',...headers},body:JSON.stringify({code})});}
test('admin auth: separate credentials/roles, protected aliases, Origin, limits, rotation, expiry and no legacy publishing routes',async()=>{
  const f=fixture();
  const config=JSON.parse(await readFile(path.join(pack.output,'wrangler.jsonc'),'utf8'));
  assert.equal(config.assets.run_worker_first,true);assert.equal(config.assets.html_handling,'none');
  assert.ok(config.ratelimits.some(r=>r.name==='ADMIN_LOGIN_LIMITER'&&r.simple.limit===5));assert.ok(config.ratelimits.some(r=>r.name==='LOGIN_LIMITER'&&r.namespace_id==='8808'&&r.simple.limit===50&&r.simple.period===60));
  assert.deepEqual(config.secrets.required,['ACCESS_CODE','ADMIN_ACCESS_CODE']);
  assert.equal(config.keep_vars,true);assert.ok(!JSON.stringify(config).includes(f.code));
  for(const route of ['/admin','/admin/','/admin.html'])assert.equal((await call(f,route)).status,303);
  assert.equal((await call(f,'/admin/login')).status,200);
  assert.equal((await call(f,'/api/admin/session')).status,401);
  assert.equal((await post(f,'/api/admin/login',f.nurse)).status,401);
  assert.equal((await post(f,'/api/admin/login',f.code,{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await call(f,'/api/admin/login',{method:'POST'})).status,403);
  assert.equal((await call(f,'/api/admin/login')).status,405);
  assert.equal((await post(f,'/api/admin/login',f.code,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post(f,'/api/admin/login','x'.repeat(2000))).status,400);
  const nurse=await post(f,'/api/login',f.nurse),nurseCookie=nurse.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(f,'/admin',{headers:{Cookie:nurseCookie}})).status,303);
  const login=await post(f,'/api/admin/login',f.code);assert.equal(login.status,200);
  const fullCookie=login.headers.get('set-cookie'),cookie=fullCookie.split(';')[0];
  assert.match(fullCookie,/__Host-nss-ssf-admin=/);assert.match(fullCookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!JSON.stringify(await login.json()).includes(cookie.split('=')[1]));
  assert.ok(f.calls.includes('admin-account'));assert.ok(f.calls.includes('admin-ip:local'));
  for(const route of ['/admin','/admin/','/admin.html']) {
    const response=await call(f,route,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.match(await response.text(),/完整班表預覽/);
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
  assert.equal((await call(f,'/api/schedule',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await call(f,'/api/admin/session',{headers:{Cookie:nurseCookie}})).status,401);
  assert.equal((await call(f,'/admin',{headers:{Cookie:cookie+'; '+cookie}})).status,303);
  for(const route of ['/api/publish','/api/admin/schedule'])for(const method of ['GET','POST'])
    assert.equal((await call(f,route,{method,headers:{Cookie:cookie,Origin:'https://test.example'}})).status,404);
  const rotated=await post(f,'/api/admin/login',f.code,{Cookie:cookie});assert.equal(rotated.status,200);
  assert.equal((await call(f,'/api/admin/session',{headers:{Cookie:cookie}})).status,401);
  const next=rotated.headers.get('set-cookie').split(';')[0];
  const key='admin-session:'+hash(next.split('=')[1]),value=JSON.parse(f.kv.values.get(key).value);
  value.expiresAt=Date.now()-1;value.createdAt=value.expiresAt-1000;f.kv.values.set(key,{value:JSON.stringify(value)});
  assert.equal((await call(f,'/api/admin/session',{headers:{Cookie:next}})).status,401);
  const final=await post(f,'/api/admin/login',f.code),finalCookie=final.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(f,'/api/admin/logout',undefined,{Cookie:finalCookie})).status,200);
  assert.equal((await call(f,'/admin',{headers:{Cookie:finalCookie}})).status,303);
  assert.ok(f.kv.writes.every(w=>w.key.startsWith('admin-session:')||w.key.startsWith('session:')));
});
test('admin limiter/configuration fails closed without changing nurse access',async()=>{
  const f=fixture();delete f.env.ADMIN_LOGIN_LIMITER;
  assert.equal((await post(f,'/api/admin/login',f.code)).status,503);
  assert.equal((await post(f,'/api/login',f.nurse)).status,200);
  f.env.ADMIN_LOGIN_LIMITER={limit:async()=>({success:false})};
  const limited=await post(f,'/api/admin/login',f.code);assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');
  f.env.ADMIN_LOGIN_LIMITER={limit:async({key})=>({success:key!=='admin-account'})};
  assert.equal((await post(f,'/api/admin/login',f.code)).status,429);
  f.env.ADMIN_LOGIN_LIMITER={limit:async()=>{throw new Error('offline');}};
  assert.equal((await post(f,'/api/admin/login',f.code)).status,503);
  f.env.ADMIN_LOGIN_LIMITER={limit:async()=>({success:true})};f.env.ADMIN_ACCESS_CODE=f.env.ACCESS_CODE;
  assert.equal((await post(f,'/api/admin/login',f.nurse)).status,503);
  f.env.ADMIN_ACCESS_CODE=f.code;f.env.ADMIN_SESSION_TTL_SECONDS=3601;
  assert.equal((await post(f,'/api/admin/login',f.code)).status,503);
});
test('admin browser: local Excel/PDF import, explicit repeated-date correction, full readonly preview and expiry cleanup',async()=>{
  const f=fixture(),server=await startLocal(f.env,worker),requests=[],errors=[];
  let browser;
  try {
    browser=await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(),'nss-admin-')),{headless:true,ignoreHTTPSErrors:true,
      executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',viewport:{width:1440,height:1000}});
    browser.on('request',r=>requests.push({url:r.url(),method:r.method(),body:r.postData()}));
    const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.origin+'/admin');await page.waitForURL('**/admin/login');
    await page.locator('#admin-code').fill(f.nurse);await page.locator('#admin-login button').click();
    await page.waitForFunction(()=>document.getElementById('admin-status').textContent.includes('存取碼錯誤'));
    await page.locator('#admin-code').fill(f.code);await page.locator('#admin-login button').click();await page.waitForURL('**/admin');
    await page.waitForFunction(()=>!document.getElementById('admin-file').disabled);
    assert.equal(await page.locator('section').count(),4);
    const ds=dates(40,Date.UTC(2026,10,4)),rows=grid(ds);rows[0]=['Synthetic schedule 2026-11-09 ~ 2026-12-06'];
    rows[2][1]='<img src=x onerror=alert(1)>';
    const workbook=(sheets)=>{const book=XLSX.utils.book_new();for(const [name,data] of sheets)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(data),name);return Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));};
    const upload=async(name,buffer)=>page.locator('#admin-file').setInputFiles({name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
    await upload('synthetic.xlsx',workbook([['A',rows],['B',grid(ds)]]));
    await page.waitForFunction(()=>!document.getElementById('sheet-picker').hidden);
    await page.locator('#parse-sheet').click();await page.waitForFunction(()=>document.querySelectorAll('#admin-preview tbody tr').length===2);
    assert.equal(await page.locator('#admin-cycle-start').inputValue(),'2026-11-09');
    assert.equal(await page.locator('#admin-cycle-end').textContent(),'2026-12-06');
    assert.equal(await page.locator('#admin-preview thead th.official').count(),28);
    assert.equal(await page.locator('#admin-preview thead th.outside').count(),12);
    assert.equal(await page.locator('#admin-preview input,#admin-preview select,#admin-preview [contenteditable]').count(),0);
    assert.equal(await page.locator('#admin-preview img').count(),0);
    await page.locator('#admin-confirm-cycle').click();assert.match(await page.locator('#admin-errors').textContent(),/無未解決/);
    assert.equal(await page.locator('#admin-publish').isDisabled(),false);
    await page.locator('#admin-cycle-start').fill('2026-12-01');await page.locator('#admin-cycle-start').dispatchEvent('change');
    await page.locator('#admin-confirm-cycle').click();assert.match(await page.locator('#admin-errors').textContent(),/連續 28 天/);
    await page.locator('#admin-cycle-start').fill('2026-11-09');await page.locator('#admin-cycle-start').dispatchEvent('change');
    // Three synthetic PDF pages: no automatic typo correction before explicit decision.
    const typo=metadataGrid(dates(33,Date.UTC(2026,10,4)));typo[1][11]='1/16';
    await upload('synthetic.pdf',pdf([typo,typo,typo]));
    await page.waitForFunction(()=>document.getElementById('admin-errors').textContent.includes('同步 3 個'));
    assert.match(await page.locator('#admin-preview').textContent(),/2026-01-16/);
    await page.locator('#admin-confirm-cycle').click();assert.doesNotMatch(await page.locator('#cycle-status').textContent(),/驗證通過/);
    await page.getByRole('button',{name:'確認此日期修正'}).click();
    assert.doesNotMatch(await page.locator('#admin-preview table').textContent(),/2026-01-16/);
    assert.equal(await page.locator('#admin-preview tbody tr:first-child td').count(),33);
    await page.locator('#admin-confirm-cycle').click();assert.match(await page.locator('#cycle-status').textContent(),/驗證通過/);
    assert.equal(await page.locator('#admin-preview details p').count(),3);
    await page.screenshot({path:path.join(pack.output,'phase4a-admin.png'),fullPage:true});
    // Unknown shift blocks confirmation, even though all people/dates remain visible.
    const invalid=grid(ds);invalid[2][2]='INVALID';
    await upload('invalid.xlsx',workbook([['A',invalid]]));await page.waitForFunction(()=>document.getElementById('admin-errors').textContent.includes('UNKNOWN_SHIFT'));
    await page.locator('#admin-confirm-cycle').click();assert.doesNotMatch(await page.locator('#cycle-status').textContent(),/驗證通過/);
    // Slow old parser cannot restore a replaced file or cleared session.
    await page.evaluate(()=>{const original=window.NSSShiftSwapFinder.ExcelParser;window.NSSShiftSwapFinder.ExcelParser={parse:async(...args)=>{await new Promise(r=>setTimeout(r,250));return original.parse(...args);}};});
    await upload('slow.xlsx',workbook([['A',rows]]));await upload('bad.xlsx',Buffer.from('invalid'));
    await page.waitForFunction(()=>document.getElementById('import-status').textContent.includes('匯入失敗'));
    await page.waitForTimeout(350);assert.equal(await page.locator('#admin-preview table').count(),0);
    await upload('synthetic.xlsx',workbook([['A',rows]]));await page.waitForFunction(()=>!!document.querySelector('#admin-preview table'));
    const cookies=await browser.cookies(),token=cookies.find(c=>c.name==='__Host-nss-ssf-admin').value;
    const key='admin-session:'+hash(token),value=JSON.parse(f.kv.values.get(key).value);value.expiresAt=Date.now()-1;value.createdAt=value.expiresAt-1000;f.kv.values.set(key,{value:JSON.stringify(value)});
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>document.getElementById('admin-status').textContent.includes('登入已到期'));
    assert.equal(await page.locator('#admin-preview table').count(),0);assert.equal(await page.locator('#admin-file').isDisabled(),true);
    // A failed session request leaves a protected page unusable and data-free.
    await page.goto(server.origin+'/admin/login');await page.locator('#admin-code').fill(f.code);
    await page.locator('#admin-login button').click();await page.waitForURL('**/admin');
    await page.waitForFunction(()=>!document.getElementById('admin-file').disabled);
    await page.route('**/api/admin/session',route=>route.abort());await page.reload();
    await page.waitForFunction(()=>document.getElementById('admin-status').textContent.includes('網路連線失敗'));
    assert.equal(await page.locator('#admin-file').isDisabled(),true);
    await page.unroute('**/api/admin/session');await page.reload();
    await page.waitForFunction(()=>!document.getElementById('admin-file').disabled);
    await upload('synthetic.xlsx',workbook([['A',rows]]));await page.waitForFunction(()=>!!document.querySelector('#admin-preview table'));
    await page.locator('#admin-logout').click();await page.waitForURL('**/admin/login');
    await page.goto(server.origin+'/admin');await page.waitForURL('**/admin/login');
    const bodies=requests.filter(r=>r.method==='POST');assert.ok(bodies.length>=2);
    assert.ok(bodies.every(r=>new URL(r.url).pathname==='/api/admin/login'||new URL(r.url).pathname==='/api/admin/logout'));
    assert.ok(bodies.every(r=>!r.body?.includes('EXAMPLE')));
    assert.equal(requests.some(r=>new URL(r.url).pathname==='/api/schedule'),false);
    assert.ok(requests.every(r=>new URL(r.url).origin===server.origin||r.url.startsWith('blob:')));
    assert.ok(f.kv.writes.every(w=>w.key.startsWith('admin-session:')));assert.deepEqual(errors,[]);
  }finally {await browser?.close();await server.close();}
});

test('admin publication browser: one-click update, nurse reload, duplicate click and lost-response read-only confirmation',async()=>{
  const f=fixture(),server=await startLocal(f.env,worker),errors=[],posts=[];
  let browser;
  try {
    browser=await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(),'nss-publish-')),{headless:true,ignoreHTTPSErrors:true,
      executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',viewport:{width:1440,height:1000}});
    const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/admin/publish')posts.push(r.postData());});
    await page.goto(server.origin+'/admin/login');await page.locator('#admin-code').fill(f.code);
    await page.locator('#admin-login button').click();await page.waitForURL('**/admin');
    await page.waitForFunction(()=>!document.getElementById('admin-file').disabled);
    const ds=dates(40,Date.UTC(2026,10,4));
    async function upload(shift='A') {
      const rows=grid(ds);rows[0]=['Synthetic schedule 2026-11-09 ~ 2026-12-06'];
      rows[2][0]='SYNTHETIC001';rows[2][1]='合成測試員甲';rows[3][0]='SYNTHETIC002';rows[3][1]='合成測試員乙';rows[2][2]=shift;
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Synthetic');
      await page.locator('#admin-file').setInputFiles({name:'synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});
      await page.waitForFunction(()=>!!document.querySelector('#admin-preview table'));
      assert.equal(await page.locator('#admin-publish').isDisabled(),true);
      await page.locator('#admin-confirm-cycle').click();assert.equal(await page.locator('#admin-publish').isDisabled(),false);
    }
    await upload();
    // Delay the first write so a rapid second click is guaranteed to hit the busy guard.
    const original=f.kv.put.bind(f.kv);
    f.kv.put=async(...args)=>{if(args[0]==='schedule:active')await new Promise(r=>setTimeout(r,150));return original(...args);};
    await page.evaluate(()=>{const b=document.getElementById('admin-publish');b.click();b.click();});
    await page.waitForFunction(()=>document.getElementById('publish-status').textContent.startsWith('發布成功'));
    assert.equal(posts.length,1);assert.equal(f.kv.writes.filter(w=>w.key==='schedule:active').length,1);
    assert.equal(await page.locator('#admin-publish').isDisabled(),true);
    const first=f.kv.values.get('schedule:active').value;
    assert.equal(JSON.parse(first).dates.length,40);assert.ok(!posts[0].includes('validation'));
    // Nurse endpoints continue to use the same login and publication adapter.
    const nursing=await page.evaluate(async code=>{
      const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
      const data=await fetch('/api/schedule');return {login:login.status,data:data.status,payload:(await data.json()).payload};
    },f.nurse);
    assert.equal(nursing.login,200);assert.equal(nursing.data,200);assert.deepEqual(nursing.payload,JSON.parse(first));
    // Server writes B but the browser never receives the response; KV reads still see A.
    await upload('N');f.kv.staleSchedule=first;
    await page.route('**/api/admin/publish',async route=>{await route.fetch();await route.abort();});
    await page.locator('#admin-publish').click();
    await page.waitForFunction(()=>document.getElementById('publish-status').textContent.includes('尚無法確認發布結果'));
    assert.equal(posts.length,2);assert.equal(await page.locator('#admin-publish').textContent(),'重新確認發布結果');
    await page.locator('#admin-publish').click();
    await page.waitForFunction(()=>document.getElementById('publish-status').textContent.includes('尚無法確認發布結果'));
    assert.equal(posts.length,2);assert.equal(f.kv.writes.filter(w=>w.key==='schedule:active').length,2);
    f.kv.staleSchedule=null;
    await page.locator('#admin-publish').click();
    await page.waitForFunction(()=>document.getElementById('publish-status').textContent.includes('已確認目前單位班表'));
    assert.equal(posts.length,2);assert.equal(JSON.parse(f.kv.values.get('schedule:active').value).employees[0].shifts[ds[0]],'N');
    await page.unroute('**/api/admin/publish');
    // Failure before put leaves B. The UI conservatively checks rather than assuming rollback.
    await upload('E');const before=f.kv.values.get('schedule:active').value;
    f.kv.put=async(key,...args)=>{if(key==='schedule:active')throw new Error('simulated storage failure');return original(key,...args);};
    await page.locator('#admin-publish').click();
    await page.waitForFunction(()=>document.getElementById('publish-status').textContent.includes('尚無法確認發布結果'));
    assert.equal(f.kv.values.get('schedule:active').value,before);assert.equal(posts.length,3);
    assert.deepEqual(errors,[]);
  }finally {await browser?.close();await server.close();}
});

test('password changes revoke only their own role; legacy admin hash is not a fallback',async()=>{
  const f=fixture();
  const n=await post(f,'/api/login',f.nurse),a=await post(f,'/api/admin/login',f.code);
  const nc=n.headers.get('set-cookie').split(';')[0],ac=a.headers.get('set-cookie').split(';')[0];
  f.env.ADMIN_ACCESS_CODE=f.code+'a';
  assert.equal((await call(f,'/api/admin/session',{headers:{Cookie:ac}})).status,401);
  assert.equal((await call(f,'/api/session',{headers:{Cookie:nc}})).status,200);
  assert.equal((await post(f,'/api/admin/login',f.code)).status,401);
  const next=await post(f,'/api/admin/login',f.env.ADMIN_ACCESS_CODE);assert.equal(next.status,200);
  const nextCookie=next.headers.get('set-cookie').split(';')[0];f.env.ACCESS_CODE=f.nurse+'0';
  assert.equal((await call(f,'/api/session',{headers:{Cookie:nc}})).status,401);
  assert.equal((await call(f,'/api/admin/session',{headers:{Cookie:nextCookie}})).status,200);
  f.env.ADMIN_ACCESS_CODE_SHA256=hash(f.code);delete f.env.ADMIN_ACCESS_CODE;
  assert.equal((await post(f,'/api/admin/login',f.code)).status,503);
});

test('incomplete PDF/Excel preview can publish; nurse UI retains unknown days and warns',async()=>{
 const f=fixture(),server=await startLocal(f.env,worker);let browser;
 try {
  browser=await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(),'nss-blank-')),{headless:true,ignoreHTTPSErrors:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.origin+'/admin/login');await page.locator('#admin-code').fill(f.code);await page.locator('#admin-login button').click();await page.waitForURL('**/admin');
  await page.waitForFunction(()=>!document.getElementById('admin-file').disabled);
  const ds=dates(40,Date.UTC(2026,10,4)),rows=grid(ds);rows[0]=['Synthetic schedule 2026-11-09 ~ 2026-12-06'];
  rows[2][0]='SYNTHETIC001';rows[2][1]='合成測試員甲';rows[2][7]='';
  rows[3]=['SYNTHETIC002','合成測試員乙',...ds.map(()=> '')];
  for(const type of ['pdf','xlsx']) {
   let buffer;
   if(type==='pdf')buffer=pdf([rows]);else {const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Synthetic');buffer=Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));}
   await page.locator('#admin-file').setInputFiles({name:'synthetic-blank.'+type,mimeType:type==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
   await page.waitForFunction(()=>document.querySelectorAll('#admin-preview tbody tr').length===2);
   assert.match(await page.locator('#admin-errors').textContent(),/資料不完整/);assert.match(await page.locator('#admin-preview').textContent(),/未知／未排定/);
   await page.locator('#admin-confirm-cycle').click();assert.equal(await page.locator('#admin-publish').isDisabled(),false);
   await page.locator('#admin-publish').click();await page.waitForFunction(()=>document.getElementById('publish-status').textContent.startsWith('發布成功'));
   const saved=JSON.parse(f.kv.values.get('schedule:active').value);assert.equal(saved.employees.length,2);assert.ok(ds.every(d=>saved.employees[1].shifts[d]===''));assert.equal(saved.employees[0].shifts[ds[5]],'');
  }
  await page.goto(server.origin+'/');await page.locator('#central-code').fill(f.nurse);await page.locator('#central-login button').click();
  await page.waitForFunction(()=>document.getElementById('central-status').textContent.includes('資料不完整'));
  const loaded=await page.evaluate(async()=>{
   const payload=(await (await fetch('/api/schedule')).json()).payload,ns=NSSShiftSwapFinder,m=ns.SchedulePublication.load(payload);
   return {ids:m.employees.map(e=>e.id),empty:ns.PersonalSchedule.calendar(m,'SYNTHETIC002').every(d=>d.kind==='blank'),options:ns.SwapEngine.options(m,'SYNTHETIC002')};
  });
  assert.deepEqual(loaded.ids,['SYNTHETIC001','SYNTHETIC002']);assert.equal(loaded.empty,true);assert.deepEqual(loaded.options,{workDates:[],leaveDates:[]});assert.deepEqual(errors,[]);
 }finally {await browser?.close();await server.close();}
});
