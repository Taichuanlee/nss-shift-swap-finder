import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {MemoryKV,prepare} from './local-harness.mjs';
import {counterFixture} from './stats-test-support.mjs';
const {worker,a}=await prepare();
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const kv=new MemoryKV(),counter=counterFixture();kv.values.set('schedule:active',{value:a});
 const yes={limit:async()=>({success:true})};
 const env={SCHEDULE_KV:kv,ACCESS_CODE:'nurse-test',ADMIN_ACCESS_CODE:'admin-test',STATS_ACCESS_CODE:'024681',LOGIN_LIMITER:yes,STATS_LOGIN_LIMITER:yes,STATS_EVENT_LIMITER:yes,SEARCH_STATS:{idFromName:n=>n,get:()=>counter.object}};
 const call=(path,{body,cookie,origin='https://test.example',method=body===undefined?'GET':'POST',headers={}}={})=>worker.fetch(new Request('https://test.example'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 const login=async(path,code)=>(await call(path,{body:{code}})).headers.get('Set-Cookie').split(';')[0];
 const event=()=>({eventId:crypto.randomUUID(),employeeId:'SYNTHETIC001',revision:hash(a)});
 return {env,kv,counter,call,login,event};
}
test('events require nurse session, same origin, current revision and selected employee; no KV writes',async()=>{
 const f=fixture(),body=f.event();assert.equal((await f.call('/api/stats/events',{body})).status,401);
 const cookie=await f.login('/api/login',f.env.ACCESS_CODE),writes=f.kv.writes.length;
 for(const [patch,status] of [[{eventId:'bad'},422],[{employeeId:'unknown'},422],[{revision:'bad'},409]])assert.equal((await f.call('/api/stats/events',{body:{...body,...patch},cookie})).status,status);
 assert.equal((await f.call('/api/stats/events',{body,cookie,origin:'https://evil.example'})).status,403);
 assert.equal((await f.call('/api/stats/events',{body,cookie,headers:{'Content-Type':'text/plain'}})).status,415);
 const r=await f.call('/api/stats/events',{body,cookie});assert.equal(r.status,200);assert.equal((await r.json()).recorded,true);
 assert.equal((await (await f.call('/api/stats/events',{body,cookie})).json()).recorded,false);
 assert.equal((await (await f.call('/api/stats/events',{body:f.event(),cookie})).json()).recorded,true);
 assert.equal(f.kv.writes.length,writes);assert.equal(f.kv.values.get('schedule:active').value,a);
 const stats=(await (await f.counter.send({action:'summary'})).json()).cycles[0];assert.equal(stats.totalSearches,2);assert.equal(stats.selectedIdentities,1);
 assert.equal(stats.expiresAt,new Date(Date.parse(stats.cycleEndDate+'T16:00:00Z')+180*86400000).toISOString());
 f.env.STATS_EVENT_LIMITER={limit:async()=>({success:false})};assert.equal((await f.call('/api/stats/events',{body:f.event(),cookie})).status,429);
});
test('statistics auth is separate, signed, limited, expiring and no-store; nurse/admin cannot read',async()=>{
 const f=fixture(),nurse=await f.login('/api/login',f.env.ACCESS_CODE);
 assert.equal((await f.call('/api/stats/summary',{cookie:nurse})).status,401);
 for(const code of [f.env.ACCESS_CODE,f.env.ADMIN_ACCESS_CODE])assert.equal((await f.call('/api/stats/login',{body:{code}})).status,401);
 const r=await f.call('/api/stats/login',{body:{code:f.env.STATS_ACCESS_CODE}}),set=r.headers.get('Set-Cookie'),cookie=set.split(';')[0];
 assert.match(set,/HttpOnly; SameSite=Strict; Max-Age=900/);
 const summary=await f.call('/api/stats/summary',{cookie});assert.equal(summary.status,200);assert.equal(summary.headers.get('Cache-Control'),'no-store');assert.equal((await summary.json()).cycles[0].totalSearches,0);
 assert.equal((await f.call('/api/stats/summary',{cookie:cookie+'x'})).status,401);
 assert.equal((await f.call('/api/stats/summary',{cookie:cookie+'; '+cookie})).status,401);
 assert.equal((await f.call('/api/stats/summary',{cookie:cookie.replace(/=\d+/, '=1000000000000')})).status,401);
 assert.equal((await f.call('/api/stats/summary',{cookie,origin:'https://evil.example'})).status,403);
 const writes=f.kv.writes.length;assert.equal((await f.call('/api/stats/logout',{cookie,body:{}})).status,200);assert.equal(f.kv.writes.length,writes);assert.equal((await f.call('/api/stats/summary',{cookie})).status,401);assert.equal((await f.call('/api/stats/summary',{cookie:cookie+'; '+nurse})).status,401);
 const newCookie=await f.login('/api/stats/login',f.env.STATS_ACCESS_CODE);
 const actualNow=Date.now;try{Date.now=()=>actualNow()+900001;assert.equal((await f.call('/api/stats/summary',{cookie:newCookie})).status,401);}finally{Date.now=actualNow;}
 f.env.STATS_ACCESS_CODE='135790';assert.equal((await f.call('/api/stats/summary',{cookie:newCookie})).status,401);
 f.env.STATS_LOGIN_LIMITER={limit:async()=>({success:false})};assert.equal((await f.call('/api/stats/login',{body:{code:f.env.STATS_ACCESS_CODE}})).status,429);
});
test('statistics failure leaves schedule serving intact and configuration fails closed',async()=>{
 const f=fixture(),cookie=await f.login('/api/login',f.env.ACCESS_CODE);
 f.env.SEARCH_STATS.get=()=>{throw Error('outage');};assert.equal((await f.call('/api/stats/events',{body:f.event(),cookie})).status,503);
 assert.equal((await f.call('/api/schedule',{cookie})).status,200);
 f.env.STATS_ACCESS_CODE=f.env.ACCESS_CODE;assert.equal((await f.call('/api/stats/login',{body:{code:f.env.ACCESS_CODE}})).status,503);
});
test('PIN format is exact ASCII digits, preserves leading zeroes and rejects both role collisions',async()=>{
 for(const code of ['12345','1234567','１２３４５６','12345a',' 123456','123456\n',123456,null]) {
  const f=fixture();assert.equal((await f.call('/api/stats/login',{body:{code}})).status,401);
  f.env.STATS_ACCESS_CODE=code;assert.equal((await f.call('/api/stats/login',{body:{code}})).status,503);
 }
 for(const role of ['ACCESS_CODE','ADMIN_ACCESS_CODE']) {
  const f=fixture();f.env[role]=f.env.STATS_ACCESS_CODE;
  assert.equal((await f.call('/api/stats/login',{body:{code:f.env.STATS_ACCESS_CODE}})).status,503);
 }
 assert.equal((await fixture().call('/api/stats/login',{body:{code:'024681'}})).status,200);
});
test('global budget bounds concurrent guesses across IPs even when platform limiter allows all',async()=>{
 const f=fixture();const results=await Promise.all(Array.from({length:20},(_,i)=>f.call('/api/stats/login',{body:{code:'999999'},headers:{'CF-Connecting-IP':`192.0.2.${i}`}})));
 assert.equal(results.filter(r=>r.status===401).length,5);assert.equal(results.filter(r=>r.status===429).length,15);
 assert.equal((await f.call('/api/stats/login',{body:{code:f.env.STATS_ACCESS_CODE}})).status,429);
 const g=fixture(),seen=[];g.env.STATS_LOGIN_LIMITER={limit:async({key})=>{seen.push(key);return {success:!key.startsWith('stats-ip:')};}};
 assert.equal((await g.call('/api/stats/login',{body:{code:g.env.STATS_ACCESS_CODE}})).status,429);assert.deepEqual(seen,['stats-account','stats-ip:local']);
});

test('knowing the PIN alone cannot forge a session signed with the private DO key',async()=>{
 const f=fixture(),value=(Date.now()+900000)+'.'+'a'.repeat(32);
 const signature=createHmac('sha256',f.env.STATS_ACCESS_CODE).update('stats-v1:'+value).digest('hex');
 assert.equal((await f.call('/api/stats/summary',{cookie:'__Host-ssf-stats='+value+'.'+signature})).status,401);
});
