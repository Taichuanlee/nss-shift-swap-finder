// No real staff data or fixed credentials. MemoryKV models both failed and uncertain writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {MemoryKV,prepare} from './local-harness.mjs';
const {worker,a,b}=await prepare(),hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture() {
  const code=randomBytes(32).toString('base64url'),nurse=randomBytes(32).toString('base64url'),kv=new MemoryKV();kv.values.set('schedule:active',{value:a});
  const limiter={limit:async()=>({success:true})},env={SCHEDULE_KV:kv,ACCESS_CODE:nurse,ADMIN_ACCESS_CODE:code,LOGIN_LIMITER:limiter,ADMIN_LOGIN_LIMITER:limiter};
  const call=(route,{method='GET',body,cookie,origin='https://test.example',headers={}}={})=>worker.fetch(new Request('https://test.example'+route,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const login=await call('/api/admin/login',{method:'POST',body:{code}});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];kv.writes.length=0;
  const publish=(payload=JSON.parse(b),options={})=>call('/api/admin/publish',{method:'POST',body:payload,cookie,...options});
  return {code,nurse,kv,env,call,cookie,publish};
}
test('publication: backend revalidation, one put, no delete, server timestamp, all dates and nurse adapter',async()=>{
  const f=await fixture(),deletes=[];f.kv.delete=async key=>{deletes.push(key);};
  const submitted=JSON.parse(b);submitted.publishedAt='2000-01-01T00:00:00.000Z';
  const result=await f.publish(submitted);assert.equal(result.status,200);const receipt=await result.json();
  assert.equal(receipt.published,true);assert.match(receipt.contentHash,/^[a-f0-9]{64}$/);assert.equal(f.kv.writes.length,1);
  assert.equal(f.kv.writes[0].key,'schedule:active');assert.equal(f.kv.writes[0].options,undefined);assert.deepEqual(deletes,[]);
  const saved=JSON.parse(f.kv.values.get('schedule:active').value);assert.notEqual(saved.publishedAt,submitted.publishedAt);
  assert.deepEqual(saved.dates,submitted.dates);assert.deepEqual(saved.employees,submitted.employees);assert.equal(saved.dates.length,40);
  assert.equal(receipt.revision,hash(JSON.stringify(saved)));
  const check=await f.call('/api/admin/publication',{cookie:f.cookie}),state=await check.json();
  assert.equal(state.contentHash,receipt.contentHash);assert.deepEqual(Object.keys(state).sort(),['contentHash','publishedAt']);
  const login=await f.call('/api/login',{method:'POST',body:{code:f.nurse}}),cookie=login.headers.get('set-cookie').split(';')[0];
  const data=await (await f.call('/api/schedule',{cookie})).json();assert.deepEqual(data.payload,saved);assert.equal(data.revision,receipt.revision);
});
test('publication: unauthorized, nurse cookies, Origin/method/content type and expiry cannot write',async()=>{
  const f=await fixture();
  assert.equal((await f.publish(undefined,{cookie:undefined})).status,401);
  const nurse=await f.call('/api/login',{method:'POST',body:{code:f.nurse}}),cookie=nurse.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.publish(undefined,{cookie})).status,401);
  assert.equal((await f.call('/api/admin/publication',{cookie})).status,401);
  assert.equal((await f.publish(undefined,{origin:'https://evil.example'})).status,403);
  assert.equal((await f.publish(undefined,{headers:{Origin:''}})).status,403);
  assert.equal((await f.publish(undefined,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.call('/api/admin/publish',{cookie:f.cookie})).status,405);
  assert.equal((await f.publish(undefined,{headers:{'Content-Type':'text/plain'}})).status,415);
  const key='admin-session:'+hash(f.cookie.split('=')[1]),row=JSON.parse(f.kv.values.get(key).value);row.expiresAt=Date.now()-1;row.createdAt=row.expiresAt-1000;f.kv.values.set(key,{value:JSON.stringify(row)});
  assert.equal((await f.publish()).status,401);assert.equal(f.kv.values.get('schedule:active').value,a);
  assert.equal(f.kv.writes.filter(w=>w.key==='schedule:active').length,0);
});
test('publication: forged flags, invalid dates/identities/shifts, bounded sizes and synthetic guard retain A',async()=>{
  const f=await fixture();
  const mutations=[p=>p.validationPassed=true,p=>p.cycle.endDate=p.cycle.startDate,p=>p.dates.splice(10,1),
    p=>p.employees[1].id=p.employees[0].id,p=>p.employees[0].shifts[p.dates[0]]='UNKNOWN',
    p=>delete p.employees[0].shifts[p.dates[0]],p=>p.employees[0].name='',p=>p.employees[0].id='ORDINARY001',
    p=>p.employees[0].name='x'.repeat(129),p=>p.schemaVersion=99,p=>p.dates=Array(367).fill(p.dates[0])];
  for(const mutate of mutations){const payload=JSON.parse(b);mutate(payload);assert.equal((await f.publish(payload)).status,422);}
  assert.equal((await f.publish({oversize:'x'.repeat(256*1024)})).status,413);
  const malformed=await worker.fetch(new Request('https://test.example/api/admin/publish',{method:'POST',headers:{Origin:'https://test.example','Content-Type':'application/json',Cookie:f.cookie},body:'{' }),f.env);
  assert.equal(malformed.status,400);assert.equal(f.kv.writes.length,0);assert.equal(f.kv.values.get('schedule:active').value,a);
});
test('publication: write rejected before storage retains A; write-then-error may leave B and is unconfirmed',async()=>{
  const f=await fixture(),put=f.kv.put.bind(f.kv);
  f.kv.put=async()=>{throw new Error('do not expose internal error');};
  let response=await f.publish();assert.equal(response.status,503);assert.equal((await response.json()).error,'publication_unconfirmed');
  assert.equal(f.kv.values.get('schedule:active').value,a);
  f.kv.put=async(...args)=>{await put(...args);throw new Error('ack lost');};
  response=await f.publish();assert.equal(response.status,503);
  assert.deepEqual(JSON.parse(f.kv.values.get('schedule:active').value).employees,JSON.parse(b).employees);assert.equal(f.kv.writes.length,1);
  const state=await (await f.call('/api/admin/publication',{cookie:f.cookie})).json();assert.match(state.contentHash,/^[a-f0-9]{64}$/);
});
test('publication: limiter/config failure and revoked/rotated admin sessions fail closed',async()=>{
  const f=await fixture();f.env.ADMIN_LOGIN_LIMITER={limit:async()=>({success:false})};assert.equal((await f.publish()).status,429);
  f.env.ADMIN_LOGIN_LIMITER={limit:async()=>{throw new Error('limiter unavailable');}};assert.equal((await f.publish()).status,503);
  delete f.env.ADMIN_LOGIN_LIMITER;assert.equal((await f.publish()).status,503);
  f.env.ADMIN_LOGIN_LIMITER={limit:async()=>({success:true})};f.env.ADMIN_ACCESS_CODE=randomBytes(32).toString('base64url');
  assert.equal((await f.publish()).status,401);assert.equal((await f.call('/api/admin/session',{cookie:f.cookie})).status,401);
  assert.equal(f.kv.writes.length,0);assert.equal(f.kv.values.get('schedule:active').value,a);
  const g=await fixture();await g.call('/api/admin/logout',{method:'POST',body:{},cookie:g.cookie});assert.equal((await g.publish()).status,401);
});
test('publication: session is checked again after slow body reading, before touching active data',async()=>{
  const f=await fixture(),bytes=new TextEncoder().encode(b),key='admin-session:'+hash(f.cookie.split('=')[1]);
  const stream=new ReadableStream({start(controller){controller.enqueue(bytes);},pull(controller){f.kv.values.delete(key);controller.close();}});
  const request=new Request('https://test.example/api/admin/publish',{method:'POST',headers:{Origin:'https://test.example','Content-Type':'application/json',Cookie:f.cookie},body:stream,duplex:'half'});
  assert.equal((await worker.fetch(request,f.env)).status,401);assert.equal(f.kv.writes.length,0);assert.equal(f.kv.values.get('schedule:active').value,a);
});
test('publication: cached old snapshot is inconclusive, not an instruction to republish or roll back',async()=>{
  const f=await fixture(),before=await (await f.call('/api/admin/publication',{cookie:f.cookie})).json();
  const receipt=await (await f.publish()).json();f.kv.staleSchedule=a;
  assert.equal((await (await f.call('/api/admin/publication',{cookie:f.cookie})).json()).contentHash,before.contentHash);
  f.kv.staleSchedule=null;assert.equal((await (await f.call('/api/admin/publication',{cookie:f.cookie})).json()).contentHash,receipt.contentHash);
  assert.equal(f.kv.writes.length,1);
});

test('publication: blank and partial schedules keep identities across admin publish and nurse read',async()=>{
 const f=await fixture(),payload=JSON.parse(b),days=payload.dates;
 payload.employees[0].shifts[days[0]]='';payload.employees[1].shifts=Object.fromEntries(days.map(d=>[d,'']));
 const published=await f.publish(payload);assert.equal(published.status,200);
 const login=await f.call('/api/login',{method:'POST',body:{code:f.nurse}}),cookie=login.headers.get('set-cookie').split(';')[0];
 const read=await f.call('/api/schedule',{cookie});assert.equal(read.status,200);
 const saved=(await read.json()).payload;assert.deepEqual(saved.employees,payload.employees);
 assert.equal((await f.call('/api/schedule')).status,401);
 assert.equal((await f.publish(payload,{cookie})).status,401);
 const bad=structuredClone(payload);bad.employees[0].shifts[days[1]]='UNKNOWN';assert.equal((await f.publish(bad)).status,422);
});
