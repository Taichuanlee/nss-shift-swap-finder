import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MemoryKV,prepare} from './local-harness.mjs';
import {counterFixture} from './stats-test-support.mjs';
const {worker,a}=await prepare();
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const kv=new MemoryKV(),counter=counterFixture();kv.values.set('schedule:active',{value:a});
 const yes={limit:async()=>({success:true})};
 const env={SCHEDULE_KV:kv,ACCESS_CODE:'nurse-test',ADMIN_ACCESS_CODE:'admin-test',STATS_ACCESS_CODE:'separate-stats-secret-test',LOGIN_LIMITER:yes,STATS_LOGIN_LIMITER:yes,STATS_EVENT_LIMITER:yes,SEARCH_STATS:{idFromName:n=>n,get:()=>counter.object}};
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
 f.env.STATS_ACCESS_CODE='rotated-stats-secret-123456';assert.equal((await f.call('/api/stats/summary',{cookie:newCookie})).status,401);
 f.env.STATS_LOGIN_LIMITER={limit:async()=>({success:false})};assert.equal((await f.call('/api/stats/login',{body:{code:f.env.STATS_ACCESS_CODE}})).status,429);
});
test('statistics failure leaves schedule serving intact and configuration fails closed',async()=>{
 const f=fixture(),cookie=await f.login('/api/login',f.env.ACCESS_CODE);
 f.env.SEARCH_STATS.get=()=>{throw Error('outage');};assert.equal((await f.call('/api/stats/events',{body:f.event(),cookie})).status,503);
 assert.equal((await f.call('/api/schedule',{cookie})).status,200);
 f.env.STATS_ACCESS_CODE=f.env.ACCESS_CODE;assert.equal((await f.call('/api/stats/login',{body:{code:f.env.ACCESS_CODE}})).status,503);
});
