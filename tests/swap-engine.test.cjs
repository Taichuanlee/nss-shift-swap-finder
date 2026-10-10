const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {dates}=require('./fixtures.cjs');const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','import-confirmation','personal-schedule','swap-engine'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
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
function result(s,d2=s.d2,emergency=false){return E.search(s.m,'SELF',s.d1,[d2],{emergency})[0];}
test('same-shift two-way simulation preserves original shifts, raw details and excludes self',()=>{
 const s=setup(),before=JSON.stringify(s.m),r=result(s).results[0];assert.equal(r.employeeId,'OTHER');assert.equal(r.sameShift,true);
 assert.equal(r.self.after[s.d1],'O');assert.equal(r.self.after[s.d2],'A');assert.equal(r.other.after[s.d1],'A');assert.equal(r.other.after[s.d2],'OF');
 assert.equal(JSON.stringify(s.m),before);assert.equal(result(s).results.length,1);
});
test('each exchange date is searched separately without merging swaps or duplicate dates',()=>{
 const s=setup(),d3=s.ds[20];s.other.shifts[d3]='A';const groups=E.search(s.m,'SELF',s.d1,[s.d2,d3,s.d2]);
 assert.equal(groups.length,2);assert.equal(groups[0].results.length,1);assert.equal(groups[1].results.length,1);
 assert.equal(Object.keys(groups[0].results[0].self.after).length,2);
});
test('invalid direction, unknown shifts, invalid identity, duplicate ID and unconfirmed cycle are excluded',()=>{
 let s=setup();s.other.shifts[s.d1]='A';assert.equal(result(s).excluded.direction,1);
 s=setup();s.other.shifts[s.d2]='O';assert.equal(result(s).results.length,0);
 s=setup();s.other.shifts[s.ds[0]]='OX';assert.equal(result(s).excluded.invalid,1);
 s=setup();s.other.validation.complete=false;assert.equal(result(s).excluded.invalid,1);
 s=setup();s.m.employees.push({...s.other});assert.equal(result(s).results.length,0);
 s=setup();s.m.cycleConfirmed=false;assert.throws(()=>result(s));
 s=setup();assert.throws(()=>E.search(s.m,'SELF',s.d2,[s.d1]));assert.throws(()=>E.search(s.m,'SELF',s.d1,[]));
});
test('six-day newly merged run is excluded, including in emergency mode',()=>{
 const s=setup();for(let i=5;i<=10;i++)if(s.ds[i]!==s.d1)s.other.shifts[s.ds[i]]='A';
 assert.equal(result(s).excluded.consecutive,1);s.other.shifts[s.d2]='N';assert.equal(result(s,s.d2,true).excluded.consecutive,1);
});
test('pre-existing long run cannot be extended; unrelated long run does not justify a new one',()=>{
 let s=setup();for(let i=9;i<=14;i++)s.other.shifts[s.ds[i]]='A';s.d2=s.ds[20];s.other.shifts[s.d2]='A';assert.equal(result(s).excluded.consecutive,1);
 s=setup();for(let i=5;i<=10;i++)if(s.ds[i]!==s.d1)s.other.shifts[s.ds[i]]='A';for(let i=21;i<=29;i++)s.other.shifts[s.ds[i]]='A';assert.equal(result(s).excluded.consecutive,1);
});
test('existing >5-day segment is allowed when exchange does not worsen it',()=>{
 const s=setup();for(let i=9;i<=14;i++)s.other.shifts[s.ds[i]]='A';const d2=s.ds[14];
 const r=result(s,d2);assert.equal(r.results.length,1);assert.equal(r.results[0].other.impact.afterMax,6);assert.equal(r.results[0].other.impact.worsened,false);
 assert.doesNotMatch(r.results[0].warnings.join(' '),/原有超過 5 天|⚠️ 連續上班/);
});
test('user consecutive days warn without a hard limit',()=>{
 const s=setup();for(let i=13;i<=19;i++)if(s.ds[i]!==s.d2)s.self.shifts[s.ds[i]]='N';const r=result(s).results[0];assert.ok(r.self.impact.afterMax>5);assert.match(r.warnings.join(' '),/⚠️ 連續上班 7 天/);
});
test('emergency mode is opt-in; cross-shift adjacency risks have no invented rest hours',()=>{
 const s=setup();s.other.shifts[s.d2]='N';s.self.shifts[s.ds[14]]='E';s.other.shifts[s.ds[9]]='N';
 assert.equal(result(s).excluded.shift,1);const r=result(s,s.d2,true).results[0];assert.equal(r.sameShift,false);assert.ok(r.self.impact.transitions.length);assert.ok(r.other.impact.transitions.length);
 assert.doesNotMatch(r.warnings.join(' '),/無法計算實際休息時數|相鄰工作日/);assert.equal(result(s).results.length,0);
});
test('provided pre-cycle days count toward full affected run; out-of-cycle dates cannot be exchanged',()=>{
 const s=setup();s.self.shifts[s.d1]='OF';s.d1=s.m.cycleStartDate;s.self.shifts[s.d1]='A';
 for(let i=0;i<5;i++)s.other.shifts[s.ds[i]]='A';assert.equal(result(s).excluded.consecutive,1);
 assert.throws(()=>E.search(s.m,'SELF',s.d1,[s.ds[0]]));
});
test('post-cycle adjacent dates count, boundary metadata is retained and no holiday dates is explicit',()=>{
 const s=setup(38,'2026-12-20');s.self.shifts[s.d1]='OF';s.d1=s.m.cycleEndDate;s.self.shifts[s.d1]='A';
 for(let i=33;i<38;i++)s.other.shifts[s.ds[i]]='A';assert.equal(result(s).excluded.consecutive,1);
 const t=setup(28,'2027-01-01',0);t.self.shifts[t.d1]='OF';t.d1=t.ds[0];t.self.shifts[t.d1]='A';assert.equal(result(t).results[0].other.impact.edge,true);assert.equal(result(t).results[0].warnings.length,0);
 for(const d of t.ds)t.self.shifts[d]='A';assert.equal(E.options(t.m,'SELF').leaveDates.length,0);
});

function fragmentChange(beforeText,afterText,indices) {
 const ds=dates(beforeText.length),make=text=>Object.fromEntries(ds.map((d,i)=>[d,text[i]==='A'?'A':'OF']));
 return E.fragmentationImpact(ds,make(beforeText),make(afterText),indices.map(i=>ds[i]));
}
test('normal result has no warnings; unchanged pre-existing long user run is not a new warning',()=>{
 let s=setup();assert.equal(result(s).results[0].warnings.length,0);
 s=setup();for(const d of s.ds)s.self.shifts[d]='OF';for(let i=16;i<=21;i++)s.self.shifts[s.ds[i]]='A';s.d1=s.ds[21];
 const r=result(s).results[0];assert.equal(r.self.impact.afterMax,6);assert.equal(r.risks.consecutive,false);assert.equal(r.warnings.length,0);
});
test('new fragmented shift is warned without excluding a qualified candidate',()=>{
 const s=setup();s.self.shifts[s.ds[7]]='A';s.d2=s.ds[9];s.other.shifts[s.d2]='A';
 const r=result(s);assert.equal(r.results.length,1);assert.equal(r.results[0].risks.fragmented,true);assert.match(r.results[0].warnings.join(' '),/⚠️ 破碎班：您/);
});
test('unchanged or improved fragmentation is not a new risk, including different work/leave codes',()=>{
 assert.equal(fragmentChange('AOAO','AOAO',[1,2]).worsened,false);
 assert.equal(fragmentChange('AOAO','AAOO',[1,2]).worsened,false);
 const ds=dates(4),old=Object.fromEntries(ds.map((d,i)=>[d,['A','OF','N','ON'][i]])),next={...old,[ds[0]]:'E',[ds[1]]:'O8'};
 assert.equal(E.fragmentationImpact(ds,old,next,[ds[0],ds[1]]).worsened,false);
 const s=setup();s.self.shifts[s.ds[20]]='A';s.self.shifts[s.ds[22]]='A';assert.equal(result(s).results[0].risks.fragmented,false);
});
test('four consecutive alternating work/leave days qualify; longer alternation increases severity',()=>{
 assert.equal(fragmentChange('AAOO','AOAO',[1,2]).worsened,true);
 const r=fragmentChange('AOAOO','AOAOA',[4]);assert.equal(r.beforeCount,1);assert.equal(r.afterCount,2);assert.equal(r.worsened,true);
 const ds=dates(4),short=Object.fromEntries(ds.slice(0,3).map((d,i)=>[d,i%2?'O':'A']));assert.equal(E.fragmentation(ds.slice(0,3),short).length,0);
 const shifts=Object.fromEntries(ds.map((d,i)=>[d,i%2?'ON':'E']));assert.equal(E.fragmentation(ds,shifts).length,1);
 shifts[ds[1]]='OX';assert.equal(E.fragmentation(ds,shifts).length,0);
 assert.equal(E.fragmentation([ds[0],ds[1],ds[3],ns.ImportConfirmation.addDays(ds[3],1)],shifts).length,0);
});
test('improvement elsewhere cannot cancel a newly fragmented neighborhood',()=>{
 const r=fragmentChange('OAAOOOOOOAOAOOOOO','OAOAOOOOOAAOOOOOO',[2,3,10,11]);
 assert.equal(r.beforeCount,r.afterCount);assert.equal(r.worsened,true);assert.equal(r.regions.length,2);
});
test('stable sorting ranks same-shift risk categories then warning count and keeps input unchanged',()=>{
 const row=(id,sameShift,consecutive=false,fragmented=false)=>({employeeId:id,sameShift,risks:{consecutive,fragmented},warnings:[...(consecutive?['long']:[]),...(fragmented?['fragment']:[])]});
 const input=[row('crossMulti',false,true,true),row('both',true,true,true),row('clean2',true),row('crossClean',false),row('long2',true,true),row('fragment',true,false,true),row('clean1',true),row('long1',true,true),row('crossOne',false,false,true)];
 const original=JSON.stringify(input),sorted=E.sortResults(input);
 assert.deepEqual(Array.from(sorted,r=>r.employeeId),['clean2','clean1','fragment','long2','long1','both','crossClean','crossOne','crossMulti']);
 assert.equal(JSON.stringify(input),original);assert.equal(new Set(sorted).size,input.length);
 assert.deepEqual(Array.from(E.sortResults(input),r=>r.employeeId),Array.from(sorted,r=>r.employeeId));
});
test('search ranks clean same-shift before fragmentation before cross-shift without changing qualification',()=>{
 const s=setup();const clean={...s.other,id:'CLEAN',name:'Synthetic Clean',shifts:{...s.other.shifts}};
 s.other.shifts[s.ds[6]]='A';
 const cross={...clean,id:'CROSS',name:'Synthetic Cross',shifts:{...clean.shifts,[s.d2]:'N'}};
 s.m.employees.push(cross,clean);const r=result(s,s.d2,true);
 assert.deepEqual(Array.from(r.results,e=>e.employeeId),['CLEAN','OTHER','CROSS']);
 assert.equal(r.results[1].risks.fragmented,true);assert.equal(r.results.length,3);
});
test('candidate sets match original safety rules across independent synthetic exchanges and modes',()=>{
 for(let seed=0;seed<40;seed++) {
  const s=setup();let state=seed+1;const random=()=>{state=(state*1664525+1013904223)>>>0;return state/4294967296;};
  for(let n=0;n<8;n++) {const e={...s.other,id:`SYNTHETIC${n}`,name:'Synthetic',shifts:{...s.other.shifts}};for(const d of s.ds)e.shifts[d]=random()<0.5?'O':['A','E','N'][Math.floor(random()*3)];s.m.employees.push(e);}
  for(const emergency of [false,true]) {
   const expected=s.m.employees.filter(e=>e.id!=='SELF'&&['O','OF','ON','OZ','O1','O6','O8'].includes(e.shifts[s.d1])&&['A','E','N'].includes(e.shifts[s.d2])&&(emergency||e.shifts[s.d2]===s.self.shifts[s.d1])&&!E.impact(s.m,e,{[s.d1]:s.self.shifts[s.d1],[s.d2]:s.self.shifts[s.d2]}).worsened).map(e=>e.id).sort();
   assert.deepEqual(Array.from(result(s,s.d2,emergency).results,e=>e.employeeId).sort(),Array.from(expected));
  }
 }
});
