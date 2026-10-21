(() => {
  'use strict';
  const status=document.getElementById('admin-status'),login=document.getElementById('admin-login');
  let expiresAt=0,timer,active=false,revision=0;
  const messages={invalid_code:'管理者存取碼錯誤。',too_many_attempts:'登入嘗試過於頻繁，請至少等候一分鐘。',service_unavailable:'管理服務尚未正確設定或暫時無法使用。',unauthorized:'登入已到期，請重新登入。',origin_rejected:'登入來源驗證失敗，請由同一網站開啟管理頁。'};
  async function request(action,code) {
    const options={credentials:'same-origin',cache:'no-store'};
    if(action!=='session'){options.method='POST';options.headers={'Content-Type':'application/json'};options.body=JSON.stringify(code===undefined?{}:{code});}
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);options.signal=controller.signal;
    let response,body;
    try {
      response=await fetch('/api/admin/'+action,options);
      try {body=await response.json();}catch {throw new Error('管理服務回應格式錯誤或連線中斷。');}
    }catch(error){if(!response)throw new Error('網路連線失敗或逾時，請稍後重試。');throw error;}finally{clearTimeout(timeout);}
    if(!body||typeof body!=='object')throw new Error('管理服務回應格式錯誤。');
    if(!response.ok)throw new Error(messages[body.error]||'管理服務無法使用，請重新登入。');
    return body;
  }
  function clear(message) {
    revision++;active=false;expiresAt=0;clearTimeout(timer);status.textContent=message;
    window.dispatchEvent(new Event('admin-session-ended'));
  }
  function remember(body) {
    if(body.authenticated!==true)throw new Error('管理服務登入回應無效。');
    expiresAt=Date.parse(body.expiresAt);
    if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('登入已到期，請重新登入。');
    active=true;clearTimeout(timer);timer=setTimeout(()=>clear('登入已到期，請重新登入。'),expiresAt-Date.now());
    status.textContent='管理者登入有效至 '+new Date(expiresAt).toLocaleString();
  }
  const ready=(async()=>{
    if(login) {
      login.addEventListener('submit',async event=>{
        event.preventDefault();const input=document.getElementById('admin-code'),button=login.querySelector('button');
        const code=input.value;input.value='';button.disabled=true;
        try {remember(await request('login',code));location.replace('/admin');}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
      });return false;
    }
    const ticket=revision;
    try {const body=await request('session');if(ticket!==revision)return false;remember(body);return true;}catch(error){if(ticket===revision)clear(error.message);return false;}
  })();
  document.getElementById('admin-logout')?.addEventListener('click',async()=>{
    clear('正在登出…');
    try {await request('logout');location.replace('/admin/login');}catch(error){status.textContent=error.message+' 本機預覽已清除；伺服器登出尚未確認，請重試。';}
  });
  // BFCache restores and background tabs must revalidate before re-enabling work.
  async function recheck() {
    if(login)return;
    clear('重新確認登入狀態，預覽已清除。');
    const ticket=revision;
    try {const body=await request('session');if(ticket!==revision)return;remember(body);window.dispatchEvent(new Event('admin-session-ready'));}catch(error){if(ticket===revision)clear(error.message);}
  }
  window.addEventListener('pageshow',event=>{if(event.persisted)recheck();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clear('頁面已暫停，預覽已清除。');else recheck();});
  window.NSSAdminAuth=Object.freeze({ready,isActive:()=>active&&Date.now()<expiresAt});
})();
