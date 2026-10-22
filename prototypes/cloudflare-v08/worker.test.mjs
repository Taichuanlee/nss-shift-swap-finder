import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {MemoryKV,MemoryLimiter,prepare} from './local-harness.mjs';
const {worker,a,b}=await prepare();
const hash=value=>createHash('sha256').update(value).digest('hex');
let address=0;
function fixture() {
  const code=randomBytes(24).toString('base64url'),kv=new MemoryKV();kv.values.set('schedule:active',{value:a});
  const env={SCHEDULE_KV:kv,LOGIN_LIMITER:{limit:async()=>({success:true})},ACCESS_CODE:code,SESSION_TTL_SECONDS:3600};
  const ip=`test-${++address}`;
  const call=(pathname,{method='GET',body,cookie,origin='https://test.example',headers={}}={})=>worker.fetch(new Request(`https://test.example${pathname}`,{
    method,headers:{'CF-Connecting-IP':ip,...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const login=async()=>{const r=await call('/api/login',{method:'POST',body:{code}});assert.equal(r.status,200);return r.headers.get('Set-Cookie').split(';')[0];};
  return {kv,env,code,call,login};
}
test('unauthorized reads are denied before touching the schedule; public pages contain no data or secrets',async()=>{
  const f=fixture();
  for(const route of ['/api/schedule','/api/session'])assert.equal((await f.call(route)).status,401);
  assert.equal(f.kv.reads.length,0);
  for(const route of ['/','/app.js']) {
    const response=await f.call(route);assert.equal(response.status,200);const text=await response.text();
    assert.ok(!text.includes(f.code));assert.ok(!text.includes(f.env.ACCESS_CODE));assert.ok(!text.includes('SYNTHETIC001'));
    assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  }
});
test('correct code issues an opaque hardened cookie, saves only token hash in KV, and loads validated v1 data',async()=>{
  const f=fixture(),r=await f.call('/api/login',{method:'POST',body:{code:f.code}});
  assert.equal(r.status,200);const cookie=r.headers.get('Set-Cookie');
  assert.match(cookie,/^__Host-nss-ssf-test=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600$/);
  assert.ok(!cookie.includes('Domain='));
  const auth=await r.json();assert.ok(Date.parse(auth.expiresAt)>Date.now());assert.equal(Object.hasOwn(auth,'token'),false);
  const token=cookie.split(';')[0],rawToken=token.split('=')[1];
  assert.ok(f.kv.values.has(`session:${hash(rawToken)}`));assert.ok(!JSON.stringify([...f.kv.values]).includes(rawToken));
  const session=await f.call('/api/session',{cookie:token});assert.equal(session.status,200);
  const data=await f.call('/api/schedule',{cookie:token});assert.equal(data.status,200);
  assert.equal(data.headers.get('Cache-Control'),'no-store');assert.equal(data.headers.get('Access-Control-Allow-Origin'),null);
  const body=await data.json();assert.deepEqual(body.payload,JSON.parse(a));assert.equal(body.revision,hash(a));
  assert.equal(f.kv.writes.length,1);assert.equal(f.kv.reads.at(-1).options.cacheTtl,30);
});
test('wrong code, absent/cross origin, form submissions, oversized bodies and unknown routes fail closed',async()=>{
  const f=fixture();
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:'x'.repeat(32)}})).status,401);
  assert.equal(f.kv.writes.length,0);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code},origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code},headers:{Origin:''}})).status,403);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code},headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:'x'.repeat(2000)}})).status,400);
  assert.equal((await f.call('/api/schedule',{method:'POST',body:{}})).status,405);
  for(const route of ['/synthetic-a.json','/dist/local-secrets.json','/api/publish','/SCHEDULE_KV'])assert.equal((await f.call(route)).status,404);
});
test('expired, malformed, tampered and duplicate cookies cannot read a schedule, even if KV retains expired entries',async()=>{
  const f=fixture(),cookie=await f.login();
  for(const value of ['broken','__Host-nss-ssf-test='+ 'a'.repeat(64),`${cookie}; ${cookie}`])assert.equal((await f.call('/api/schedule',{cookie:value})).status,401);
  const key=f.kv.writes[0].key,row=JSON.parse(f.kv.values.get(key).value);row.expiresAt=Date.now()-1;
  f.kv.values.set(key,{value:JSON.stringify(row)});
  assert.equal((await f.call('/api/session',{cookie})).status,401);
  assert.equal((await f.call('/api/schedule',{cookie})).status,401);
});
test('logout clears the cookie and deletes the KV session; missing config and KV outage never expose data',async()=>{
  const f=fixture(),cookie=await f.login();
  const r=await f.call('/api/logout',{method:'POST',body:{},cookie});assert.equal(r.status,200);assert.match(r.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await f.call('/api/schedule',{cookie})).status,401);
  f.kv.fail=true;assert.equal((await f.call('/api/session',{cookie})).status,503);
  delete f.env.ACCESS_CODE;assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code}})).status,503);
});
test('bad schemas, unconfirmed cycles, ordinary identities and oversized schedules are rejected',async()=>{
  const f=fixture(),cookie=await f.login();
  for(const value of [null,'not json',JSON.stringify({...JSON.parse(a),schemaVersion:2}),'x'.repeat(256*1024+1),
    JSON.stringify({...JSON.parse(a),cycle:{startDate:'2026-11-09',endDate:'2026-11-10'}}),
    a.replaceAll('SYNTHETIC001','ORDINARY001'),a.replace('"OF"','"UNKNOWN"')]) {
    if(value===null)f.kv.values.delete('schedule:active');else f.kv.values.set('schedule:active',{value});
    const r=await f.call('/api/schedule',{cookie});assert.equal(r.status,503);assert.ok(!(await r.text()).includes('合成測試員'));
  }
});
test('old KV snapshots remain old despite no-store; a later read detects B by content revision (simulation only)',async()=>{
  const f=fixture(),cookie=await f.login();f.kv.staleSchedule=a;await f.kv.put('schedule:active',b);
  let r=await f.call('/api/schedule',{cookie});assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal((await r.json()).revision,hash(a));
  f.kv.staleSchedule=null;r=await f.call('/api/schedule',{cookie});assert.equal((await r.json()).revision,hash(b));
});
test('mandatory platform limiter reject excessive login attempts without KV writes',async()=>{
  const f=fixture();f.env.LOGIN_LIMITER=new MemoryLimiter();for(let i=0;i<5;i++)assert.equal((await f.call('/api/login',{method:'POST',body:{code:'x'.repeat(32)}})).status,401);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code}})).status,429);assert.equal(f.kv.writes.length,0);
  const missing=fixture();delete missing.env.LOGIN_LIMITER;assert.equal((await missing.call('/api/login',{method:'POST',body:{code:missing.code}})).status,503);
  const g=fixture();g.env.LOGIN_LIMITER={limit:async()=>({success:false})};assert.equal((await g.call('/api/login',{method:'POST',body:{code:g.code}})).status,429);
});
test('short test sessions keep explicit expiry despite the KV minimum TTL; invalid lifetime is rejected',async()=>{
  const f=fixture();f.env.SESSION_TTL_SECONDS=1;
  const cookie=await f.login(),write=f.kv.writes[0],row=JSON.parse(f.kv.values.get(write.key).value);
  assert.equal(write.options.expirationTtl,60);assert.equal(row.expiresAt-row.createdAt,1000);
  f.env.SESSION_TTL_SECONDS=0;
  assert.equal((await f.call('/api/session',{cookie})).status,503);
  f.env.SESSION_TTL_SECONDS=604801;
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.code}})).status,503);
});
test('authenticated requests still reject cross-origin reads/logout and HTTP; tokens are never in response bodies',async()=>{
  const f=fixture(),cookie=await f.login(),token=cookie.split('=')[1];
  for(const options of [{headers:{Origin:'https://evil.example'}},{headers:{'Sec-Fetch-Site':'cross-site'}}])
    assert.equal((await f.call('/api/schedule',{cookie,...options})).status,403);
  assert.equal((await f.call('/api/logout',{method:'POST',body:{},cookie,origin:'https://evil.example'})).status,403);
  const r=await f.call('/api/schedule',{cookie});assert.equal(r.status,200);assert.ok(!(await r.text()).includes(token));
  assert.equal((await worker.fetch(new Request('http://test.example/api/schedule'),f.env)).status,400);
});

// Passwords below are generated per run; no operator credentials are stored.
test('direct short nurse secret: leading zeros, rotation, legacy sessions and no hash fallback',async()=>{
  const f=fixture(),short='0'+String(crypto.getRandomValues(new Uint32Array(1))[0]%10000).padStart(4,'0');
  f.env.ACCESS_CODE=short;
  const r=await f.call('/api/login',{method:'POST',body:{code:short}});assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.call('/api/session',{cookie})).status,200);
  const key=f.kv.writes.at(-1).key,stored=f.kv.values.get(key).value;
  assert.ok(!stored.includes(short));
  const legacy=JSON.parse(stored);delete legacy.credentialTag;f.kv.values.set(key,{value:JSON.stringify(legacy)});
  assert.equal((await f.call('/api/session',{cookie})).status,401);
  f.kv.values.set(key,{value:stored});f.env.ACCESS_CODE=short+'0';
  assert.equal((await f.call('/api/session',{cookie})).status,401);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:short}})).status,401);
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:f.env.ACCESS_CODE}})).status,200);
  f.env.ACCESS_CODE_SHA256=hash(short);delete f.env.ACCESS_CODE;
  assert.equal((await f.call('/api/login',{method:'POST',body:{code:short}})).status,503);
  for(const invalid of ['',123456,'x'.repeat(4),'x'.repeat(129)]) {
    f.env.ACCESS_CODE=invalid;assert.equal((await f.call('/api/login',{method:'POST',body:{code:short}})).status,503);
  }
});
