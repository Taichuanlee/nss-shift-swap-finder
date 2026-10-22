const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {grid,dates,items}=require('./fixtures.cjs');
const ctx={window:{},Date,Set,Uint8Array}; vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','pdf-parser','import-confirmation','personal-schedule']) vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
const {PersonalSchedule:P,ImportConfirmation:C,PdfParser}=ctx.window.NSSShiftSwapFinder;
function model(start='2026-11-04') {
 const ds=dates(33,new Date(`${start}T00:00:00Z`).getTime());
 const m=C.initialize(PdfParser.positionedTables([{pageNumber:1,items:items(grid(ds))}]));
 C.setCycleStart(m,start); C.confirmCycle(m); assert.equal(m.validation.readyForSearch,true); return m;
}
function storage() {const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};}
test('identity search supports ID and distinct same-name records; empty queries return none',()=>{
 const m=model();m.employees[1].name=m.employees[0].name;
 assert.equal(P.search(m,m.employees[0].name).length,2);
 assert.equal(P.search(m,'EXAMPLE001').length,1);
 assert.equal(P.search(m,'missing').length,0);assert.equal(P.search(m,' ').length,0);
 m.cycleConfirmed=false;assert.equal(P.search(m,'EXAMPLE').length,0);
});
test('remember only unique confirmed ID, re-match current list, never name match or schedule persistence',()=>{
 const m=model(),s=storage(); assert.equal(P.remember(s,m,'EXAMPLE001'),true);
 assert.deepEqual(JSON.parse(s.getItem(P.STORAGE_KEY)),{version:1,id:'EXAMPLE001'});
 assert.equal(P.remembered(s,m).id,'EXAMPLE001');
 m.employees[0].id='CHANGED';assert.equal(P.remembered(s,m).id,'CHANGED');m.employees[0].employeeNumber='NEW';assert.equal(P.remembered(s,m),null);m.employees[0].employeeNumber='EXAMPLE001';
 m.employees[0].id='EXAMPLE001';m.employees.push({...m.employees[0]});
 assert.equal(P.remembered(s,m),null);assert.equal(P.remember(s,m,'EXAMPLE001'),false);
 m.employees.pop();m.employees[0].identityResolved=false;assert.equal(P.remembered(s,m),null);
 m.cycleConfirmed=false;assert.equal(P.remembered(s,m),null);
});
test('invalid or denied local storage does not throw or bypass confirmation',()=>{
 const s={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
 assert.equal(P.remembered(s,model()),null);assert.equal(P.remember(s,model(),'EXAMPLE001'),false);
 assert.equal(P.remembered({getItem:()=>'{broken'},model()),null);
});
for(const start of ['2026-11-04','2026-12-20','2028-02-15']) test(`exact 28 consecutive days from ${start}, original model unchanged`,()=>{
 const m=model(start),before=JSON.stringify(m),days=P.calendar(m,'EXAMPLE001');
 assert.equal(days.length,28);assert.equal(days[0].date,start);assert.equal(days[27].date,C.addDays(start,27));
 for(let i=0;i<28;i++){assert.equal(days[i].date,C.addDays(start,i));assert.equal(days[i].code,m.employees[0].shifts[days[i].date]);assert.ok(['work','leave'].includes(days[i].kind));}
 if(start==='2026-11-04')assert.equal(days[0].weekday,'三');
 assert.equal(JSON.stringify(m),before);
});
test('unconfirmed, invalid, duplicate, unknown or missing calendar data cannot be displayed',()=>{
 let m=model();m.cycleConfirmed=false;assert.throws(()=>P.calendar(m,'EXAMPLE001'));
 m=model();m.validation.readyForSearch=false;assert.throws(()=>P.calendar(m,'EXAMPLE001'));
 m=model();assert.throws(()=>P.calendar(m,'missing'));m.employees.push({...m.employees[0]});assert.throws(()=>P.calendar(m,'EXAMPLE001'));
 m=model();m.employees[0].shifts[m.cycleStartDate]='OX';assert.throws(()=>P.calendar(m,'EXAMPLE001'));
 m=model();delete m.employees[0].shifts[m.cycleStartDate];assert.equal(P.calendar(m,'EXAMPLE001')[0].kind,'blank');
});
