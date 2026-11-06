(() => {
  'use strict';
  const $=id=>document.getElementById(id);let timer;
  function clear(){clearTimeout(timer);$('stats-cycles').replaceChildren();$('stats-content').hidden=true;$('stats-login').hidden=false;}
  async function api(path,body){const r=await fetch('/api/stats/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(r.status===401?'密碼錯誤或登入到期，請使用恰好 6 位數字（0-9）的統計 PIN 重新登入。':r.status===429?'嘗試次數過多，請稍後再試。':'統計暫時無法使用。');return r.json();}
  function el(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
  async function load(){
    clear();try{const data=await api('summary');$('stats-login').hidden=true;$('stats-content').hidden=false;
      for(const c of data.cycles){const section=el('section','');section.append(el('h2',c.cycleStartDate+' ～ '+c.cycleEndDate),el('p',`總搜尋次數：${c.totalSearches}；被選取不同員工數：${c.selectedIdentities}`));
        const table=el('table',''),head=el('tr','');for(const text of ['員工','搜尋次數'])head.append(el('th',text));table.append(head);
        for(const p of c.people){const row=el('tr','');row.append(el('td',p.name+' ('+p.id+')'),el('td',String(p.searches)));table.append(row);}section.append(table);$('stats-cycles').append(section);}
      $('stats-status').textContent=data.cycles.length?'已載入統計。':'目前沒有搜尋紀錄。';timer=setTimeout(()=>{clear();$('stats-status').textContent='畫面已清除，請重新登入。';},Math.max(0,Date.parse(data.expiresAt)-Date.now()));
    }catch(e){clear();$('stats-status').textContent=e.message;}
  }
  $('stats-login').addEventListener('submit',async e=>{e.preventDefault();const code=$('stats-code').value;$('stats-code').value='';try{await api('login',{code});await load();}catch(e){clear();$('stats-status').textContent=e.message;}});
  $('stats-refresh').addEventListener('click',load);
  $('stats-logout').addEventListener('click',async()=>{clear();try{await api('logout',{});$('stats-status').textContent='已登出。';}catch(e){$('stats-status').textContent=e.message;}});
  window.addEventListener('pagehide',clear);window.addEventListener('pageshow',e=>{if(e.persisted)clear();});
})();
