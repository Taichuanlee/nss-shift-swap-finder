import {cycleKey,selectedEmployee,validEventId} from './stats-core.mjs';
export {SearchStatsCounter} from './stats-counter.mjs';
// Built with the unchanged publication runtime and public UI by build.mjs.
const COOKIE='__Host-nss-ssf-test';
const MAX_SCHEDULE_BYTES=256*1024;
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const digest=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const cookie=(value,age)=>`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function response(body,status=200,extra={}) {
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
}
async function readBody(request,limit) {
  if(Number(request.headers.get('content-length'))>limit)throw new Error('size');
  const reader=request.body?.getReader();if(!reader)throw new Error('body');
  let size=0;const chunks=[];
  try {
    for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('size');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
// Secrets contain the operator's password, never a client-side hash.
const validCode=value=>typeof value==='string'&&value.length>=5&&value.length<=128;
async function matchesCode(code,secret) {
  const actual=await digest(code),expected=await digest(secret);let difference=0;
  for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^expected.charCodeAt(i);
  return difference===0;
}
function settings(env) {
  const ttl=Number(env.SESSION_TTL_SECONDS ?? 3600);
  if(!Number.isInteger(ttl)||ttl<1||ttl>604800||!validCode(env.ACCESS_CODE)||!env.SCHEDULE_KV||!env.LOGIN_LIMITER?.limit)throw new Error('configuration');
  return {ttl};
}
async function session(request,env,now) {
  const matches=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${COOKIE}=`));
  if(matches.length!==1)return null;
  const token=matches[0].slice(COOKIE.length+1);
  if(!/^[0-9a-f]{64}$/.test(token))return null;
  const key=`session:${await digest(token)}`;
  // Do not set cacheTtl for sessions; explicit expiry is always checked below.
  const raw=await env.SCHEDULE_KV.get(key);
  if(!raw)return null;
  let value;try {value=JSON.parse(raw);}catch{return null;}
  if(value?.credentialTag!==await digest('nurse:'+env.ACCESS_CODE)||value?.version!==1||!Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.createdAt)||
    value.createdAt>now||value.expiresAt<=now||value.expiresAt-value.createdAt>604800000)return null;
  return {key,expiresAt:value.expiresAt};
}
// Admin credentials and publication permissions are separate from nurse sessions.
const ADMIN_COOKIE='__Host-nss-ssf-admin';
const adminCookie=(value,age)=>`${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function adminSettings(env) {
  const ttl=Number(env.ADMIN_SESSION_TTL_SECONDS ?? 3600);
  if(!Number.isInteger(ttl)||ttl<1||ttl>3600||!env.SCHEDULE_KV||
    !validCode(env.ADMIN_ACCESS_CODE)||
    env.ADMIN_ACCESS_CODE===env.ACCESS_CODE||!env.ADMIN_LOGIN_LIMITER?.limit)throw new Error('admin_configuration');
  return {ttl};
}
async function adminSession(request,env,now) {
  const entries=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${ADMIN_COOKIE}=`));
  if(entries.length!==1)return null;
  const token=entries[0].slice(ADMIN_COOKIE.length+1);if(!/^[0-9a-f]{64}$/.test(token))return null;
  const key=`admin-session:${await digest(token)}`,raw=await env.SCHEDULE_KV.get(key);
  let value;try {value=JSON.parse(raw);}catch{return null;}
  if(value?.credentialTag!==await digest('admin:'+env.ADMIN_ACCESS_CODE)||value?.role!=='admin'||value.version!==1||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||
    value.createdAt>now||value.expiresAt<=now||value.expiresAt<=value.createdAt||value.expiresAt-value.createdAt>3600000)return null;
  return {key,expiresAt:value.expiresAt};
}
async function adminAPI(request,env,url,now) {
  const expected=['/api/admin/session','/api/admin/publication'].includes(url.pathname)?'GET':'POST';
  if(request.method!==expected)return response({error:'method_not_allowed'},405,{Allow:expected});
  if((request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site'||
    (expected==='POST'&&request.headers.get('Origin')!==url.origin))return response({error:'origin_rejected'},403);
  const {ttl}=adminSettings(env);
  if(url.pathname==='/api/admin/login') {
    // Platform limiter, never KV counters or an isolate-local fallback. Both IP and
    // shared account keys are bounded; Cloudflare limits remain approximate/per-colo.
    for(const key of [`admin-ip:${request.headers.get('CF-Connecting-IP')||'local'}`,'admin-account']) {
      if(!(await env.ADMIN_LOGIN_LIMITER.limit({key})).success)return response({error:'too_many_attempts'},429,{'Retry-After':'60'});
    }
    if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return response({error:'json_required'},415);
    let body;try {body=await readBody(request,1024);}catch{return response({error:'invalid_request'},400);}
    if(!validCode(body?.code))return response({error:'invalid_code'},401);
    if(!await matchesCode(body.code,env.ADMIN_ACCESS_CODE))return response({error:'invalid_code'},401);
    // Rotate an existing admin session on login.
    const previous=await adminSession(request,env,now);if(previous)await env.SCHEDULE_KV.delete(previous.key);
    const token=hex(crypto.getRandomValues(new Uint8Array(32))),expiresAt=now+ttl*1000;
    await env.SCHEDULE_KV.put(`admin-session:${await digest(token)}`,JSON.stringify({version:1,role:'admin',credentialTag:await digest('admin:'+env.ADMIN_ACCESS_CODE),createdAt:now,expiresAt}),{expirationTtl:Math.max(60,ttl)});
    return response({authenticated:true,expiresAt:new Date(expiresAt).toISOString()},200,{'Set-Cookie':adminCookie(token,ttl)});
  }
  const active=await adminSession(request,env,now);
  if(url.pathname==='/api/admin/logout') {
    if(active)await env.SCHEDULE_KV.delete(active.key);
    return response({authenticated:false},200,{'Set-Cookie':adminCookie('',0)});
  }
  if(!active)return response({error:'unauthorized'},401,{'Set-Cookie':adminCookie('',0)});
  if(url.pathname==='/api/admin/publish')return publish(request,env);
  if(url.pathname==='/api/admin/publication') {
    const current=await readSchedule(env);if(current instanceof Response)return current;
    return response({contentHash:await contentHash(current.payload),publishedAt:current.payload.publishedAt});
  }
  return response({authenticated:true,expiresAt:new Date(active.expiresAt).toISOString()});
}
// Bound work before the shared adapter revalidates every date/identity/shift.
function validatedPublication(payload,env) {
  if(!Array.isArray(payload?.dates)||payload.dates.length>366||!Array.isArray(payload.employees)||payload.employees.length>1000||
    payload.employees.some(e=>typeof e?.id!=='string'||e.id.length>128||typeof e.name!=='string'||e.name.length>128))throw new Error('invalid');
  const model=publicationRuntime.SchedulePublication.load(payload);
  if(env.SYNTHETIC_ONLY!=='false'&&!model.employees.every(e=>(/^SYNTHETIC\d+$/.test(e.employeeNumber??'')||(e.employeeNumber===null&&/^SYNTHETIC\d+$/.test(model.importScope??'')))&&e.name.startsWith('合成')))throw new Error('synthetic_only');
  return publicationRuntime.SchedulePublication.create(model,{version:payload.schemaVersion});
}
async function contentHash(payload) {
  // Stable content identity ignores the server-assigned publication timestamp.
  const canonical=publicationRuntime.SchedulePublication.create(publicationRuntime.SchedulePublication.load(payload),{version:payload.schemaVersion});
  canonical.publishedAt='1970-01-01T00:00:00.000Z';return digest(JSON.stringify(canonical));
}
async function readSchedule(env) {
  const raw=await env.SCHEDULE_KV.get('schedule:active',{cacheTtl:30});
  if(raw===null)return response({error:'schedule_not_available'},503);
  if(typeof raw!=='string'||encoder.encode(raw).byteLength>MAX_SCHEDULE_BYTES)return response({error:'invalid_schedule'},503);
  try {const payload=JSON.parse(raw);validatedPublication(payload,env);return {raw,payload};}
  catch {return response({error:'invalid_schedule'},503);}
}
async function publish(request,env) {
  if(!(await env.ADMIN_LOGIN_LIMITER.limit({key:'admin-publish'})).success)return response({error:'too_many_attempts'},429,{'Retry-After':'60'});
  if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return response({error:'json_required'},415);
  let submitted;
  try {submitted=await readBody(request,MAX_SCHEDULE_BYTES);}
  catch(error){return response({error:error.message==='size'?'publication_too_large':'invalid_publication'},error.message==='size'?413:400);}
  let payload;
  try {payload=validatedPublication(submitted,env);}
  catch(error){return response({error:error.message==='synthetic_only'?'synthetic_only':'invalid_publication'},422);}
  const raw=JSON.stringify(payload);
  if(encoder.encode(raw).byteLength>MAX_SCHEDULE_BYTES)return response({error:'publication_too_large'},413);
  const revision=await digest(raw),fingerprint=await contentHash(payload);
  // Body reading may outlive a session. Recheck immediately before the only write.
  if(!await adminSession(request,env,Date.now()))return response({error:'unauthorized'},401,{'Set-Cookie':adminCookie('',0)});
  try {await env.SCHEDULE_KV.put('schedule:active',raw);}
  catch {return response({error:'publication_unconfirmed'},503);}
  return response({published:true,revision,contentHash:fingerprint,publishedAt:payload.publishedAt});
}
async function handle(request,env) {
  const url=new URL(request.url),now=Date.now();
  if(url.protocol!=='https:')return response({error:'https_required'},400);
  if(url.pathname.startsWith('/api/stats/'))return statsAPI(request,env,url,now);
  if(['/api/admin/login','/api/admin/logout','/api/admin/session','/api/admin/publish','/api/admin/publication'].includes(url.pathname))return adminAPI(request,env,url,now);
  if(url.pathname.startsWith('/api/admin/'))return response({error:'not_found'},404);
  const adminPage=['/admin','/admin/','/admin.html'].includes(url.pathname);
  const loginPage=['/admin/login','/admin-login.html'].includes(url.pathname);
  if(adminPage) {
    adminSettings(env);
    if(!await adminSession(request,env,now))return new Response(null,{status:303,headers:{Location:'/admin/login','Cache-Control':'no-store'}});
  }
  if(SSF_PATHS.size && !url.pathname.startsWith('/api/')) {
    if(!['GET','HEAD'].includes(request.method))return response({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    if(!SSF_PATHS.has(url.pathname))return response({error:'not_found'},404);
    if(!env.ASSETS)return response({error:'assets_not_configured'},503);
    const assetURL=new URL(request.url);
    if(url.pathname==='/')assetURL.pathname='/index.html';
    if(adminPage)assetURL.pathname='/admin.html';else if(loginPage)assetURL.pathname='/admin-login.html';
    const asset=await env.ASSETS.fetch(new Request(assetURL,request));
    const headers=new Headers(asset.headers);
    headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
    if(asset.headers.get('Content-Type')?.includes('text/html')) {
      headers.set('Cache-Control','no-store');
      headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    return new Response(asset.body,{status:asset.status,headers});
  }
  if(request.method==='GET' && (url.pathname==='/'||url.pathname==='/app.js')) {
    return new Response(url.pathname==='/'?INDEX_HTML:APP_JS,{headers:{
      'Content-Type':url.pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
  }
  if(!['/api/login','/api/logout','/api/session','/api/schedule'].includes(url.pathname))return response({error:'not_found'},404);
  const expected=['/api/login','/api/logout'].includes(url.pathname)?'POST':'GET';
  if(request.method!==expected)return response({error:'method_not_allowed'},405,{Allow:expected});
  // No cross-origin API access. Require exact Origin on every state-changing call.
  if((request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)||
    request.headers.get('Sec-Fetch-Site')==='cross-site'||
    (expected==='POST'&&request.headers.get('Origin')!==url.origin))return response({error:'origin_rejected'},403);
  const {ttl}=settings(env);
  if(url.pathname==='/api/login') {
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    const allowed=(await env.LOGIN_LIMITER.limit({key:ip})).success;
    if(!allowed)return response({error:'too_many_attempts'},429,{'Retry-After':'60'});
    if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return response({error:'json_required'},415);
    let body;try {body=await readBody(request,1024);}catch{return response({error:'invalid_request'},400);}
    if(!validCode(body?.code))return response({error:'invalid_code'},401);
    if(!await matchesCode(body.code,env.ACCESS_CODE))return response({error:'invalid_code'},401);
    const token=hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt=now+ttl*1000;
    await env.SCHEDULE_KV.put(`session:${await digest(token)}`,JSON.stringify({version:1,credentialTag:await digest('nurse:'+env.ACCESS_CODE),createdAt:now,expiresAt}),{expirationTtl:Math.max(60,ttl)});
    return response({authenticated:true,expiresAt:new Date(expiresAt).toISOString()},200,{'Set-Cookie':cookie(token,ttl)});
  }
  const active=await session(request,env,now);
  if(url.pathname==='/api/logout') {
    if(active)await env.SCHEDULE_KV.delete(active.key);
    return response({authenticated:false},200,{'Set-Cookie':cookie('',0)});
  }
  if(!active)return response({error:'unauthorized'},401,{'Set-Cookie':cookie('',0)});
  if(url.pathname==='/api/session')return response({authenticated:true,expiresAt:new Date(active.expiresAt).toISOString()});
  const current=await readSchedule(env);if(current instanceof Response)return current;
  const {raw,payload}=current;
  return response({revision:await digest(raw),observedAt:new Date(now).toISOString(),colo:request.cf?.colo||'local',
    expiresAt:new Date(active.expiresAt).toISOString(),payload});
}
export default {
  async fetch(request,env) {
    try {return await handle(request,env);}catch {return response({error:'service_unavailable'},503);}
  }
};

// Statistics auth uses a separate secret and signed, short-lived cookie; no KV writes.
const validStatsCode=value=>typeof value==='string'&&value.length===6&&/^[0-9]{6}$/.test(value);
const STATS_COOKIE='__Host-ssf-stats';
const statsCookieValue=request=>(request.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(STATS_COOKIE+'='))||'';
async function statsSignature(env,value) {
  const rootResponse=await env.SEARCH_STATS.get(env.SEARCH_STATS.idFromName('cycle-search-stats-v1')).fetch(new Request('https://stats.internal/',{method:'POST',body:JSON.stringify({action:'signing-key'})}));
  if(!rootResponse.ok)throw Error('stats_unavailable');
  const {key:root}=await rootResponse.json();
  if(typeof root!=='string'||!/^[a-f0-9]{64}$/.test(root))throw Error('stats_unavailable');
  const key=await crypto.subtle.importKey('raw',encoder.encode(root),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode('stats-v2:'+env.STATS_ACCESS_CODE+':'+value)));
}
async function statsSession(request,env,now) {
  const entries=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(STATS_COOKIE+'='));
  if(entries.length!==1)return false;
  const token=entries[0].slice(STATS_COOKIE.length+1),parts=token.split('.');
  if(parts.length!==3||!/^\d{13}$/.test(parts[0])||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{64}$/.test(parts[2]))return false;
  const expiry=Number(parts[0]);if(expiry<=now||expiry>now+900000)return false;
  const expected=await statsSignature(env,parts.slice(0,2).join('.'));let diff=0;
  for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^parts[2].charCodeAt(i);
  return diff===0?expiry:false;
}
async function statsAPI(request,env,url,now) {
  const path=url.pathname;
  const method=path==='/api/stats/summary'?'GET':'POST';
  if(!['/api/stats/login','/api/stats/logout','/api/stats/summary','/api/stats/events'].includes(path))return response({error:'not_found'},404);
  if(request.method!==method)return response({error:'method_not_allowed'},405,{Allow:method});
  if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)||(method==='POST'&&request.headers.get('Origin')!==url.origin))return response({error:'origin_rejected'},403);
  const stub=()=>env.SEARCH_STATS.get(env.SEARCH_STATS.idFromName('cycle-search-stats-v1'));
  if(path==='/api/stats/events') {
    settings(env);
    const active=await session(request,env,now);
    if(!active)return response({error:'unauthorized'},401);
    if(!env.STATS_EVENT_LIMITER?.limit||!env.SEARCH_STATS)return response({error:'stats_unavailable'},503);
    for(const key of ['stats-session:'+active.key,'stats-ip:'+(request.headers.get('CF-Connecting-IP')||'local')])if(!(await env.STATS_EVENT_LIMITER.limit({key})).success)return response({error:'too_many_requests'},429);
    if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return response({error:'json_required'},415);
    let body;try {body=await readBody(request,1024);}catch{return response({error:'invalid_request'},400);}
    if(!validEventId(body?.eventId))return response({error:'invalid_event'},422);
    const current=await readSchedule(env);if(current instanceof Response)return current;
    if(body.revision!==await digest(current.raw))return response({error:'stale_publication'},409);
    let model,employee,key;try {
      model=publicationRuntime.SchedulePublication.load(current.payload);key=cycleKey(model);employee=selectedEmployee(model,body.employeeId);
    }catch{return response({error:'invalid_event'},422);}
    // Retain until 180 full days after the final cycle day (Taipei UTC+8).
    const expires=Date.parse(model.cycleEndDate+'T16:00:00Z')+180*86400000;
    if(expires<=now)return response({error:'expired_cycle'},410);
    if(!await session(request,env,Date.now()))return response({error:'unauthorized'},401);
    const result=await stub().fetch(new Request('https://stats.internal/',{method:'POST',body:JSON.stringify({action:'count',cycle:key,start:model.cycleStartDate,end:model.cycleEndDate,expires,eventId:body.eventId,employeeId:employee.id,name:employee.name||''})}));
    return response(await result.json(),result.status);
  }
  if(!validStatsCode(env.STATS_ACCESS_CODE)||[env.ACCESS_CODE,env.ADMIN_ACCESS_CODE].includes(env.STATS_ACCESS_CODE)||!env.STATS_LOGIN_LIMITER?.limit||!env.SEARCH_STATS)return response({error:'stats_not_configured'},503);
  const clear=`${STATS_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  if(path==='/api/stats/logout') {
    const expires=await statsSession(request,env,now);
    if(expires)await stub().fetch(new Request('https://stats.internal/',{method:'POST',body:JSON.stringify({action:'revoke',token:await digest(statsCookieValue(request)),expires})}));
    return response({authenticated:false},200,{'Set-Cookie':clear});
  }
  if(path==='/api/stats/login') {
    for(const key of ['stats-account','stats-ip:'+(request.headers.get('CF-Connecting-IP')||'local')])if(!(await env.STATS_LOGIN_LIMITER.limit({key})).success)return response({error:'too_many_attempts'},429,{'Retry-After':'60'});
    const budget=await stub().fetch(new Request('https://stats.internal/',{method:'POST',body:JSON.stringify({action:'login-attempt'})}));
    if(!budget.ok)return response({error:'too_many_attempts'},budget.status===429?429:503,{'Retry-After':budget.headers.get('Retry-After')||'60'});
    if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return response({error:'json_required'},415);
    let body;try {body=await readBody(request,1024);}catch{return response({error:'invalid_request'},400);}
    if(!validStatsCode(body?.code)||!await matchesCode(body.code,env.STATS_ACCESS_CODE))return response({error:'invalid_code'},401);
    const value=(now+900000)+'.'+hex(crypto.getRandomValues(new Uint8Array(16)));
    return response({authenticated:true},200,{'Set-Cookie':`${STATS_COOKIE}=${value}.${await statsSignature(env,value)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`});
  }
  const expiry=await statsSession(request,env,now);
  if(!expiry)return response({error:'unauthorized'},401,{'Set-Cookie':clear});
  const result=await stub().fetch(new Request('https://stats.internal/',{method:'POST',body:JSON.stringify({action:'summary',token:await digest(statsCookieValue(request))})}));
  const data=await result.json();
  // Include the current cycle even before its first search. Historical identity
  // snapshots stay in stats storage, independent of subsequent publications.
  if(result.ok)try {
    const current=await readSchedule(env);
    if(!(current instanceof Response)) {
      const model=publicationRuntime.SchedulePublication.load(current.payload);cycleKey(model);
      const expires=Date.parse(model.cycleEndDate+'T16:00:00Z')+180*86400000;
      if(expires>now&&!data.cycles.some(c=>c.cycleStartDate===model.cycleStartDate&&c.cycleEndDate===model.cycleEndDate))data.cycles.push({cycleStartDate:model.cycleStartDate,cycleEndDate:model.cycleEndDate,expiresAt:new Date(expires).toISOString(),totalSearches:0,selectedIdentities:0,people:[]});
      data.cycles.sort((a,b)=>b.cycleStartDate.localeCompare(a.cycleStartDate));
    }
  }catch {}
  return response({...data,expiresAt:new Date(expiry).toISOString()},result.status);
}
