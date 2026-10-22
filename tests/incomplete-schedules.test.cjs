// Fictional rows only; no hospital documents or identities.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {dates,items}=require('./fixtures.cjs');
const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','import-confirmation','schedule-publication','personal-schedule','swap-engine','pdf-parser','excel-parser'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
vm.runInContext(fs.readFileSync('vendor/sheetjs/xlsx.full.min.js','utf8'),ctx);ctx.window.XLSX=ctx.XLSX;
const ns=ctx.window.NSSShiftSwapFinder,ds=dates(40,Date.UTC(2026,10,4));
function rows(){return [['Synthetic 2026-11-09 ~ 2026-12-06'],['ID','Name',...ds],['SELF','Fictional Self',...ds.map((_,i)=>i===8?'A':'OF')],['OTHER','Fictional Other',...ds.map((_,i)=>i===15?'A':'O')],['EMPTY','Fictional Empty',...ds.map(()=> '')]];}
function ready(m){ns.ImportConfirmation.initialize(m,{autoCorrect:false});ns.ImportConfirmation.setCycleStart(m,ds[5]);assert.equal(ns.ImportConfirmation.confirmCycle(m),true);return m;}
function model(){return ready(ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows().map(r=>r.map(value=>({value})))}],'excel'));}
test('PDF with empty text cells omitted retains identities, all blank rows and partial days',()=>{
 const r=rows();r[2][2]='';
 const m=ready(ns.PdfParser.positionedTables([{pageNumber:1,items:items(r).filter(i=>i.str!=='')} ]));
 assert.equal(m.employees.length,3);assert.equal(m.employees[2].id,'EMPTY');assert.equal(m.employees[2].name,'Fictional Empty');
 assert.ok(ds.every(d=>m.employees[2].shifts[d]===''));assert.equal(m.employees[0].shifts[ds[0]],'');
 assert.equal(m.validation.readyForSearch,true);assert.equal(m.validation.shiftsComplete,false);assert.equal(m.employees[2].validation.eligible,false);
 assert.ok(m.warnings.some(w=>w.code==='BLANK_SHIFT'));assert.equal(m.errors.length,0);
});
test('Excel XLS/XLSX and publication round trip preserve blank values and every identity',async()=>{
 const XLSX=ctx.XLSX||ctx.window.XLSX;
 for(const type of ['xlsx','xls']) {
  const r=rows();r[2][2]='';const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(r),'Synthetic');
  const bytes=XLSX.write(book,{type:'array',bookType:type});const m=ready(await ns.ExcelParser.parse({arrayBuffer:async()=>bytes}));
  const p=ns.SchedulePublication.create(m),loaded=ns.SchedulePublication.load(p);
  assert.equal(loaded.employees.length,3);assert.ok(ds.every(d=>p.employees[2].shifts[d]===''));assert.equal(p.employees[0].shifts[ds[0]],'');
  assert.equal(ns.PersonalSchedule.calendar(loaded,'EMPTY')[0].kind,'blank');assert.equal(ns.SwapEngine.options(loaded,'EMPTY').workDates.length,0);
  assert.equal(ns.SwapEngine.search(loaded,'SELF',ds[8],[ds[15]])[0].results.length,1);
  const correction=ns.PersonalSchedule.createCorrections(loaded,'EMPTY');assert.throws(()=>correction.set(ds[5],'O'));
 }
});
test('known swaps survive distant blanks; unknown swapped days and risk neighborhoods are excluded',()=>{
 const m=model(),self=m.employees[0],other=m.employees[1],search=()=>ns.SwapEngine.search(m,'SELF',ds[8],[ds[15]])[0];
 other.shifts[ds[38]]='';self.shifts[ds[39]]='';ns.Validator.validate(m);
 assert.equal(search().results.length,1);assert.equal(ns.SwapEngine.options(m,'SELF').leaveDates.includes(ds[39]),false);
 other.shifts[ds[15]]='';ns.Validator.validate(m);assert.equal(search().results.length,0);
 other.shifts[ds[15]]='A';other.shifts[ds[7]]='';ns.Validator.validate(m);assert.equal(search().results.length,0);
 other.shifts[ds[7]]='O';for(let i=9;i<=14;i++)other.shifts[ds[i]]='A';other.shifts[ds[16]]='';ns.Validator.validate(m);assert.equal(search().results.length,0);
 assert.throws(()=>ns.SwapEngine.search(m,'EMPTY',ds[8],[ds[15]]));
});
test('unknown nonblank codes, conflicts, identity and date failures remain blocking',()=>{
 const m=model();m.employees[0].shifts[ds[0]]='OX';ns.Validator.validate(m);assert.equal(m.validation.readyForSearch,false);assert.throws(()=>ns.SchedulePublication.create(m));
 const p=ns.SchedulePublication.create(model());delete p.employees[0].shifts[ds[0]];assert.throws(()=>ns.SchedulePublication.load(p));
});
