(() => {
  'use strict';
  const ns=window.NSSShiftSwapFinder;
  function previewDays(model,result) {
    const days=ns.PersonalSchedule.calendar(model,result.employeeId);
    const changed=[result.wantedDate,result.exchangeDate];
    const workCode=result.self.before[result.wantedDate];
    if(!['A','E','N'].includes(workCode) || workCode!==result.other.before[result.exchangeDate] ||
      result.other.after[result.wantedDate]!==workCode ||
      result.other.after[result.exchangeDate]!==result.self.before[result.exchangeDate]) throw new Error('只允許相同工作班別交換，請重新搜尋。');
    if(new Set(changed).size!==2 || !changed.every(date=>days.some(day=>day.date===date))) throw new Error('交換日期不在已確認的四週期內。');
    return days.map(day=>{
      if(!changed.includes(day.date)) return {...day};
      const code=result.other.after[day.date], beforeCode=result.other.before[day.date];
      if(beforeCode!==day.code || !['work','leave'].includes(ns.Model.classify(code))) throw new Error('交換預覽資料不一致，請重新搜尋。');
      return {...day,code,kind:ns.Model.classify(code),beforeCode,exchanged:true};
    });
  }
  function createController(root,guide) {
    const panel=root.querySelector('#swap-search'),choices=root.querySelector('#exchange-dates');
    const picker=root.querySelector('#exchange-picker'),button=root.querySelector('#search-swaps');
    const status=root.querySelector('#swap-status');
    const output=root.querySelector('#swap-results'),resultsPanel=root.querySelector('#swap-results-panel');
    let model=null,id=null,wanted=null,selected=new Set(),previewSequence=0;
    function clearResults() {output.replaceChildren();resultsPanel.hidden=true;}
    function reset() {
      model=null;id=null;wanted=null;selected.clear();panel.hidden=true;picker.hidden=true;button.disabled=true;
      choices.replaceChildren();clearResults();status.textContent='';root.querySelector('#wanted-date').textContent='請先點選上方班表的工作日。';
      for(const day of root.querySelectorAll('.want-day'))day.setAttribute('aria-pressed','false');
    }
    function setIdentity(next,employeeId) {
      reset();model=next;id=employeeId;
      try {
        const dates=ns.SwapEngine.options(model,id);panel.hidden=false;
        status.textContent=!dates.workDates.length?'您的正式四週期沒有工作日，無法選擇想休日期。':!dates.leaveDates.length?'您的正式四週期沒有可交換的休假日，無法進行雙向交換。':'請先在上方 28 天班表點選想休的工作日。';
      } catch {reset();}
    }
    root.querySelector('#personal-weeks').addEventListener('click',event=>{
      const day=event.target.closest('.want-day');if(!day||!model||!id)return;
      const dates=ns.SwapEngine.options(model,id);if(!dates.workDates.includes(day.dataset.date))return;
      wanted=day.dataset.date;selected.clear();clearResults();
      for(const option of root.querySelectorAll('.want-day')) option.setAttribute('aria-pressed',String(option===day));
      const employee=ns.PersonalSchedule.uniqueEmployee(model,id);
      root.querySelector('#wanted-date').textContent=`想休：${wanted}（原班別 ${employee.shifts[wanted]}）`;
      choices.replaceChildren();picker.hidden=false;button.disabled=true;
      for(const date of dates.leaveDates) {
        const label=root.createElement('label');label.className='exchange-option';
        const checkbox=root.createElement('input');checkbox.type='checkbox';checkbox.value=date;
        const text=root.createElement('span');text.textContent=`${date} · ${employee.shifts[date]}`;
        checkbox.addEventListener('change',()=>{
          if(checkbox.checked)selected.add(date);else selected.delete(date);
          clearResults();button.disabled=!selected.size;
          status.textContent=selected.size?`已選 ${selected.size} 個交換日期，每個日期會分開搜尋。`:'請至少選一個願意交換的休假日。';
        });
        label.append(checkbox,text);choices.append(label);
      }
      status.textContent=dates.leaveDates.length?'請勾選願意交換的休假日，可複選。':'您的正式四週期沒有可交換的休假日。';
      guide(panel);
    });
    function element(tag,text,className) {const e=root.createElement(tag);e.textContent=text;if(className)e.className=className;return e;}
    button.addEventListener('click',()=>{
      clearResults();
      try {
        const groups=ns.SwapEngine.search(model,id,wanted,[...selected]);
        let total=0;
        for(const group of groups) {
          const section=root.createElement('section');section.className='swap-group';
          section.append(element('h3',`交換日期 ${group.exchangeDate} · ${group.results.length} 位同仁`));
          for(const result of group.results) {
            total++;const card=root.createElement('article');card.className='swap-candidate';
            card.append(element('h4',`${result.name} · 員工編號 ${result.employeeId}`),element('p','同班別交換','swap-tag'));
            const changes=root.createElement('div');changes.className='swap-changes';
            for(const [role,detail] of [['您',result.self],['對方',result.other]]) {
              const column=root.createElement('div');column.append(element('strong',role));
              for(const date of [result.wantedDate,result.exchangeDate])column.append(element('p',`${date}：${detail.before[date]} → ${detail.after[date]}`));
              changes.append(column);
            }
            card.append(changes);
            if(result.warnings.length) {const warnings=root.createElement('ul');warnings.className='swap-warnings';for(const warning of result.warnings)warnings.append(element('li',warning));card.append(warnings);}
            const toggle=element('button','查看對方四週期班表','preview-toggle');toggle.type='button';
            const preview=root.createElement('div');preview.className='candidate-preview';preview.hidden=true;
            preview.id=`candidate-preview-${++previewSequence}`;
            toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',preview.id);
            toggle.setAttribute('aria-label',`查看 ${result.name}（${result.employeeId}）四週期班表，交換日期 ${result.exchangeDate}`);
            let rendered=false;
            toggle.addEventListener('click',()=>{
              const expanded=toggle.getAttribute('aria-expanded')==='true';
              if(!expanded && !rendered) {
                try {
                  const days=previewDays(model,result);
                  preview.append(element('p',`${model.cycleStartDate} ～ ${model.cycleEndDate} · 交換後模擬，黃色為交換日期`,'confirmation-help'));
                  const weeks=root.createElement('div');
                  ns.PersonalSchedule.renderCalendar(root,weeks,days);preview.append(weeks);
                } catch {preview.replaceChildren(element('p','無法顯示可靠的班表預覽，請重新搜尋。','confirmation-help'));}
                rendered=true;
              }
              preview.hidden=expanded;toggle.setAttribute('aria-expanded',String(!expanded));
              toggle.textContent=expanded?'查看對方四週期班表':'收合對方四週期班表';
              toggle.setAttribute('aria-label',`${expanded?'查看':'收合'} ${result.name}（${result.employeeId}）四週期班表，交換日期 ${result.exchangeDate}`);
            });
            card.append(toggle,preview);
            section.append(card);
          }
          if(!group.results.length) {
            section.append(element('p','此日期沒有符合條件的同仁。'));
            const excluded=group.excluded;
            section.append(element('p',`未符合：雙向條件 ${excluded.direction} 位、班別不同 ${excluded.shift} 位、連續上班限制 ${excluded.consecutive} 位、資料無效 ${excluded.invalid} 位。`,'confirmation-help'));
          }
          output.append(section);
        }
        status.textContent=`找到 ${total} 筆同班別換班建議。`;
        root.querySelector('#swap-results-note').textContent='只允許 A ↔ A、E ↔ E、N ↔ N。每筆只模擬一對日期，未修改班表。';
        resultsPanel.hidden=false;guide(resultsPanel);
      } catch(error) {status.textContent=error.message;}
    });
    return {reset,setIdentity};
  }
  ns.SwapUI=Object.freeze({previewDays,createController});
})();
