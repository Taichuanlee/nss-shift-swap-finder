/* Identity confirmation and read-only calendar; schedule data stays in memory. */
(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  const STORAGE_KEY = 'nss-shift-swap-finder.identity.v1';
  const weekdays = ['日','一','二','三','四','五','六'];
  function available(model) {
    return Boolean(model?.cycleConfirmed && model.validation?.readyForSearch);
  }
  function uniqueEmployee(model, id) {
    const matches = (model?.employees || []).filter(e => e.id === id);
    const e = matches[0];
    return matches.length === 1 && typeof id === 'string' && id.trim() && !id.startsWith('unresolved-') && e.identityResolved && e.validation?.complete ? e : null;
  }
  function search(model, query) {
    const q = query.trim().toLocaleLowerCase();
    return !available(model) || !q ? [] : model.employees.filter(e => String(e.name).toLocaleLowerCase().includes(q) || String(e.id).toLocaleLowerCase().includes(q));
  }
  function remembered(storage, model) {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY));
      return available(model) && value?.version === 1 && typeof value.id === 'string' ? uniqueEmployee(model, value.id) : null;
    } catch { return null; }
  }
  function remember(storage, model, id) {
    if (!available(model) || !uniqueEmployee(model,id)) return false;
    try { storage.setItem(STORAGE_KEY, JSON.stringify({version:1,id})); return true; } catch { return false; }
  }
  function calendar(model, id) {
    const employee = uniqueEmployee(model,id);
    if (!available(model) || !employee || ns.ImportConfirmation.addDays(model.cycleStartDate,27) !== model.cycleEndDate) throw new Error('請先完成班表與身分確認。');
    return Array.from({length:28},(_,i) => {
      const date = ns.ImportConfirmation.addDays(model.cycleStartDate,i), code = employee.shifts[date];
      const kind = ns.Model.classify(code);
      if (!model.scheduleDates.includes(date) || !['work','leave'].includes(kind)) throw new Error('個人班表資料不完整，請重新檢查匯入結果。');
      return {date, code, kind, weekday:weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]};
    });
  }
  function createController(root, guide) {
    const panel=root.querySelector('#identity-selection'), personal=root.querySelector('#personal-schedule');
    const searchInput=root.querySelector('#employee-search'), results=root.querySelector('#employee-results');
    const selection=root.querySelector('#identity-review'), message=root.querySelector('#identity-status');
    const saved=root.querySelector('#remembered-identity'), picker=root.querySelector('#identity-picker');
    const weeks=root.querySelector('#personal-weeks');
    let model=null, signature='', selectedId=null, confirmedId=null;
    function storage() { try { return window.localStorage; } catch { return null; } }
    function label(employee) { return `${employee.name} · 員工編號：${employee.id}`; }
    function invalidate() {
      selectedId=null; confirmedId=null; selection.hidden=true; personal.hidden=true; weeks.replaceChildren();
      picker.hidden=false; root.querySelector('#confirmed-identity').hidden=true;
      root.querySelector('#confirmed-name').textContent=''; root.querySelector('#identity-review-name').textContent='';
      root.querySelector('#personal-range').textContent='';
      searchInput.value=''; results.replaceChildren(); message.textContent='請輸入姓名或員工編號搜尋；選擇後仍需確認這是您本人。';
    }
    function choose(id) {
      const employee=uniqueEmployee(model,id);
      if (!available(model) || !employee) { message.textContent='此員工編號無法唯一辨識，請重新檢查匯入資料。'; return; }
      selectedId=id; selection.hidden=false;
      root.querySelector('#identity-review-name').textContent=label(employee);
      message.textContent='請核對姓名與員工編號，再按「確認這是我」。';
    }
    function renderSaved() {
      const employee=remembered(storage(),model); saved.hidden=!employee;
      root.querySelector('#remembered-name').textContent=employee ? label(employee) : '';
    }
    function setSchedule(next) {
      const nextSignature=next ? `${next.cycleStartDate}|${next.cycleEndDate}|${available(next)}` : '';
      if (next !== model || signature !== nextSignature) invalidate();
      model=next; signature=nextSignature; panel.hidden=!available(model);
      if (panel.hidden) invalidate();
      renderSaved();
    }
    searchInput.addEventListener('input',()=> {
      selectedId=null; selection.hidden=true; results.replaceChildren();
      const found=search(model,searchInput.value);
      message.textContent=!searchInput.value.trim() ? '請輸入姓名或員工編號搜尋。' : found.length ? `找到 ${found.length} 位同仁${found.length>30 ? '，先顯示前 30 位，請輸入更完整的姓名或編號' : ''}。請核對員工編號。` : '找不到符合的同仁，請確認姓名或員工編號。';
      for (const e of found.slice(0,30)) {
        const button=root.createElement('button'); button.type='button'; button.className='employee-option';
        button.textContent=label(e); button.disabled=!uniqueEmployee(model,e.id);
        button.addEventListener('click',()=>choose(e.id)); results.append(button);
      }
    });
    root.querySelector('#use-remembered').addEventListener('click',()=> {const e=remembered(storage(),model); if(e) choose(e.id);});
    root.querySelector('#confirm-identity').addEventListener('click',()=> {
      if (!selectedId || !available(model)) return;
      let days; try {days=calendar(model,selectedId);} catch(e) {invalidate(); message.textContent=e.message; return;}
      confirmedId=selectedId; const employee=uniqueEmployee(model,confirmedId);
      const persisted=remember(storage(),model,confirmedId);
      picker.hidden=true; selection.hidden=true; root.querySelector('#confirmed-identity').hidden=false;
      root.querySelector('#confirmed-name').textContent=label(employee);
      message.textContent=persisted ? '身分已確認。下次匯入仍會請您重新確認。' : '身分已確認；此瀏覽器無法記住身分，不影響本次查看。';
      root.querySelector('#personal-range').textContent=`${model.cycleStartDate} ～ ${model.cycleEndDate} · 共 28 天`;
      weeks.replaceChildren();
      for (let week=0;week<4;week++) {
        const row=root.createElement('ol'); row.className='personal-week'; row.setAttribute('aria-label',`第 ${week+1} 週`);
        for(const day of days.slice(week*7,week*7+7)) {
          const cell=root.createElement('li'); cell.className=`personal-day ${day.kind}`;
          const time=root.createElement('time'); time.dateTime=day.date; time.textContent=`${Number(day.date.slice(5,7))}/${Number(day.date.slice(8))}`;
          const weekday=root.createElement('span'); weekday.className='day-weekday'; weekday.textContent=`週${day.weekday}`;
          const shift=root.createElement('strong'); shift.textContent=day.code;
          cell.setAttribute('aria-label',`${day.date} 星期${day.weekday} ${day.code} ${day.kind==='work'?'上班':'休假'}`);
          cell.append(time,weekday,shift); row.append(cell);
        }
        weeks.append(row);
      }
      personal.hidden=false; guide(personal);
    });
    root.querySelector('#switch-employee').addEventListener('click',()=> {invalidate(); renderSaved(); guide(panel);});
    root.querySelector('#forget-identity').addEventListener('click',()=> {
      try {storage()?.removeItem(STORAGE_KEY); saved.hidden=true; message.textContent='已清除這部裝置記住的身分。';} catch {message.textContent='瀏覽器無法清除記住的身分，請檢查瀏覽器儲存設定。';}
    });
    return {setSchedule,invalidate};
  }
  ns.PersonalSchedule=Object.freeze({STORAGE_KEY,available,uniqueEmployee,search,remembered,remember,calendar,createController});
})();
