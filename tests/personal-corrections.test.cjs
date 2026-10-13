const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {dates}=require('./fixtures.cjs');
const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','import-confirmation','personal-schedule','swap-engine','swap-ui'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
const ns=ctx.window.NSSShiftSwapFinder;
function fixture(){
 const ds=dates(33),rows=[['ID','Name',...ds],['SELF','Synthetic Self',...ds.map((_,i)=>i===8?'A休':i===9?'E休':i===10?'N休':'OF')],['OTHER','Synthetic Other',...ds.map((_,i)=>i===15?'A':'ON')],['EVENING','Synthetic Evening',...ds.map((_,i)=>i===15?'E':'OZ')]];
 const model=ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map(row=>row.map(value=>({value})))}],'excel');
 model.cycleStartDate=ds[0];model.cycleEndDate=ds[27];model.cycleConfirmed=true;ns.Validator.validate(model);
 return {model,ds,session:ns.PersonalSchedule.createCorrections(model,'SELF')};
}
test('correction overlay preserves annotations, raw cells and all original employees',()=>{
 const {model,ds,session}=fixture(),before=JSON.stringify(model);
 assert.equal(session.display()[8].code,'A');assert.equal(session.display()[9].code,'E');assert.equal(session.display()[10].code,'N');
 assert.equal(session.display()[15].code,'OF');assert.equal(session.display().some(d=>d.modified),false);
 session.set(ds[8],'E');const effective=session.effective();
 assert.equal(effective.employees[0].shifts[ds[8]],'E');assert.equal(effective.employees[0].shifts[ds[15]],'OF');
 assert.equal(effective.employees[1],model.employees[1]);assert.equal(effective.employees[2],model.employees[2]);
 assert.equal(session.display()[8].originalCode,'A');assert.equal(session.display()[8].modified,true);
 assert.ok(model.employees[0].shiftDetails[ds[8]].some(d=>d.raw==='A休'));
 assert.equal(JSON.stringify(model),before);
});
test('A to E matches only E; corrected data drives search and candidate preview',()=>{
 const {model,ds,session}=fixture();session.set(ds[8],'E');
 const groups=ns.SwapEngine.search(session.effective(),'SELF',ds[8],[ds[15]]);
 assert.deepEqual(Array.from(groups[0].results,r=>r.employeeId),['EVENING']);
 const preview=ns.SwapUI.previewDays(session.effective(),groups[0].results[0]);
 assert.equal(preview[8].code,'E');assert.equal(preview[8].beforeCode,'OZ');assert.equal(preview[15].code,'OF');
 assert.equal(model.employees[0].shifts[ds[8]],'A');
});
test('work/leave options update, single/all restoration preserve special leave codes',()=>{
 const {ds,session}=fixture();session.set(ds[8],'O');session.set(ds[15],'A');
 let options=ns.SwapEngine.options(session.effective(),'SELF');
 assert.equal(options.workDates.includes(ds[8]),false);assert.equal(options.workDates.includes(ds[15]),true);
 assert.equal(options.leaveDates.includes(ds[8]),true);
 session.restore(ds[8]);assert.equal(session.display()[8].code,'A');assert.equal(session.display()[15].code,'A');
 session.reset();assert.equal(session.display()[15].code,'OF');assert.equal(session.display().some(d=>d.modified),false);
});
test('only four manual options and confirmed personal 28 days are accepted',()=>{
 const {model,ds,session}=fixture();
 for(const code of ['A休','E休','N休','OF','ON','OZ','A特','休','OX',''])assert.throws(()=>session.set(ds[8],code));
 assert.throws(()=>session.set(ds[28],'A'));assert.throws(()=>session.restore(ds[28]));
 model.cycleConfirmed=false;assert.throws(()=>ns.PersonalSchedule.createCorrections(model,'SELF'));
});
test('effective edits participate in existing run/fragmentation checks without changing source',()=>{
 const {model,ds,session}=fixture(),before=JSON.stringify(model);
 for(const i of [13,14,16,17,18])session.set(ds[i],'A');
 const r=ns.SwapEngine.search(session.effective(),'SELF',ds[8],[ds[15]])[0].results[0];
 assert.equal(r.risks.consecutive,true);assert.match(r.warnings.join(' '),/連續上班 6 天/);
 assert.equal(JSON.stringify(model),before);
});
test('new identity/import/session never inherits corrections; no persisted shift storage',()=>{
 const {model,ds,session}=fixture();session.set(ds[8],'E');
 assert.equal(ns.PersonalSchedule.createCorrections(model,'SELF').display()[8].code,'A');
 assert.equal(ns.PersonalSchedule.createCorrections(model,'OTHER').display()[8].code,'ON');
 const block=fs.readFileSync('js/personal-schedule.js','utf8').split('function createCorrections')[1].split('// Shared')[0];
 assert.doesNotMatch(block,/localStorage|sessionStorage|indexedDB|cookie|fetch/);
});

test('changing the formal cycle invalidates a correction session',()=>{
 const {model,ds,session}=fixture();session.set(ds[8],'E');
 model.cycleStartDate=ds[1];model.cycleEndDate=ds[28];
 assert.throws(()=>session.effective());assert.throws(()=>session.set(ds[8],'N'));
});
