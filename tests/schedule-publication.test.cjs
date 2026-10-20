// All schedules and identities in this suite are synthetic and stay in memory.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {dates,grid,items}=require('./fixtures.cjs');
const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const name of ['schedule-model','schedule-validator','import-confirmation','schedule-publication','personal-schedule','swap-engine','excel-parser','pdf-parser'])
 vm.runInContext(fs.readFileSync(`js/${name}.js`,'utf8'),ctx);
vm.runInContext(fs.readFileSync('vendor/sheetjs/xlsx.full.min.js','utf8'),ctx);
const ns=ctx.window.NSSShiftSwapFinder,P=ns.SchedulePublication;
const plain=x=>JSON.parse(JSON.stringify(x));
function setup() {
 const ds=dates(40,Date.UTC(2026,10,4));
 const rows=[['Synthetic'],['ID','Name',...ds],
  ['SELF','Synthetic Self',...ds.map((_,i)=>i===8?'A':'OF')],
  ['OTHER','Synthetic Other',...ds.map((_,i)=>i===15?'A':'O')]];
 let m=ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map(r=>r.map(value=>({value})))}],'excel');
 m=ns.ImportConfirmation.initialize(m);
 ns.ImportConfirmation.setCycleStart(m,ds[5]);assert.equal(ns.ImportConfirmation.confirmCycle(m),true);
 return {m,ds};
}
test('round trip retains every date, identity, leave code, calendar and all search results without mutation',()=>{
 const {m,ds}=setup(),before=JSON.stringify(m),loaded=P.deserialize(P.serialize(m));
 assert.equal(JSON.stringify(m),before);
 assert.deepEqual(plain(loaded.scheduleDates),ds);
 assert.equal(loaded.scheduleStartDate,ds[0]);assert.equal(loaded.scheduleEndDate,ds.at(-1));
 for(const employee of m.employees) {
  assert.deepEqual(plain(ns.PersonalSchedule.calendar(loaded,employee.id)),plain(ns.PersonalSchedule.calendar(m,employee.id)));
  const options=ns.SwapEngine.options(m,employee.id);
  for(const day of options.workDates) assert.deepEqual(plain(ns.SwapEngine.search(loaded,employee.id,day,options.leaveDates)),plain(ns.SwapEngine.search(m,employee.id,day,options.leaveDates)));
 }
 assert.equal(ns.SwapEngine.search(loaded,'SELF',ds[8],[ds[15]])[0].results.length,1);
 const p=P.create(m);p.employees[0].shifts[ds[0]]='N';assert.equal(m.employees[0].shifts[ds[0]],'OF');
 loaded.employees[0].shifts[ds[0]]='E';assert.equal(m.employees[0].shifts[ds[0]],'OF');
});
test('pre/post-cycle work runs and exclusions survive publication',()=>{
 for(const indices of [[0,1,2,3,4,5,6,7],[29,30,31,32,33,34,35,36]]) {
  const {m,ds}=setup();for(const i of indices)m.employees[1].shifts[ds[i]]='A';
  const day=indices[0]===0?ds[5]:ds[32];m.employees[0].shifts[day]='A';m.employees[1].shifts[day]='O';
  const loaded=P.deserialize(P.serialize(m));
  assert.deepEqual(plain(ns.SwapEngine.search(loaded,'SELF',day,[ds[15]])),plain(ns.SwapEngine.search(m,'SELF',day,[ds[15]])));
 }
});
test('rejects unsupported schema, malformed dates/cycles, identities, missing/extra/unknown shifts and forged flags',()=>{
 const {m,ds}=setup();
 const cases=[p=>p.schemaVersion=2,p=>p.format='other',p=>p.publishedAt='bad',
  p=>p.dates[0]='2026-02-30',p=>p.dates.reverse(),p=>p.dates[1]=p.dates[0],p=>p.dates.splice(2,1),
  p=>p.cycle.endDate=ds[6],p=>p.cycle.startDate='2025-01-01',
  p=>p.employees[1].id=p.employees[0].id,p=>p.employees[0].name='',p=>p.employees[0].id='unresolved-1',
  p=>delete p.employees[0].shifts[ds[0]],p=>p.employees[0].shifts['2030-01-01']='O',
  p=>p.employees[0].shifts[ds[0]]='OX',p=>p.employees[0].shifts[ds[0]]='',
  p=>p.employees[0].shifts[ds[0]]=null,p=>p.validation={readyForSearch:true},p=>p.employees=[],p=>p.dates=null];
 for(const change of cases) {const p=plain(P.create(m));change(p);assert.throws(()=>P.load(p));}
 for(const value of ['{','null','[]','"test"'])assert.throws(()=>P.deserialize(value));
 assert.throws(()=>P.deserialize(' '.repeat(25*1024*1024+1)));
});
test('export revalidates and refuses unconfirmed, invalid or unresolved sources',()=>{
 for(const change of [m=>m.cycleConfirmed=false,m=>m.employees[0].shifts[m.scheduleDates[0]]='OX',
  m=>m.importConfirmation.dateSuggestions.push({status:'pending'}),m=>m.errors.push({scope:'global',code:'SYNTHETIC'})]) {
  const {m}=setup();change(m);m.validation.readyForSearch=true;const before=JSON.stringify(m);
  assert.throws(()=>P.serialize(m));assert.equal(JSON.stringify(m),before);
 }
});
test('only approved fields are exported; loaded models do not pretend to retain raw parser evidence',()=>{
 const {m}=setup();m.pdfNonDailyColumns={secret:'synthetic private note'};
 const text=P.serialize(m);assert.doesNotMatch(text,/secret|shiftDetails|sourceInfo|dateCorrections|validation/);
 const loaded=P.deserialize(text);assert.equal(loaded.validation.readyForSearch,true);
 assert.equal(ns.Model.dateCellsPreserved(loaded),false);
 assert.deepEqual(plain(ns.ImportConfirmation.initialize(loaded)),plain(loaded));
});
test('existing Excel and PDF parser outputs can both publish after cycle confirmation',async()=>{
 const rows=grid(),X=ctx.window.XLSX,wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet(rows),'Synthetic');
 const bytes=X.write(wb,{type:'array',bookType:'xlsx'});
 const excel=await ns.ExcelParser.parse({arrayBuffer:async()=>bytes});
 const pdf=ns.PdfParser.positionedTables([{pageNumber:1,items:items(rows)}]);
 for(let m of [excel,pdf]) {
  m=ns.ImportConfirmation.initialize(m);ns.ImportConfirmation.setCycleStart(m,m.scheduleDates[0]);
  assert.equal(ns.ImportConfirmation.confirmCycle(m),true);
  const loaded=P.deserialize(P.serialize(m));assert.equal(loaded.validation.readyForSearch,true);
  assert.deepEqual(plain(loaded.employees.map(e=>e.shifts)),plain(m.employees.map(e=>e.shifts)));
 }
});
test('cross-year and leap-day ranges round trip without timezone shifts',()=>{
 for(const start of ['2026-12-20','2028-02-10']) {
  const ds=dates(40,Date.parse(start));
  let m=ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:grid(ds).map(r=>r.map(value=>({value})))}],'excel');
  m=ns.ImportConfirmation.initialize(m);ns.ImportConfirmation.setCycleStart(m,ds[5]);
  assert.equal(ns.ImportConfirmation.confirmCycle(m),true);
  const loaded=P.deserialize(P.serialize(m));
  assert.deepEqual(plain(loaded.scheduleDates),ds);
  assert.deepEqual(plain(ns.SwapEngine.options(loaded,'EXAMPLE001')),plain(ns.SwapEngine.options(m,'EXAMPLE001')));
 }
});
