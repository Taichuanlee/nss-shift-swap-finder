const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {dates}=require('./fixtures.cjs');const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','import-confirmation','personal-schedule','swap-engine','swap-ui'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
const ns=ctx.window.NSSShiftSwapFinder,E=ns.SwapEngine;
function setup(count=33,start='2026-11-04',cycleOffset=5) {
 const ds=dates(count,Date.parse(start));
 const rows=[['Synthetic schedule'],['ID','Name',...ds],['SELF','Synthetic Self',...ds.map(()=> 'OF')],['OTHER','Synthetic Other',...ds.map(()=> 'O')]];
 const m=ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map(r=>r.map(value=>({value})))}],'excel');
 m.cycleStartDate=ds[cycleOffset];m.cycleEndDate=ds[cycleOffset+27];m.cycleConfirmed=true;
 const self=m.employees[0],other=m.employees[1],d1=ds[cycleOffset+3],d2=ds[cycleOffset+10];
 self.shifts[d1]='A';other.shifts[d2]='A';ns.Validator.validate(m);
 assert.equal(m.validation.readyForSearch,true);return {m,ds,self,other,d1,d2};
}
function result(s,d2=s.d2){return E.search(s.m,'SELF',s.d1,[d2])[0];}

const baselineContext={window:{},Date,Set};vm.createContext(baselineContext);
for(const f of ['js/schedule-model.js','js/schedule-validator.js','js/import-confirmation.js','js/personal-schedule.js','tests/baseline/b0-swap-engine.js'])vm.runInContext(fs.readFileSync(f,'utf8'),baselineContext);
const B0=baselineContext.window.NSSShiftSwapFinder.SwapEngine;
const special=(s,shift='E',days=[s.d2])=>E.search(s.m,'SELF',s.d1,days,{mode:'special',targetShift:shift})[0];
test('all nine specified work pairs simulate all four assignments without mutation and preview correctly',()=>{
 for(const a of ['A','E','N'])for(const b of ['A','E','N']) {
  const s=setup();s.self.shifts[s.d1]=a;s.other.shifts[s.d2]=b;const before=JSON.stringify(s.m);
  const r=special(s,b).results[0];assert.ok(r);assert.equal(r.sameShift,a===b);
  assert.equal(r.self.after[s.d1],'O');assert.equal(r.self.after[s.d2],b);
  assert.equal(r.other.after[s.d1],a);assert.equal(r.other.after[s.d2],'OF');
  assert.equal(ns.SwapUI.previewDays(s.m,r).find(d=>d.date===s.d1).code,a);
  assert.equal(JSON.stringify(s.m),before);
  assert.equal(special(s,b==='A'?'N':'A').results.length,0);
  s.other.shifts[s.d1]='N';assert.equal(special(s,b).excluded.direction,1);
 }
});
test('special input requires exactly one D2 and an explicit A/E/N target',()=>{
 const s=setup();
 for(const days of [[],[s.d2,s.d2],[s.d2,s.ds[20]],[s.d1]])assert.throws(()=>special(s,'E',days));
 for(const shift of [undefined,null,'O','e','',true])assert.throws(()=>E.search(s.m,'SELF',s.d1,[s.d2],{mode:'special',targetShift:shift}));
});
test('special retains B0 other six-day exclusion, self warning, fragmentation and unknown-data checks',()=>{
 let s=setup();s.other.shifts[s.d2]='E';for(let i=3;i<8;i++)s.other.shifts[s.ds[i]]='N';
 assert.equal(special(s).excluded.consecutive,1);
 s=setup();s.other.shifts[s.d2]='E';for(let i=13;i<=19;i++)if(s.ds[i]!==s.d2)s.self.shifts[s.ds[i]]='N';
 let r=special(s).results[0];assert.equal(r.risks.consecutive,true);assert.match(ns.SwapUI.visibleWarnings(r).join(' '),/連續上班 7 天/);
 s=setup();s.other.shifts[s.d2]='E';s.self.shifts[s.ds[7]]='A';s.other.shifts[s.ds[9]]='E';s.d2=s.ds[9];
 r=special(s).results[0];assert.equal(r.risks.fragmented,true);assert.match(ns.SwapUI.visibleWarnings(r).join(' '),/破碎班/);
 s=setup();s.other.shifts[s.d2]='E';s.other.shifts[s.ds[7]]='';assert.equal(special(s).excluded.invalid,1);
});
test('boundary data and sorting persist internally while presentation omits only boundary warning',()=>{
 const s=setup(28,'2026-12-07',0);s.self.shifts[s.d1]='OF';s.d1=s.ds[0];s.self.shifts[s.d1]='A';s.other.shifts[s.d2]='E';
 const r=special(s).results[0];assert.equal(r.risks.context,true);assert.match(r.warnings.join(' '),/邊界參考不足/);
 assert.doesNotMatch(ns.SwapUI.visibleWarnings(r).join(' '),/邊界參考不足/);
 const mixed={warnings:[...r.warnings,'⚠️ 破碎班','⚠️ 連續上班 6 天']};assert.equal(ns.SwapUI.visibleWarnings(mixed).length,2);
});
test('normal search matches downloaded production B0 byte-for-byte across 200 randomized schedules and ranking',()=>{
 for(let seed=1;seed<=200;seed++) {
  const s=setup();let state=seed;const random=()=>{state=(state*1664525+1013904223)>>>0;return state;};
  for(let n=0;n<12;n++) {const e={...s.other,id:`SYNTHETIC${n}`,shifts:{}};for(const d of s.ds)e.shifts[d]=['O','OF','A','E','N'][random()%5];s.m.employees.push(e);}
  if(seed%2===0){s.self.shifts[s.d1]='OF';s.d1=s.ds[5];s.self.shifts[s.d1]='A';}
  const days=[s.d2,s.ds[21]];
  assert.equal(JSON.stringify(E.search(s.m,'SELF',s.d1,days)),JSON.stringify(B0.search(s.m,'SELF',s.d1,days)),`seed ${seed}`);
 }
});

test('cross-year requested example: Jan 2 A exchanges with Dec 21 E',()=>{
 const s=setup(34,'2026-12-04',3);for(const d of s.ds){s.self.shifts[d]='OF';s.other.shifts[d]='O';}
 s.d1='2027-01-02';s.d2='2026-12-21';s.self.shifts[s.d1]='A';s.other.shifts[s.d2]='E';
 assert.equal(result(s).results.length,0);const r=special(s).results[0];assert.ok(r);
 assert.equal(r.self.after[s.d1],'O');assert.equal(r.self.after[s.d2],'E');
 assert.equal(r.other.after[s.d1],'A');assert.equal(r.other.after[s.d2],'OF');
 assert.equal(ns.SwapUI.previewDays(s.m,r).length,28);
});
test('special permits existing long other run when not worsened and warns for other fragmentation',()=>{
 let s=setup();for(let i=9;i<=14;i++)s.other.shifts[s.ds[i]]='N';s.d2=s.ds[14];s.other.shifts[s.d2]='E';
 let r=special(s).results[0];assert.ok(r);assert.equal(r.other.impact.afterMax,6);assert.equal(r.other.impact.worsened,false);
 s=setup();s.other.shifts[s.d2]='E';s.other.shifts[s.ds[6]]='N';r=special(s).results[0];
 assert.ok(r);assert.equal(r.other.impact.fragmentation.worsened,true);assert.match(ns.SwapUI.visibleWarnings(r).join(' '),/破碎班：對方/);
 const forged=JSON.parse(JSON.stringify(r));forged.self.after[s.d2]='N';assert.throws(()=>ns.SwapUI.previewDays(s.m,forged));
});
