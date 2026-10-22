/* Identity, shared calendar and memory-only personal corrections. */
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
    return matches.length === 1 && typeof id === 'string' && id.trim() && !id.startsWith('unresolved-') && e.identityResolved && (e.validation?.complete || e.validation?.incomplete) ? e : null;
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
      if (!model.scheduleDates.includes(date) || !['work','leave','blank'].includes(kind)) throw new Error('個人班表資料不完整，請重新檢查匯入結果。');
      return {date, code:code ?? '', kind, weekday:weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]};
    });
  }
  // Memory-only overlay. Imported cells and other employees are never written.
  function createCorrections(source,id) {
    const days=calendar(source,id), allowed=new Set(days.map(day=>day.date)), changes=new Map();
    const employee=uniqueEmployee(source,id),start=source.cycleStartDate,end=source.cycleEndDate;
    function active() {if(!available(source) || source.cycleStartDate!==start || source.cycleEndDate!==end) throw new Error('正式四週期已變更，請重新確認身分。');}
    function effective() {
      active();
      return {...source,employees:source.employees.map(e=>e===employee ? {...e,shifts:{...e.shifts,...Object.fromEntries(changes)}} : e)};
    }
    function check(date) {active();if(!allowed.has(date)) throw new Error('只能修改本人正式四週期內的日期。');}
    function set(date,code) {
      check(date);
      if(ns.Model.classify(employee.shifts[date])==='blank')throw new Error('未知／未排定日期不能以個人修正代替。');
      if(!['A','E','N','O'].includes(code) || !['work','leave'].includes(ns.Model.classify(code))) throw new Error('請選擇 A、E、N 或 O。');
      if(code===employee.shifts[date]) changes.delete(date); else changes.set(date,code);
    }
    function restore(date) {check(date);changes.delete(date);}
    function reset() {active();changes.clear();}
    function display() {return calendar(effective(),id).map(day=>({...day,modified:changes.has(day.date),originalCode:employee.shifts[day.date]}));}
    return Object.freeze({effective,set,restore,reset,display});
  }
  // Shared four-week rendering: selection is opt-in; candidate previews are read-only.
  function renderCalendar(root,container,days,{selectWork=false,edit=false}={}) {
    container.replaceChildren();
    for (let week=0;week<4;week++) {
      const row=root.createElement('ol'); row.className='personal-week'; row.setAttribute('aria-label',`第 ${week+1} 週`);
      for(const day of days.slice(week*7,week*7+7)) {
        const cell=root.createElement('li'); cell.className=`personal-day ${day.kind}${day.exchanged ? ' exchanged-day' : ''}${day.modified ? ' modified-day' : ''}`;
        cell.dataset.date=day.date;
        const time=root.createElement('time'); time.dateTime=day.date; time.textContent=`${Number(day.date.slice(5,7))}/${Number(day.date.slice(8))}`;
        const weekday=root.createElement('span'); weekday.className='day-weekday'; weekday.textContent=`週${day.weekday}`;
        const shift=root.createElement('strong'); shift.textContent=day.exchanged ? `${day.beforeCode} → ${day.code}` : (day.code||'未知／未排定');
        cell.setAttribute('aria-label',`${day.date} 星期${day.weekday} ${day.code} ${day.kind==='work'?'上班':day.kind==='leave'?'休假':'未知／未排定'}${day.exchanged ? `，交換前 ${day.beforeCode}，交換後 ${day.code}` : ''}`);
        if((edit && day.kind!=='blank') || (selectWork && day.kind==='work')) {
          const chooseDay=root.createElement('button');chooseDay.type='button';chooseDay.className=edit?'edit-day':'want-day';chooseDay.dataset.date=day.date;
          chooseDay.setAttribute('aria-pressed','false');chooseDay.setAttribute('aria-label',`${day.date} 星期${day.weekday} ${day.code}${day.modified ? `，原始 ${day.originalCode}` : ''}，${edit?'修改班別':'選擇想休日期'}`);
          chooseDay.append(time,weekday,shift);cell.append(chooseDay);
        } else cell.append(time,weekday,shift);
        if(day.modified) {
          const note=root.createElement('small');note.className='correction-note';note.textContent=`✎ ${day.originalCode} → ${day.code}`;cell.append(note);
        }
        row.append(cell);
      }
      container.append(row);
    }
  }
  function createController(root, guide, {onConfirmed=()=>{},onInvalidated=()=>{}}={}) {
    const panel=root.querySelector('#identity-selection'), personal=root.querySelector('#personal-schedule');
    const searchInput=root.querySelector('#employee-search'), results=root.querySelector('#employee-results');
    const selection=root.querySelector('#identity-review'), message=root.querySelector('#identity-status');
    const saved=root.querySelector('#remembered-identity'), picker=root.querySelector('#identity-picker');
    const weeks=root.querySelector('#personal-weeks');
    let model=null, signature='', selectedId=null, confirmedId=null, corrections=null,editing=false,editDate=null;
    const editToggle=root.querySelector('#edit-schedule'),editor=root.querySelector('#shift-editor');
    function storage() { try { return window.localStorage; } catch { return null; } }
    function label(employee) { return `${employee.name} · 員工編號：${employee.id}`; }
    function invalidate() {
      onInvalidated();
      corrections=null;editing=false;editDate=null;editor.hidden=true;editToggle.textContent='編輯班表';editToggle.setAttribute('aria-expanded','false');root.querySelector('#edit-controls').hidden=true;personal.classList.remove('editing');
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
      corrections=createCorrections(model,confirmedId);editing=false;editDate=null;editor.hidden=true;
      renderPersonal();
      if(employee.validation.incomplete)message.textContent+=' 班表資料不完整：空白為未知／未排定，涉及未知日期的交換候選不提供。';
      personal.hidden=false; onConfirmed(corrections.effective(),confirmedId); guide(personal);
    });
    function renderPersonal() {
      renderCalendar(root,weeks,corrections.display(),{selectWork:!editing,edit:editing});
      editToggle.textContent=editing?'完成編輯':'編輯班表';editToggle.setAttribute('aria-expanded',String(editing));
      root.querySelector('#edit-controls').hidden=!editing;
      root.querySelector('#edit-state').textContent=editing?'編輯模式：點選日期，再選擇班別。':'唯讀模式：點選工作日搜尋換班。';
      personal.classList.toggle('editing',editing);
      root.querySelector('#restore-all-shifts').disabled=!corrections.display().some(day=>day.modified);
    }
    function updateCorrection(action) {
      if(!corrections || !editing || !confirmedId) return;
      try {action();onInvalidated();renderPersonal();editor.hidden=true;editDate=null;}
      catch {root.querySelector('#edit-state').textContent='無法修改，請確認日期與班別。';}
    }
    editToggle.addEventListener('click',()=>{
      if(!corrections || !confirmedId) return;
      editing=!editing;editor.hidden=true;editDate=null;onInvalidated();renderPersonal();
      if(!editing) onConfirmed(corrections.effective(),confirmedId);
    });
    weeks.addEventListener('click',event=>{
      const button=event.target.closest('.edit-day');
      if(!button || !editing || !corrections) return;
      editDate=button.dataset.date;
      const day=corrections.display().find(day=>day.date===editDate);if(!day)return;
      root.querySelector('#edit-date-label').textContent=`${day.date} · 原始 ${day.originalCode} · 目前 ${day.code}`;
      root.querySelector('#restore-day-shift').disabled=!day.modified;
      editor.hidden=false;root.querySelector('#shift-options button').focus({preventScroll:true});
      editor.scrollIntoView({behavior:'auto',block:'nearest'});
    });
    root.querySelector('#shift-options').addEventListener('click',event=>{
      const option=event.target.closest('button[data-shift]');if(option && editDate)updateCorrection(()=>corrections.set(editDate,option.dataset.shift));
    });
    root.querySelector('#restore-day-shift').addEventListener('click',()=>{if(editDate)updateCorrection(()=>corrections.restore(editDate));});
    root.querySelector('#restore-all-shifts').addEventListener('click',()=>updateCorrection(()=>corrections.reset()));
    root.querySelector('#cancel-shift-edit').addEventListener('click',()=>{editor.hidden=true;editDate=null;});
    root.querySelector('#switch-employee').addEventListener('click',()=> {invalidate(); renderSaved(); guide(panel);});
    root.querySelector('#forget-identity').addEventListener('click',()=> {
      try {storage()?.removeItem(STORAGE_KEY); saved.hidden=true; message.textContent='已清除這部裝置記住的身分。';} catch {message.textContent='瀏覽器無法清除記住的身分，請檢查瀏覽器儲存設定。';}
    });
    return {setSchedule,invalidate};
  }
  ns.PersonalSchedule=Object.freeze({STORAGE_KEY,available,uniqueEmployee,search,remembered,remember,calendar,createCorrections,renderCalendar,createController});
})();
