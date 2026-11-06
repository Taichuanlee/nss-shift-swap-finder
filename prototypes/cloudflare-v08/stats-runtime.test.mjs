// Actual workerd SQLite and alarms, local only; no Cloudflare account or remote KV.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
test('workerd: SQLite binding, transactional deduplication and automatic alarm cleanup',async()=>{
 const source=await readFile(new URL('./stats-counter.mjs',import.meta.url),'utf8');
 const script=source+`\nexport class RuntimeStats extends SearchStatsCounter {async fetch(r){if(new URL(r.url).pathname==='/inspect')return Response.json({alarm:await this.ctx.storage.getAlarm(),cycles:[...this.sql.exec('SELECT * FROM cycles')]});return super.fetch(r);}}\nexport default {fetch(r,e){return e.SEARCH_STATS.get(e.SEARCH_STATS.idFromName('test')).fetch(r);}};`;
 const options={modules:true,script,compatibilityDate:'2026-10-20',durableObjects:{SEARCH_STATS:{className:'RuntimeStats',useSQLite:true}}};
 const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 const call=body=>mf.dispatchFetch('https://internal/',{method:'POST',body:JSON.stringify(body)});
 try{
  const body={action:'count',eventId:crypto.randomUUID(),employeeId:'a',name:'合成',cycle:'test',start:'2026-11-09',end:'2026-12-06',expires:Date.now()+2000};
  const results=await Promise.all(Array.from({length:8},()=>call(body)));assert.equal((await Promise.all(results.map(r=>r.json()))).filter(r=>r.recorded).length,1);
  assert.equal((await (await call({action:'summary'})).json()).cycles[0].totalSearches,1);
  const inspect=async()=> (await mf.dispatchFetch('https://internal/inspect')).json();
  assert.ok((await inspect()).alarm);
  // No summary request triggers expiry: inspect the platform alarm itself.
  for(let i=0;i<100&&(await inspect()).alarm!==null;i++)await new Promise(r=>setTimeout(r,50));
  assert.equal((await inspect()).alarm,null);assert.deepEqual((await inspect()).cycles,[]);assert.deepEqual((await (await call({action:'summary'})).json()).cycles,[]);
  const attempts=await Promise.all(Array.from({length:20},()=>call({action:'login-attempt'})));assert.equal(attempts.filter(r=>r.status===200).length,5);assert.equal(attempts.filter(r=>r.status===429).length,15);
  const key=await (await call({action:'signing-key'})).json();assert.match(key.key,/^[a-f0-9]{64}$/);assert.deepEqual(await (await call({action:'signing-key'})).json(),key);
 }finally{await mf.dispose();}
});
