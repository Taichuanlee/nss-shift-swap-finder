/* Versioned, memory-only publication adapter. No network or persistent storage. */
(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  const FORMAT = 'nss-shift-swap-finder.schedule', VERSION = 2;
  const fail = () => { throw new Error('班表發布資料格式不支援、資料不完整或驗證未通過。'); };
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function keys(v, expected) {
    if (!record(v) || Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v,k))) fail();
  }
  function date(v) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || ns.ImportConfirmation.addDays(v,0) !== v) fail(); }
  function identity(v) { if (typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length>128) fail(); }
  function list(v,max=366) {if(!Array.isArray(v)||v.length>max)fail();}
  function source(v) {
    keys(v,['page','row','table','sheet']);
    if(v.page!==null&&(!Number.isSafeInteger(v.page)||v.page<1))fail();
    for(const k of ['row','table'])if(!Number.isSafeInteger(v[k])||v[k]<0)fail();
    if(v.sheet!==null)identity(v.sheet);
  }
  function sourceOf(row) {return {page:row.source?.page??null,row:row.row??row.headerRow??0,table:row.tableIndex??0,sheet:row.source?.sheet??null};}
  function evidence(v, dates) {
    keys(v,['sourceType','sourceEvidenceAvailable','cycleConfirmed','confirmedYear','corrections']);
    if(!['pdf','excel','publication'].includes(v.sourceType)||typeof v.sourceEvidenceAvailable!=='boolean'||v.cycleConfirmed!==true)fail();
    if(v.confirmedYear!==null&&(!Number.isInteger(v.confirmedYear)||v.confirmedYear<1900||v.confirmedYear>2199))fail();
    list(v.corrections);
    for(const c of v.corrections){keys(c,['originalRaw','correctedDate','confirmedBy','source']);identity(c.originalRaw);date(c.correctedDate);source(c.source);
      if(!dates.includes(c.correctedDate)||!['user','automatic'].includes(c.confirmedBy))fail();}
  }
  function load(p) {
    const v2=p?.schemaVersion===2;
    keys(p,['format','schemaVersion','publishedAt','cycle','dates','employees',...(v2?['scope','cycleDates','referenceDates','provenance']:[])]);
    if(p.format!==FORMAT||![1,2].includes(p.schemaVersion)||typeof p.publishedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.publishedAt)||!Number.isFinite(Date.parse(p.publishedAt))||new Date(p.publishedAt).toISOString()!==p.publishedAt)fail();
    keys(p.cycle,['startDate','endDate']);date(p.cycle.startDate);date(p.cycle.endDate);
    list(p.dates);list(p.employees,1000);if(!p.dates.length||!p.employees.length)fail();p.dates.forEach(date);
    const formal=Array.from({length:28},(_,i)=>ns.ImportConfirmation.addDays(p.cycle.startDate,i));
    const refs=p.dates.filter(d=>d<p.cycle.startDate||d>p.cycle.endDate);
    if(v2){identity(p.scope);list(p.cycleDates);list(p.referenceDates);
      if(JSON.stringify(p.cycleDates)!==JSON.stringify(formal)||JSON.stringify(p.referenceDates)!==JSON.stringify(refs))fail();
      evidence(p.provenance,p.dates);}
    const m=ns.Model.create('publication');m.scheduleDates=[...p.dates];m.scheduleStartDate=p.dates[0];m.scheduleEndDate=p.dates.at(-1);
    const ids=new Set(),numbers=new Set(),sourceOwners=new Map();
    m.employees=p.employees.map(e=>{
      keys(e,['id','name','shifts',...(v2?['employeeNumber','sourceRows']:[])]);identity(e.id);identity(e.name);
      if(ids.has(e.id)||e.id.startsWith('unresolved-')||(!v2&&e.id.startsWith('local-record:')))fail();ids.add(e.id);
      const number=v2?e.employeeNumber:e.id;
      if(number!==null){identity(number);if(numbers.has(number))fail();numbers.add(number);}
      if(v2&&!e.id.startsWith(`local-record:${p.scope}:`))fail();
      const rows=v2?e.sourceRows:[];list(rows,1000);rows.forEach(source);
      if(number===null&&!rows.length)fail();
      for(const row of rows){const key=JSON.stringify([row.page,row.row,row.table,row.sheet]);if(sourceOwners.has(key)&&sourceOwners.get(key)!==e.id)fail();sourceOwners.set(key,e.id);}
      keys(e.shifts,p.dates);const shifts=Object.create(null);
      for(const d of p.dates){const code=e.shifts[d];if(typeof code!=='string'||!['work','leave','blank'].includes(ns.Model.classify(code)))fail();shifts[d]=ns.Model.classify(code)==='blank'?'':code;}
      return {id:e.id,name:e.name,employeeNumber:number,sourceRows:JSON.parse(JSON.stringify(rows)),shifts,shiftSources:Object.create(null),shiftDetails:Object.create(null),identityResolved:true};
    });
    m.importScope=v2?p.scope:`legacy-${p.publishedAt}`;m.requiresPublicationV2=m.employees.some(e=>e.employeeNumber===null);
    m.cycleStartDate=p.cycle.startDate;m.cycleEndDate=p.cycle.endDate;m.cycleSource='publication';m.cycleConfirmed=true;
    m.importConfirmation={dateSuggestions:[]};m.dateCorrections=[];
    ns.Validator.validate(m);if(!m.validation.readyForSearch)fail();
    // Coverage means provided cells only. Neither schema can prove missing boundary days are rest days.
    m.publication={schemaVersion:p.schemaVersion,publishedAt:p.publishedAt,referenceCoverage:'provided-only',sourceEvidenceAvailable:v2&&p.provenance.sourceEvidenceAvailable};
    if(v2)m.publication.provenance=JSON.parse(JSON.stringify(p.provenance));
    return m;
  }
  function create(model,{version=VERSION}={}) {
    if(![1,2].includes(version))fail();
    const m=JSON.parse(JSON.stringify(model));
    if(m.importConfirmation?.dateSuggestions.some(s=>!ns.ImportConfirmation.resolved(s)))fail();
    ns.Validator.validate(m);if(!m.validation.readyForSearch)fail();
    if(version===1&&m.employees.some(e=>e.employeeNumber===null||e.id.startsWith('local-record:')))fail();
    const scope=m.importScope||`legacy-${m.cycleStartDate}`;
    const p={format:FORMAT,schemaVersion:version,publishedAt:new Date().toISOString(),cycle:{startDate:m.cycleStartDate,endDate:m.cycleEndDate},dates:[...m.scheduleDates],
      employees:m.employees.map((e,index)=>({id:version===2&&!e.id.startsWith(`local-record:${scope}:`)?`local-record:${scope}:record:${index}`:e.id,name:e.name,shifts:Object.fromEntries(m.scheduleDates.map(d=>[d,e.shifts[d]??''])),...(version===2?{
        employeeNumber:e.employeeNumber===undefined?e.id:e.employeeNumber,
        sourceRows:(e.sourceRows||[]).map(row=>Object.hasOwn(row,'table')?row:sourceOf(row))}: {})}))};
    if(version===2){p.scope=scope;
      p.cycleDates=Array.from({length:28},(_,i)=>ns.ImportConfirmation.addDays(m.cycleStartDate,i));p.referenceDates=m.scheduleDates.filter(d=>!p.cycleDates.includes(d));
      p.provenance=m.publication?.provenance||{sourceType:['pdf','excel'].includes(m.sourceType)?m.sourceType:'publication',sourceEvidenceAvailable:m.sourceType!=='publication',cycleConfirmed:true,confirmedYear:m.confirmedYear??null,
        corrections:(m.dateCorrections||[]).map(c=>({originalRaw:c.originalRaw,correctedDate:c.correctedDate,confirmedBy:c.confirmedBy,source:sourceOf(c)}))};}
    load(p);return p;
  }
  function serialize(model) {return JSON.stringify(create(model),null,2);}
  function deserialize(text) {if(typeof text!=='string'||text.length>25*1024*1024)fail();let p;try{p=JSON.parse(text);}catch{fail();}return load(p);}
  ns.SchedulePublication=Object.freeze({FORMAT,VERSION,create,load,serialize,deserialize});
})();
