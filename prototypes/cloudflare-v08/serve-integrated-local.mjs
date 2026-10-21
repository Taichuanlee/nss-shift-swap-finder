// Local HTTPS demo only: binding doubles, synthetic fixtures, no Cloudflare calls.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {directory,setupLocalSecrets} from './build.mjs';
import {buildIntegrated} from './build-integrated.mjs';
import {MemoryKV,MemoryLimiter,prepare,startLocal} from './local-harness.mjs';
const {a}=await prepare(),pack=await buildIntegrated();await setupLocalSecrets();
const nurse=JSON.parse(await readFile(path.join(directory,'dist/local-secrets.json'),'utf8'));
const adminPath=path.join(directory,'dist/local-admin-secrets.json');
const code=randomBytes(32).toString('base64url'),sha=value=>createHash('sha256').update(value).digest('hex');
try {await writeFile(adminPath,JSON.stringify({code,ADMIN_ACCESS_CODE_SHA256:sha(code)},null,2),{flag:'wx',mode:0o600});}
catch(error){if(error.code!=='EEXIST')throw error;}
const admin=JSON.parse(await readFile(adminPath,'utf8'));
if(typeof admin.code!=='string'||admin.code.length<32||sha(admin.code)!==admin.ADMIN_ACCESS_CODE_SHA256)throw new Error('Local admin credential file is invalid.');
const kv=new MemoryKV();kv.values.set('schedule:active',{value:a});
const worker=(await import(pathToFileURL(path.join(pack.output,'worker.mjs')).href)).default;
const env={SCHEDULE_KV:kv,ACCESS_CODE_SHA256:nurse.ACCESS_CODE_SHA256,ADMIN_ACCESS_CODE_SHA256:admin.ADMIN_ACCESS_CODE_SHA256,
  LOGIN_LIMITER:new MemoryLimiter(),ADMIN_LOGIN_LIMITER:new MemoryLimiter(),SYNTHETIC_ONLY:'true',ASSETS:{fetch:async request=>{
    const file=new URL(request.url).pathname.slice(1);
    if(!pack.inventory.includes(file))return new Response('not found',{status:404});
    return new Response(request.method==='HEAD'?null:await readFile(path.join(pack.assets,file)),{headers:{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream'}});
  }}};
const require=createRequire(import.meta.url),XLSX=require('../../vendor/sheetjs/xlsx.full.min.js'),{pdf}=require('../../tests/fixtures.cjs');
const publication=JSON.parse(a),rows=[['Synthetic 2026-11-09 ~ 2026-12-06'],['ID','Name',...publication.dates],
  ...publication.employees.map(e=>[e.id,e.name,...publication.dates.map(d=>e.shifts[d])])];
const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Synthetic');
await writeFile(path.join(pack.output,'synthetic-import.xlsx'),XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
await writeFile(path.join(pack.output,'synthetic-import.pdf'),pdf([rows]));
const server=await startLocal(env,worker);
console.log(`Local Phase 4B admin: ${server.origin}/admin/login\nNurse UI: ${server.origin}/\nAdmin credential file (private, do not share): ${adminPath}\nNurse credential file (private): ${path.join(directory,'dist/local-secrets.json')}\nSynthetic PDF/Excel: ${pack.output}\nSelf-signed localhost HTTPS. Local limiters/KV are test doubles; published data resets on restart. Ctrl+C to stop.`);
process.on('SIGINT',async()=>{await server.close();process.exit(0);});
