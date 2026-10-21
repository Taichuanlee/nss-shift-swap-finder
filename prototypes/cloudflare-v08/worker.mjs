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
function settings(env) {
  const ttl=Number(env.SESSION_TTL_SECONDS ?? 3600);
  if(!Number.isInteger(ttl)||ttl<1||ttl>604800||!/^[0-9a-f]{64}$/.test(env.ACCESS_CODE_SHA256||'')||!env.SCHEDULE_KV||!env.LOGIN_LIMITER?.limit)throw new Error('configuration');
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
  if(value?.version!==1||!Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.createdAt)||
    value.createdAt>now||value.expiresAt<=now||value.expiresAt-value.createdAt>604800000)return null;
  return {key,expiresAt:value.expiresAt};
}
// Admin credentials and publication permissions are separate from nurse sessions.
const ADMIN_COOKIE='__Host-nss-ssf-admin';
const adminCookie=(value,age)=>`${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function adminSettings(env) {
  const ttl=Number(env.ADMIN_SESSION_TTL_SECONDS ?? 3600);
  if(!Number.isInteger(ttl)||ttl<1||ttl>3600||!env.SCHEDULE_KV||
    !/^[0-9a-f]{64}$/.test(env.ADMIN_ACCESS_CODE_SHA256||'')||
    env.ADMIN_ACCESS_CODE_SHA256===env.ACCESS_CODE_SHA256||!env.ADMIN_LOGIN_LIMITER?.limit)throw new Error('admin_configuration');
  return {ttl};
}
async function adminSession(request,env,now) {
  const entries=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${ADMIN_COOKIE}=`));
  if(entries.length!==1)return null;
  const token=entries[0].slice(ADMIN_COOKIE.length+1);if(!/^[0-9a-f]{64}$/.test(token))return null;
  const key=`admin-session:${await digest(token)}`,raw=await env.SCHEDULE_KV.get(key);
  let value;try {value=JSON.parse(raw);}catch{return null;}
  if(value?.credentialTag!==await digest(env.ADMIN_ACCESS_CODE_SHA256)||value?.role!=='admin'||value.version!==1||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||
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
    if(typeof body?.code!=='string'||body.code.length<32||body.code.length>128)return response({error:'invalid_code'},401);
    const actual=await digest(body.code);let difference=0;
    for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^env.ADMIN_ACCESS_CODE_SHA256.charCodeAt(i);
    if(difference)return response({error:'invalid_code'},401);
    // Rotate an existing admin session on login.
    const previous=await adminSession(request,env,now);if(previous)await env.SCHEDULE_KV.delete(previous.key);
    const token=hex(crypto.getRandomValues(new Uint8Array(32))),expiresAt=now+ttl*1000;
    await env.SCHEDULE_KV.put(`admin-session:${await digest(token)}`,JSON.stringify({version:1,role:'admin',credentialTag:await digest(env.ADMIN_ACCESS_CODE_SHA256),createdAt:now,expiresAt}),{expirationTtl:Math.max(60,ttl)});
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
  if(env.SYNTHETIC_ONLY!=='false'&&!model.employees.every(e=>/^SYNTHETIC\d+$/.test(e.id)&&e.name.startsWith('合成')))throw new Error('synthetic_only');
  return publicationRuntime.SchedulePublication.create(model);
}
async function contentHash(payload) {
  // Stable content identity ignores the server-assigned publication timestamp.
  const canonical=publicationRuntime.SchedulePublication.create(publicationRuntime.SchedulePublication.load(payload));
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
    if(typeof body?.code!=='string'||body.code.length<32||body.code.length>128)return response({error:'invalid_code'},401);
    const actual=await digest(body.code);let difference=0;
    for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^env.ACCESS_CODE_SHA256.charCodeAt(i);
    if(difference)return response({error:'invalid_code'},401);
    const token=hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt=now+ttl*1000;
    await env.SCHEDULE_KV.put(`session:${await digest(token)}`,JSON.stringify({version:1,createdAt:now,expiresAt}),{expirationTtl:Math.max(60,ttl)});
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
