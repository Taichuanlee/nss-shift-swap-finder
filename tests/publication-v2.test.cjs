// Generated fictional data only. Source references are invented, never real PDF rows.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {dates}=require('./fixtures.cjs');const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','import-confirmation','schedule-publication','personal-schedule','swap-engine'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
const {Model:M,Validator:V,ImportConfirmation:C,SchedulePublication:P,PersonalSchedule:I,SwapEngine:E}=ctx.window.NSSShiftSwapFinder;
const plain=v=>JSON.parse(JSON.stringify(v));
function setup(withNumbers=false){const ds=dates(40,Date.UTC(2026,10,4));const rows=[['Synthetic'],[...(withNumbers?['ID']:[]),'Name',...ds],
 [...(withNumbers?['SYNTHETIC001']:[]),'合成同名',...ds.map((_,i)=>i===8?'A':'OF')],
 [...(withNumbers?['SYNTHETIC002']:[]),'合成同名',...ds.map((_,i)=>i===15?'A':'O')]];
 let m=M.fromTables([{source:{page:1},rows:rows.map(r=>r.map(value=>({value,source:{page:1}})))}],'pdf');m=C.initialize(m,{autoCorrect:false});C.setCycleStart(m,ds[5]);assert.equal(C.confirmCycle(m),true);return {m,ds};}
test('v2 no-number round trip preserves separate identities, all source rows, unknown cells and only 28 exchange days',()=>{
 const {m,ds}=setup();m.employees[1].shifts[ds[0]]='';V.validate(m);const p=P.create(m),loaded=P.load(p);
 assert.equal(p.schemaVersion,2);assert.equal(p.cycleDates.length,28);assert.equal(p.referenceDates.length,12);
 assert.deepEqual(plain(loaded.scheduleDates),ds);assert.deepEqual(plain(loaded.employees.map(e=>e.shifts)),plain(m.employees.map(e=>e.shifts)));
 assert.equal(I.search(loaded,'合成同名').length,2);assert.equal(I.search(loaded,p.employees[0].id).length,0);
 assert.ok(loaded.employees.every(e=>e.employeeNumber===null));assert.equal(new Set(p.employees.map(e=>e.id)).size,2);
 assert.ok(p.employees.every(e=>e.sourceRows[0].page===1));assert.match(I.sourceLabel(loaded.employees[0]),/第 1 頁.*第 3 列/);
 assert.doesNotMatch(I.label(loaded.employees[0]),/local-record/);assert.equal(loaded.employees[1].shifts[ds[0]],'');
 assert.throws(()=>E.search(loaded,loaded.employees[0].id,ds[8],[ds[0]]));
 assert.equal(E.search(loaded,loaded.employees[0].id,ds[8],[ds[15]])[0].results.length,1);
 assert.deepEqual(plain(P.create(loaded).employees),plain(p.employees));
});
test('IDs are stable within a batch and rebuild, independent across imports even with identical names/numbers',()=>{
 for(const numbered of [false,true]){const {m}=setup(numbered),{m:other}=setup(numbered);const first=P.create(m),next=P.create(other);
 assert.equal(first.scope,m.importScope);assert.notEqual(first.scope,next.scope);
 assert.ok(first.employees.every((e,i)=>e.id!==next.employees[i].id));
 assert.deepEqual(plain(P.create(m).employees.map(e=>e.id)),plain(first.employees.map(e=>e.id)));
 const rebuilt=M.rebuildDates(m,[]);assert.throws(()=>P.create(rebuilt));C.setCycleStart(rebuilt,m.cycleStartDate);assert.equal(C.confirmCycle(rebuilt),true);assert.deepEqual(plain(P.create(rebuilt).employees.map(e=>e.id)),plain(first.employees.map(e=>e.id)));
 }
});
test('v1 remains readable and explicitly lacks source evidence; v2 promotion retains all supplied reference cells',()=>{
 const {m}=setup(true),v1=P.create(m,{version:1}),old=P.load(v1);assert.equal(old.publication.schemaVersion,1);
 assert.equal(old.publication.sourceEvidenceAvailable,false);assert.equal(old.publication.referenceCoverage,'provided-only');
 const upgraded=P.create(old);assert.equal(upgraded.schemaVersion,2);assert.equal(upgraded.provenance.sourceEvidenceAvailable,false);
 assert.deepEqual(plain(upgraded.dates),plain(v1.dates));assert.equal(upgraded.referenceDates.length,12);
 assert.deepEqual(plain(P.load(upgraded).employees.map(e=>e.shifts)),plain(old.employees.map(e=>e.shifts)));
});
test('v2 rejects duplicate IDs/numbers, unscoped identities, missing sources, invalid evidence and forged partitions',()=>{
 const cases=[p=>p.employees[1].id=p.employees[0].id,p=>p.employees[0].id='unscoped',p=>p.employees[0].sourceRows=[],
 p=>p.employees[0].employeeNumber='',p=>p.employees[1].sourceRows=p.employees[0].sourceRows,p=>p.cycleDates.pop(),p=>p.referenceDates.pop(),p=>p.referenceDates.push(p.cycleDates[0]),
 p=>p.provenance.cycleConfirmed=false,p=>p.provenance.confirmedYear=1900.5,p=>p.employees[0].sourceRows[0].page=0,
 p=>p.employees[0].shifts[p.dates[0]]='UNKNOWN',p=>p.dates[0]='2026-02-30',p=>p.provenance.arbitrary=true];
 for(const change of cases){const p=plain(P.create(setup().m));change(p);assert.throws(()=>P.load(p));}
 const p=plain(P.create(setup(true).m));p.employees[1].employeeNumber=p.employees[0].employeeNumber;assert.throws(()=>P.load(p));
});
test('no-number identity is never remembered or matched across cycles; numbered memory uses employeeNumber only',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const a=P.load(P.create(setup(true).m)),id=a.employees[0].id;assert.equal(I.remember(storage,a,id),true);
 assert.equal(JSON.parse(values.get(I.STORAGE_KEY)).id,'SYNTHETIC001');
 const next=P.load(P.create(setup(true).m));assert.notEqual(next.employees[0].id,id);assert.equal(I.remembered(storage,next).id,next.employees[0].id);
 const no=P.load(P.create(setup().m));assert.equal(I.remember(storage,no,no.employees[0].id),false);assert.equal(values.size,0);
 storage.setItem(I.STORAGE_KEY,JSON.stringify({version:1,id:no.employees[0].id}));assert.equal(I.remembered(storage,no),null);assert.equal(I.remembered(storage,P.load(P.create(setup().m))),null);
});
test('missing edge context and unknown reference cells exclude candidates; supplied reference cells restore safe checks',()=>{
 const {m,ds}=setup();const self=m.employees[0],other=m.employees[1];self.shifts[ds[8]]='OF';self.shifts[m.cycleStartDate]='A';
 let loaded=P.load(P.create(m)),id=loaded.employees[0].id;assert.equal(E.search(loaded,id,m.cycleStartDate,[ds[15]])[0].results.length,1);
 other.shifts[ds[4]]='';loaded=P.load(P.create(m));assert.equal(E.search(loaded,id,m.cycleStartDate,[ds[15]])[0].excluded.invalid,1);
 other.shifts[ds[4]]='O';const p=plain(P.create(m));p.dates=p.cycleDates.slice();p.referenceDates=[];for(const e of p.employees)e.shifts=Object.fromEntries(p.dates.map(d=>[d,e.shifts[d]]));
 loaded=P.load(p);const group=E.search(loaded,id,m.cycleStartDate,[ds[15]])[0];assert.equal(group.results.length,0);assert.equal(group.excluded.context,1);
});
