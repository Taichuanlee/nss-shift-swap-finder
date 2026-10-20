/* Same-origin only. No token, password or schedule in browser persistent storage. */
(() => {
  const $=id=>document.getElementById(id);
  let timer=null,generation=0,observationGeneration=0;
  const stop=()=>{clearTimeout(timer);timer=null;observationGeneration++;};
  function clear() {
    stop();generation++;$('authenticated').hidden=true;$('login').hidden=false;
    $('schedule').textContent='';$('summary').textContent='';$('expiry').textContent='';
    $('observations').textContent='';$('observation-status').textContent='';
  }
  async function api(path,body) {
    const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    if(response.status===401) {clear();throw new Error('登入失敗或已到期，請重新輸入存取碼。');}
    if(!response.ok)throw new Error(response.status===429?'嘗試次數過多，請稍後再試。':'服務暫不可用，請稍後重試。');
    return response.json();
  }
  function show(data) {
    $('expiry').textContent=new Date(data.expiresAt).toLocaleString();
    $('authenticated').hidden=false;$('login').hidden=true;
  }
  async function load() {
    const token=generation,data=await api('/api/schedule');if(token!==generation)return;
    show(data);$('summary').textContent=`版本 ${data.revision}；${data.payload.employees.length} 位合成人員；${data.payload.dates.length} 天；節點 ${data.colo}`;
    $('schedule').textContent=JSON.stringify(data.payload,null,2);$('status').textContent='已載入合成班表。';return data;
  }
  $('login').addEventListener('submit',async event=>{
    event.preventDefault();clear();const code=$('code').value;$('code').value='';
    try {const data=await api('/api/login',{code});show(data);await load();}catch(error){$('status').textContent=error.message;}
  });
  $('reload').addEventListener('click',()=>load().catch(error=>{$('status').textContent=error.message;}));
  $('logout').addEventListener('click',async()=>{
    clear();try {await api('/api/logout',{});$('status').textContent='已登出。';}
    catch(error){$('status').textContent=`登出未獲伺服器確認：${error.message}`;}
  });
  $('stop').addEventListener('click',()=>{stop();$('observation-status').textContent='已停止觀測。';});
  $('observe').addEventListener('click',()=>{
    stop();const expected=$('expected').value.trim();
    if(!/^[a-f0-9]{64}$/.test(expected)){$('observation-status').textContent='請輸入完整 SHA-256。';return;}
    const run=observationGeneration,start=Date.now();let samples=0;
    $('observations').textContent='';$('observation-status').textContent='觀測中。時間從按下開始計算，非 KV 寫入時間。';
    async function sample() {
      try {
        const data=await api('/api/schedule');if(run!==observationGeneration)return;
        samples++;const elapsed=((Date.now()-start)/1000).toFixed(1);
        $('observations').textContent+=`${data.observedAt} | ${elapsed}s | ${data.colo} | ${data.revision}\n`;
        if(data.revision===expected){$('observation-status').textContent=`已觀察到目標版本，經過 ${elapsed} 秒。`;stop();return;}
        if(samples>=121){$('observation-status').textContent='觀測結束，尚未看到目標版本。';stop();return;}
        timer=setTimeout(sample,10000);
      }catch(error){stop();$('status').textContent=error.message;}
    }
    sample();
  });
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',event=>{if(event.persisted){clear();restore();}});
  async function restore() {
    try {show(await api('/api/session'));await load();}catch(error){$('status').textContent=error.message;}
  }
  restore();
})();
