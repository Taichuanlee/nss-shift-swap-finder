/* Optional same-origin client, loaded only by the isolated Cloudflare SSF build. */
(() => {
  'use strict';
  const ns=window.NSSShiftSwapFinder,controller=ns.ImportController;
  const $=id=>document.getElementById(id);
  let operation=0,pending=null,expiryTimer=null,expiresAt=0;
  function mode(source) {
    const unit=source==='central';
    $('source-unit').checked=unit;$('source-upload').checked=!unit;
    $('unit-schedule-controls').hidden=!unit;$('manual-workspace').hidden=unit;
    if(!unit)$('central-code').value='';
  }
  function status(text,error=false) {$('central-status').textContent=text;$('central-status').classList.toggle('error',error);}
  function cancel() {operation++;pending?.abort();pending=null;}
  function busy(value) {$('central-login').querySelector('button').disabled=value;$('central-load').disabled=value;}
  function signedOut() {
    clearTimeout(expiryTimer);expiresAt=0;$('central-session').textContent='尚未登入單位班表服務。';
    $('central-login').hidden=false;$('central-logout').hidden=true;
  }
  function expire() {
    cancel();busy(false);signedOut();controller.clearCentral();
    status('單位班表服務登入已到期，已清除單位班表；請重新登入，或使用自行上傳。',true);
  }
  function session(data) {
    const time=Date.parse(data?.expiresAt);
    if(!Number.isFinite(time)||time<=Date.now()||time-Date.now()>604800000)throw new Error('單位班表服務回傳的登入期限無效，請重新登入。');
    clearTimeout(expiryTimer);expiresAt=time;
    $('central-session').textContent=`單位班表服務登入至 ${new Date(time).toLocaleString()}；自行上傳可獨立使用。`;
    $('central-login').hidden=true;$('central-logout').hidden=false;
    expiryTimer=setTimeout(expire,Math.min(time-Date.now(),2147483647));
  }
  async function request(path,body,signal) {
    let response;
    try {response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal,
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});}
    catch(error) {if(signal.aborted)throw error;throw new Error('無法連線單位班表服務，請檢查網路後重試，或改用自行上傳。');}
    let data;try {data=await response.json();}catch {throw new Error('單位班表服務回應格式錯誤，未載入班表。');}
    if(response.status===401) {
      const error=new Error(path==='/api/login'?'存取碼錯誤，請重新輸入。':'尚未登入或登入已到期，請重新登入單位班表服務。');
      error.unauthorized=true;throw error;
    }
    if(response.status===429)throw new Error('登入嘗試次數過多，請稍後再試。');
    if(!response.ok)throw new Error(data?.error==='invalid_schedule'?'單位班表格式錯誤或驗證未通過，請通知管理者，或使用自行上傳。':
      data?.error==='schedule_not_available'?'目前沒有已發布的單位班表，請稍後再試或使用自行上傳。':'單位班表服務暫時無法使用，請稍後重試或改用自行上傳。');
    return data;
  }
  async function run(action,{central=false}={}) {
    cancel();const token=operation,abort=new AbortController();pending=abort;busy(true);
    if(central)controller.prepareCentral();
    let timeout=false;
    const timer=setTimeout(()=>{timeout=true;abort.abort();},15000);
    try {await action(abort.signal,token);}
    catch(error) {
      if(token!==operation)return;
      controller.clearCentral();
      if(error.unauthorized)signedOut();
      status(timeout?'單位班表服務連線逾時，未載入班表；請重試或使用自行上傳。':error.message,true);
    } finally {clearTimeout(timer);if(token===operation){pending=null;busy(false);}}
  }
  async function load(signal,token) {
    const data=await request('/api/schedule',undefined,signal);if(token!==operation)return;
    let model;
    try {
      if(!/^[a-f0-9]{64}$/.test(data?.revision||''))throw new Error('revision');
      model=ns.SchedulePublication.load(data.payload);
    }catch {throw new Error('單位班表格式錯誤或驗證未通過，未載入任何資料。');}
    session(data);
    controller.acceptCentral(model,{revision:data.revision,publishedAt:data.payload.publishedAt});
    status('單位班表已載入，正式四週期由管理者確認。請在下方選擇自己並確認身分。'+(model.warnings.some(w=>w.code==='BLANK_SHIFT')?' 資料不完整：空白班別為未知／未排定；整排空白者不參與搜尋，涉及未知日期的交換候選將排除。':''));
  }
  function restore() {
    return run(async(signal,token)=>{
      const data=await request('/api/session',undefined,signal);if(token!==operation)return;
      session(data);controller.prepareCentral();await load(signal,token);
    });
  }
  $('source-upload').addEventListener('change',()=>{
    if(!$('source-upload').checked)return;
    cancel();busy(false);mode('manual');controller.prepareManual();
    status('已切換為自行上傳；單位班表請求已取消，不會覆蓋本機班表。');
  });
  $('source-unit').addEventListener('change',()=>{
    if(!$('source-unit').checked)return;
    mode('central');controller.prepareCentral();
    status('正在檢查單位班表登入狀態…');restore();
  });
  $('central-login').addEventListener('submit',event=>{
    event.preventDefault();const code=$('central-code').value;$('central-code').value='';
    status('正在登入並載入單位班表…');
    run(async(signal,token)=>{
      const data=await request('/api/login',{code},signal);if(token!==operation)return;
      session(data);await load(signal,token);
    },{central:true});
  });
  $('central-load').addEventListener('click',()=>{
    status('正在載入最新已發布班表，已清除先前搜尋狀態…');
    run(load,{central:true});
  });
  $('central-logout').addEventListener('click',()=>{
    controller.clearCentral();signedOut();$('central-code').value='';
    run(async(signal,token)=>{
      try {await request('/api/logout',{},signal);}catch {if(token===operation){$('central-logout').hidden=false;status('登出未獲伺服器確認，單位班表資料已清除；請恢復網路後重試登出。',true);}return;}
      if(token===operation)status('已登出單位班表服務；可重新登入或使用自行上傳。');
    });
  });
  document.addEventListener('nss:manual-source',()=>{
    cancel();busy(false);mode('manual');status('已切換為自行上傳；單位班表請求已取消，不會覆蓋本機班表。');
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&expiresAt&&Date.now()>=expiresAt)expire();});
  window.addEventListener('pagehide',()=>{cancel();clearTimeout(expiryTimer);});
  window.addEventListener('pageshow',event=>{
    if(!event.persisted)return;
    if(controller.getSource()==='central'){controller.clearCentral();restore();}
    else if(expiresAt){if(Date.now()>=expiresAt)expire();else expiryTimer=setTimeout(expire,expiresAt-Date.now());}
  });
  mode('central');controller.prepareCentral();restore();
})();
