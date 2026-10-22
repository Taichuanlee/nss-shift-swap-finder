(() => {
  'use strict';
  const ns=window.NSSShiftSwapFinder,C=ns.ImportConfirmation,$=id=>document.getElementById(id);
  let model=null,file=null,generation=0,publishing=false,publicationState='idle',expectedHash=null;
  const sourceText=source=>source?Object.entries(source).map(([key,value])=>`${key}: ${value}`).join(', '):'';
  function node(tag,text,className) {const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;}
  function clear() {
    const uncertain=publishing||publicationState==='unknown';
    generation++;model=null;file=null;publicationState='idle';expectedHash=null;
    $('admin-publish').disabled=true;$('admin-publish').textContent='確認發布';
    $('publish-status').textContent=uncertain?'發布結果尚未確認；離開或登出不會撤銷已送出的發布，請稍後確認單位班表。':'完成日期與四週期確認後即可發布；新班表會取代目前班表。';$('admin-file').value='';$('admin-file').disabled=true;
    $('sheet-picker').hidden=true;$('admin-sheet').replaceChildren();$('admin-preview').replaceChildren();
    $('admin-cycle-start').value='';$('admin-cycle-start').disabled=true;$('admin-cycle-end').textContent='—';
    $('admin-confirm-cycle').disabled=true;$('cycle-status').textContent='';$('cycle-proposal').textContent='匯入後提供建議，仍需管理者確認。';
    $('admin-errors').textContent='尚未匯入';$('import-status').textContent='尚未匯入';
  }
  function active() {
    if(window.NSSAdminAuth.isActive())return true;
    clear();$('import-status').textContent='登入已到期，請重新登入管理頁。';return false;
  }
  function proposeCycle() {
    const candidates=new Set();
    for(const info of model.sourceInfo)for(const match of info.title.matchAll(/(\d{4}-\d{2}-\d{2})\s*(?:~|～|至|—|–|to)\s*(\d{4}-\d{2}-\d{2})/g)) {
      if(C.addDays(match[1],27)===match[2]&&Array.from({length:28},(_,i)=>C.addDays(match[1],i)).every(d=>model.scheduleDates.includes(d)))candidates.add(match[1]);
    }
    const explicit=candidates.size===1,start=explicit?[...candidates][0]:model.cycleCandidates[0]?.startDate;
    $('cycle-proposal').textContent=explicit?'依標題中唯一且完整的 28 天日期範圍建議，請確認。':'未辨識到唯一正式週期；暫以最後 28 天建議，請核對並調整。';
    if(start){C.setCycleStart(model,start);$('admin-cycle-start').value=start;}
  }
  function renderErrors() {
    const area=$('admin-errors');area.replaceChildren();
    for(const suggestion of model.importConfirmation.dateSuggestions.filter(s=>!C.resolved(s))) {
      const p=node('p',`日期異常：${suggestion.originalRaw} → 建議 ${suggestion.correctedDate}（同步 ${suggestion.occurrences.length} 個對應欄位）。${suggestion.reason} `,'invalid');
      const accept=node('button','確認此日期修正');accept.type='button';accept.disabled=publishing;
      accept.addEventListener('click',()=>{
        if(publishing||!active())return;
        resetPublication();const start=$('admin-cycle-start').value;
        model=C.decideDate(model,suggestion.id,true);
        if(start)C.setCycleStart(model,start);
        render();
      });p.append(accept);area.append(p);
    }
    const groups=new Map();
    for(const issue of model.errors) {
      const key=issue.code;const group=groups.get(key)||[];group.push(issue);groups.set(key,group);
    }
    for(const [code,issues] of groups) {
      const details=node('details',''),summary=node('summary',`${code}：${issues.length} 項 — ${issues[0].message}`,'invalid');details.append(summary);
      for(const issue of issues)details.append(node('p',`${issue.employeeId||''} ${issue.message} ${sourceText(issue.source)}`));area.append(details);
    }
    if(!model.validation.cycleLengthValid||!model.validation.cycleDatesComplete)area.append(node('p','四週期必須完整涵蓋已匯入的連續 28 天，請調整起始日。','invalid'));
    if(!model.cycleConfirmed)area.append(node('p','尚未確認正式四週期。','invalid'));
    const blanks=model.warnings.filter(w=>w.code==='BLANK_SHIFT');
    if(blanks.length)area.append(node('p',`資料不完整：${blanks.length} 個班別為未知／未排定；保留所有人員，不阻止發布。整排空白者不參與搜尋，涉及未知日期的交換候選將排除。`));
    if(!area.childNodes.length)area.append(node('p','無未解決的關鍵錯誤。'));
  }
  function renderPreview() {
    const table=node('table',''),head=node('thead',''),row=node('tr',''),body=node('tbody','');
    const inside=date=>date>=model.cycleStartDate&&date<=model.cycleEndDate;
    row.append(node('th','員工編號 / 姓名','identity'));
    for(const date of model.scheduleDates) {
      const th=node('th',`${date}\n${inside(date)?'正式四週期':'週期外'}`,inside(date)?'official':'outside');
      th.title=model.dateColumns.filter(c=>c.date===date).map(c=>`原始日期：${c.raw} (${sourceText(c.source)})`).join('\n');row.append(th);
    }
    const unresolved=[...(model.pdfUnresolvedColumns||[]),...model.dateColumns.filter(c=>!c.date).map(c=>({rawHeader:c.raw,source:c.source,values:[]}))];
    for(const col of unresolved)row.append(node('th',`未辨識：${col.rawHeader}`,'invalid'));
    head.append(row);
    for(const employee of model.employees) {
      const tr=node('tr','');tr.append(node('th',`${employee.id} / ${employee.name}`,'identity'));
      for(const date of model.scheduleDates) {
        const details=employee.shiftDetails[date]||[],conflict=new Set(details.map(d=>d.normalized)).size>1;
        const td=node('td',conflict?details.map(d=>d.raw||'（空白）').join(' / '):employee.shifts[date]||'未知／未排定',inside(date)?'official':'outside');
        if(conflict||['blank','unknown'].includes(ns.Model.classify(employee.shifts[date])))td.classList.add('invalid');
        td.title=details.map(d=>`原始班別：${d.raw} (${sourceText(d.source)})`).join('\n');tr.append(td);
      }
      for(const col of unresolved)tr.append(node('td',col.values.filter(v=>v.employeeId===employee.id).map(v=>v.rawShift).join(' / ')||'（未能對應，請修正來源檔）','invalid'));
      body.append(tr);
    }
    table.append(head,body);$('admin-preview').replaceChildren(table);
    if(model.dateCorrections.length) {
      const audit=node('details','');audit.append(node('summary','已確認的日期修正（保留原始日期）'));
      for(const c of model.dateCorrections)audit.append(node('p',`${c.originalRaw} → ${c.correctedDate}；${sourceText(c.source)}`));
      $('admin-preview').append(audit);
    }
  }
  function render() {
    ns.Validator.validate(model);$('admin-cycle-start').disabled=false;
    $('admin-cycle-end').textContent=model.cycleEndDate||'—';$('admin-confirm-cycle').disabled=model.cycleConfirmed;
    $('cycle-status').textContent=model.cycleConfirmed?'四週期已確認，背景驗證通過。':'請確認日期修正及正式四週期。';
    renderErrors();renderPreview();
    syncPublication();
  }
  async function parse(sheetName) {
    if(publishing||!file||!active())return;
    resetPublication();$('admin-publish').disabled=true;
    const selected=file,token=++generation;model=null;$('admin-preview').replaceChildren();$('admin-errors').textContent='解析與驗證中…';
    $('admin-cycle-start').disabled=true;$('admin-cycle-start').value='';$('admin-cycle-end').textContent='—';$('cycle-status').textContent='';$('admin-confirm-cycle').disabled=true;$('import-status').textContent='正在本機解析，檔案不會上傳…';
    $('sheet-picker').hidden=true;
    try {
      if(selected.size>25*1024*1024)throw new Error('檔案超過 25 MB，請選擇較小的班表檔案。');
      if(!/\.(pdf|xlsx|xls)$/i.test(selected.name))throw new Error('僅支援 PDF／XLSX／XLS 班表。');
      const result=await (/\.pdf$/i.test(selected.name)?ns.PdfParser:ns.ExcelParser).parse(selected,{sheetName});
      if(token!==generation||!active())return;
      if(result.needsSheetSelection) {
        $('admin-sheet').replaceChildren(...result.sheetNames.map(name=>{const option=node('option',name);option.value=name;return option;}));
        $('sheet-picker').hidden=false;$('admin-errors').textContent='請先選擇工作表。';$('import-status').textContent='找到多張班表，請選擇工作表。';return;
      }
      // Unlike nurse import, admin must explicitly accept every proposed date correction.
      model=C.initialize(result,{autoCorrect:false});proposeCycle();render();
      $('import-status').textContent=`已解析 ${selected.name}：${model.employees.length} 位人員、${model.scheduleDates.length} 個日期；請確認下列項目。`;
    }catch(error){if(token!==generation)return;model=null;$('admin-preview').replaceChildren();$('admin-errors').textContent=error.message||'無法解析班表。';$('import-status').textContent='匯入失敗，請修正來源檔後重新選擇。';}
  }
  function resetPublication() {
    publicationState='idle';expectedHash=null;
    $('publish-status').textContent='完成日期與四週期確認後即可發布；新班表會取代目前班表。';
  }
  function syncPublication() {
    const authorized=window.NSSAdminAuth.isActive();
    $('admin-publish').textContent=publishing?'處理中…':publicationState==='unknown'?'重新確認發布結果':publicationState==='success'?'已發布':'確認發布';
    $('admin-publish').disabled=publishing||!authorized||!model?.validation.readyForSearch||publicationState==='success';
    $('admin-file').disabled=publishing||!authorized;
    $('admin-cycle-start').disabled=publishing||!model;
    $('admin-confirm-cycle').disabled=publishing||!model||model.cycleConfirmed;
    $('admin-sheet').disabled=publishing;$('parse-sheet').disabled=publishing;
    for(const button of $('admin-errors').querySelectorAll('button'))button.disabled=publishing;
  }
  async function fingerprint(payload) {
    const copy={...payload,publishedAt:'1970-01-01T00:00:00.000Z'};
    const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(copy)));
    return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function publicationRequest(path,body) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const result=await fetch('/api/admin/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
      // A failed/unreadable response is not proof that KV was left unchanged.
      const data=await result.json();return {ok:result.ok,status:result.status,data};
    }finally{clearTimeout(timer);}
  }
  async function checkPublication(token) {
    publicationState='unknown';
    $('publish-status').textContent='發布結果尚未確認，正在查詢；請勿重複發布。';
    try {
      const result=await publicationRequest('publication');
      if(token!==generation)return;
      if(result.status===401){window.NSSAdminAuth.expire();return;}
      if(result.ok&&result.data.contentHash===expectedHash) {
        publicationState='success';$('publish-status').textContent='已確認目前單位班表與本次發布內容相同；其他裝置可能需要稍候再重新載入。';return;
      }
    }catch {if(token!==generation)return;}
    $('publish-status').textContent='尚無法確認發布結果，可能仍在同步。請稍後按「重新確認發布結果」；此按鈕只查詢，不會再次發布。';
  }
  $('admin-publish').addEventListener('click',async()=>{
    if(publishing||!model||!active())return;
    // Rechecking an uncertain result never sends another POST.
    const token=generation,rechecking=publicationState==='unknown';
    if(publicationState==='success')return;
    publishing=true;syncPublication();let sent=false;
    try {
      if(rechecking){await checkPublication(token);return;}
      const payload=ns.SchedulePublication.create(model);
      expectedHash=await fingerprint(payload);
      if(token!==generation||!window.NSSAdminAuth.isActive())return;
      $('publish-status').textContent='正在發布，請稍候…';sent=true;
      const result=await publicationRequest('publish',payload);
      if(token!==generation)return;
      if(result.status===401){publishing=false;publicationState='idle';window.NSSAdminAuth.expire();$('publish-status').textContent='發布失敗：登入已失效，未更新班表。';return;}
      if(result.ok&&result.data.published===true&&result.data.contentHash===expectedHash) {
        publicationState='success';$('publish-status').textContent='發布成功。新班表已儲存，同仁稍候重新載入即可取得更新。';
      }else if([400,403,405,413,415,422,429].includes(result.status)) {
        publicationState='idle';
        const messages={synthetic_only:'目前測試環境只接受合成班表。',publication_too_large:'班表資料過大，未發布。',too_many_attempts:'發布次數過於頻繁，請稍後重試。'};
        $('publish-status').textContent=messages[result.data.error]||'發布失敗：權限或班表驗證未通過，未更新班表。';
      }else await checkPublication(token);
    }catch {
      if(token!==generation)return;
      if(sent)await checkPublication(token);
      else {$('publish-status').textContent='無法準備發布資料，請確認日期與班表驗證結果。';publicationState='idle';}
    }finally{publishing=false;syncPublication();}
  });
  $('admin-file').addEventListener('change',()=>{
    if(publishing)return;
    const selected=$('admin-file').files[0];clear();if(!selected||!active())return;
    file=selected;$('admin-file').disabled=false;parse();
  });
  $('parse-sheet').addEventListener('click',()=>parse($('admin-sheet').value));
  $('admin-sheet').addEventListener('change',()=>{if(publishing)return;resetPublication();$('admin-publish').disabled=true;generation++;model=null;$('admin-preview').replaceChildren();$('admin-cycle-start').disabled=true;$('admin-cycle-start').value='';$('admin-cycle-end').textContent='—';$('cycle-status').textContent='';$('admin-confirm-cycle').disabled=true;$('admin-errors').textContent='工作表已變更，請重新解析。';});
  $('admin-cycle-start').addEventListener('change',()=>{if(!publishing&&model&&active()){resetPublication();C.setCycleStart(model,$('admin-cycle-start').value);render();}});
  $('admin-confirm-cycle').addEventListener('click',()=>{if(!publishing&&model&&active()){C.confirmCycle(model);render();}});
  window.addEventListener('admin-session-ended',clear);
  window.addEventListener('admin-session-ready',syncPublication);
  window.NSSAdminAuth.ready.then(syncPublication);
})();
