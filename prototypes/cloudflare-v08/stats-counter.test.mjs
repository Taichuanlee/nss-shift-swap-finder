// Actual SQLite queries/transactions with a small Cloudflare storage adapter.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {counterFixture} from './stats-test-support.mjs';

const event=(overrides={})=>({action:'count',cycle:'2026-12-07_2027-01-03',start:'2026-12-07',end:'2027-01-03',expires:Date.now()+100000,eventId:crypto.randomUUID(),employeeId:'a',name:'合成人員',...overrides});
test('concurrent retries count once, repeated clicks count separately, selected records stay distinct',async()=>{
  const f=counterFixture(),b=event();
  await Promise.all(Array.from({length:20},()=>f.send(b)));
  await f.send({...b,eventId:crypto.randomUUID()});await f.send({...b,eventId:crypto.randomUUID(),employeeId:'b'});
  const {cycles}=await (await f.send({action:'summary'})).json();
  assert.equal(cycles[0].totalSearches,3);assert.equal(cycles[0].selectedIdentities,2);assert.equal(cycles[0].people[0].searches,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM search_events').get().n,3);
});
test('history survives later cycles and same-cycle revisions; alarm deletes all expired personal data',async()=>{
  const f=counterFixture(),a=event(),b=event({cycle:'2027-01-04_2027-01-31',start:'2027-01-04',end:'2027-01-31',expires:Date.now()+200000});
  await f.send(a);await f.send(b);assert.equal(f.alarm,a.expires);
  assert.equal((await (await f.send({action:'summary'})).json()).cycles.length,2);
  f.db.prepare('UPDATE cycles SET expires=0 WHERE cycle=?').run(a.cycle);await f.object.alarm();
  const summary=await (await f.send({action:'summary'})).json();assert.equal(summary.cycles.length,1);assert.equal(summary.cycles[0].cycleStartDate,b.start);assert.equal(f.alarm,b.expires);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM search_events WHERE cycle=?').get(a.cycle).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM search_counts WHERE cycle=?').get(a.cycle).n,0);
  f.db.prepare('UPDATE cycles SET expires=0').run();await f.object.alarm();assert.equal(f.alarm,null);
  assert.equal((await f.send(event({expires:0}))).status,410);
});
test('counter increment rolls back when a write fails',async()=>{
 const f=counterFixture();f.db.exec("CREATE TRIGGER fail_count BEFORE INSERT ON search_counts BEGIN SELECT RAISE(ABORT, 'failure'); END");
 await assert.rejects(f.send(event()));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM search_events').get().n,0);
});
test('persistent global budget has minute and daily caps, bounded retry and no sliding lockout',async()=>{
 const f=counterFixture(),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try {
  for(let minute=0;minute<20;minute++) {
   for(let i=0;i<5;i++)assert.equal((await f.send({action:'login-attempt'})).status,200);
   assert.equal((await f.send({action:'login-attempt'})).status,429);now+=60000;
  }
  const blocked=await f.send({action:'login-attempt'});assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('Retry-After'))>60);
  now+=86400000;assert.equal((await f.send({action:'login-attempt'})).status,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM login_budget').get().n,2);
 }finally{Date.now=realNow;}
});
test('signing key is random, durable and independent of the PIN',async()=>{
 const f=counterFixture(),a=await (await f.send({action:'signing-key'})).json(),b=await (await f.send({action:'signing-key'})).json();
 assert.match(a.key,/^[a-f0-9]{64}$/);assert.equal(a.key,b.key);
 assert.notEqual(a.key,(await (await counterFixture().send({action:'signing-key'})).json()).key);
});
