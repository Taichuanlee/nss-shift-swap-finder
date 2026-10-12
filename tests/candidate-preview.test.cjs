const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {dates,grid,items}=require('./fixtures.cjs');
const ctx={window:{},Date,Set,Uint8Array};vm.createContext(ctx);
for(const file of ['schedule-model','schedule-validator','pdf-parser','import-confirmation','personal-schedule','swap-engine','swap-ui'])vm.runInContext(fs.readFileSync(`js/${file}.js`,'utf8'),ctx);
const ns=ctx.window.NSSShiftSwapFinder;
function fixture(start) {
 const ds=dates(33,new Date(`${start}T00:00:00Z`).getTime());
 const rows=grid(ds).slice(0,2);
 rows.push(['SELF','Synthetic Self',...ds.map((_,i)=>i===8?'A':'OF')]);
 rows.push(['OTHER','Synthetic Other',...ds.map((_,i)=>[15,20].includes(i)?'A':'ON')]);
 rows.push(['CROSS','Synthetic Cross',...ds.map((_,i)=>i===15?'N':'OZ')]);
 const model=ns.ImportConfirmation.initialize(ns.PdfParser.positionedTables([{pageNumber:1,items:items(rows)}]));
 ns.ImportConfirmation.setCycleStart(model,start);ns.ImportConfirmation.confirmCycle(model);
 return {model,ds};
}
for(const start of ['2026-11-04','2026-12-23','2028-02-15'])test(`candidate preview keeps exact 28 dates and both simulated shifts: ${start}`,()=>{
 const {model,ds}=fixture(start),groups=ns.SwapEngine.search(model,'SELF',ds[8],[ds[15],ds[20]],{emergency:true});
 const original=JSON.stringify(model),resultSnapshot=JSON.stringify(groups);
 for(const group of groups)for(const result of group.results){
  const days=ns.SwapUI.previewDays(model,result),employee=model.employees.find(e=>e.id===result.employeeId);
  assert.equal(days.length,28);assert.equal(days.filter(d=>d.exchanged).length,2);
  for(let i=0;i<28;i++){
   const day=days[i];assert.equal(day.date,ds[i]);
   assert.equal(day.weekday,['日','一','二','三','四','五','六'][new Date(`${ds[i]}T00:00:00Z`).getUTCDay()]);
   const changed=[result.wantedDate,result.exchangeDate].includes(day.date);
   assert.equal(day.code,changed?result.other.after[day.date]:employee.shifts[day.date]);
   assert.equal(day.kind,ns.Model.classify(day.code));
   if(changed)assert.equal(day.beforeCode,employee.shifts[day.date]);
  }
  assert.equal(days.some(d=>d.date===ds[28]),false);
  // Preview objects are independent and cannot mutate the original schedule.
  days[0].code='N';
 }
 assert.equal(JSON.stringify(model),original);assert.equal(JSON.stringify(groups),resultSnapshot);
 assert.equal(JSON.stringify(ns.SwapEngine.search(model,'SELF',ds[8],[ds[15],ds[20]],{emergency:true})),resultSnapshot);
});
test('candidate and exchange-date previews remain independent',()=>{
 const {model,ds}=fixture('2026-12-23');
 const groups=ns.SwapEngine.search(model,'SELF',ds[8],[ds[15],ds[20]],{emergency:true});
 const other=ns.SwapUI.previewDays(model,groups[0].results.find(r=>r.employeeId==='OTHER'));
 const cross=ns.SwapUI.previewDays(model,groups[0].results.find(r=>r.employeeId==='CROSS'));
 const later=ns.SwapUI.previewDays(model,groups[1].results[0]);
 assert.equal(other[0].code,'ON');assert.equal(cross[0].code,'OZ');
 assert.equal(other[15].beforeCode,'A');assert.equal(cross[15].beforeCode,'N');
 assert.equal(cross[8].code,'A');assert.equal(cross[15].code,'OF');
 assert.equal(other[15].code,'OF');assert.equal(later[15].code,'A');
 assert.equal(other[20].code,'A');assert.equal(later[20].code,'OF');
});
test('unconfirmed, stale, invalid or out-of-cycle previews are refused',()=>{
 const {model,ds}=fixture('2026-12-23');
 const result=ns.SwapEngine.search(model,'SELF',ds[8],[ds[15]])[0].results[0];
 assert.throws(()=>ns.SwapUI.previewDays(model,{...result,exchangeDate:ds[28]}));
 assert.throws(()=>ns.SwapUI.previewDays(model,{...result,exchangeDate:ds[8]}));
 assert.throws(()=>ns.SwapUI.previewDays(model,{...result,employeeId:'missing'}));
 model.employees.find(e=>e.id==='OTHER').shifts[ds[8]]='N';
 assert.throws(()=>ns.SwapUI.previewDays(model,result));
 model.cycleConfirmed=false;assert.throws(()=>ns.SwapUI.previewDays(model,result));
});
