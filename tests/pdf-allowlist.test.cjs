// All text and schedules are generated fictional fixtures. No real PDF content.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {dates,grid,items}=require('./fixtures.cjs');const ctx={window:{},Date,Set};vm.createContext(ctx);
for(const f of ['schedule-model','schedule-validator','pdf-parser','import-confirmation','schedule-publication','personal-schedule','swap-engine'])vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'),ctx);
const ns=ctx.window.NSSShiftSwapFinder,C=ns.ImportConfirmation;
function parse(rows){return C.initialize(ns.PdfParser.positionedTables(rows.map((r,i)=>({pageNumber:i+1,items:items(r)}))),{autoCorrect:false});}
function noIDs(){const r=grid();r[0]=['Synthetic schedule'];r[1][0]='Unit';r.slice(2).forEach(row=>row[0]='Capability');r[1]=['Unit','Name',...dates().map(d=>`${+d.slice(5,7)}/${+d.slice(8)}`)];return r;}
test('optional employee numbers: separate same-name rows, scopes and stable IDs through year/date rebuilding',()=>{
 const rows=noIDs();rows[3][1]=rows[2][1];let m=parse([rows]);
 assert.equal(m.employees.length,2);assert.notEqual(m.employees[0].id,m.employees[1].id);assert.ok(m.employees.every(e=>e.employeeNumber===null&&e.identityResolved));
 assert.equal(m.needsYearConfirmation,true);assert.equal(m.scheduleDates.length,0);assert.ok(m.employees.every(e=>e.pendingShifts.length===28));
 const ids=m.employees.map(e=>e.id);assert.notEqual(parse([rows]).employees[0].id,ids[0]);
 assert.throws(()=>C.confirmYear(m,''));assert.throws(()=>C.confirmYear(m,'26'));assert.throws(()=>C.confirmYear(m,2200));
 m=C.confirmYear(m,2026);assert.deepEqual(m.employees.map(e=>e.id),ids);assert.equal(ns.Model.dateCellsPreserved(m),true);
 C.setCycleStart(m,'2026-11-09');assert.equal(C.confirmCycle(m),true);assert.equal(m.requiresPublicationV2,true);assert.equal(ns.SchedulePublication.create(m).schemaVersion,2);assert.throws(()=>ns.SchedulePublication.create(m,{version:1}));
});
test('missing IDs do not merge same-name records across repeated pages; known IDs still merge with evidence',()=>{
 const rows=noIDs();const m=C.confirmYear(parse([rows,rows]),2026);assert.equal(m.employees.length,4);assert.equal(new Set(m.employees.map(e=>e.id)).size,4);assert.equal(ns.Model.dateCellsPreserved(m),true);
 const known=parse([grid(),grid()]);assert.equal(known.employees.length,2);assert.ok(known.employees.every(e=>e.employeeNumber===e.id));
 const missing=grid();missing[2][0]='';const p=parse([missing]);assert.equal(p.employees[0].employeeNumber,null);assert.equal(p.employees[0].identityResolved,true);
});
test('arbitrary outer metadata is retained, while an internal unknown/date-like side column or crossing stays blocking',()=>{
 for(const label of ['1月預定大班','3月夜班','6月預定班','Any new metadata']) {
  const r=grid();r[1].splice(2,0,label);r[1].push(label);r.slice(2).forEach(row=>{row.splice(2,0,'NOT_A_SHIFT');row.push('META')});
  const m=parse([r]);assert.equal(m.errors.length,0);assert.equal(m.pdfNonDailyColumns.length,2);assert.equal(m.pdfNonDailyColumns[0].values[0].rawValue,'NOT_A_SHIFT');assert.equal(Object.keys(m.employees[0].shifts).length,28);assert.equal(ns.Model.dateCellsPreserved(m),true);
 }
 const inside=grid();inside[1][10]='unknown';assert.ok(parse([inside]).errors.some(e=>['DATE_COLUMN_ALIGNMENT','IRREGULAR_DATE_COLUMNS'].includes(e.code)));
 const suspicious=grid();suspicious[1].push('11/??');suspicious.slice(2).forEach(r=>r.push('A'));assert.ok(parse([suspicious]).errors.some(e=>e.code==='UNMAPPED_COLUMN'));
 const raw=items(grid());const first=raw.find(i=>i.str===dates()[0]);raw.push({str:'OUTSIDE_WIDE',width:120,height:8,transform:[1,0,0,1,first.transform[4]-100,702]});assert.ok(ns.PdfParser.positionedTables([{pageNumber:1,items:raw}]).errors.some(e=>e.code==='COLUMN_ALIGNMENT'));
});
test('page-number footers use content/relative structure, not absolute coordinates or large gaps',()=>{
 for(const shift of [0,17,131]) {
  const pages=[1,2,3].map(n=>{const raw=items(grid());raw.forEach(i=>i.transform[5]+=shift);raw.push({str:`第 ${n} 頁，共 3 頁`,width:100,height:8,transform:[1,0,0,1,700,670+shift]});return {pageNumber:n,items:raw};});
  const m=ns.PdfParser.positionedTables(pages);assert.equal(m.errors.length,0);assert.equal(m.pdfPageFooters.length,3);assert.equal(m.employees.length,2);
 }
 const raw=items(grid());raw.push({str:'arbitrary unknown text',width:100,height:8,transform:[1,0,0,1,700,600]});const m=ns.PdfParser.positionedTables([{pageNumber:1,items:raw}]);assert.ok(m.errors.some(e=>e.code==='UNIDENTIFIED_ROW'));
});
test('explicit year preserves cross-year/leap dates and one decision repairs all matching typo columns without moving cells',()=>{
 const ds=dates(33,Date.UTC(2028,1,22)),r=grid(ds);r[0]=['Synthetic schedule'];r[1]=['ID','Name',...ds.map(d=>`${+d.slice(5,7)}/${+d.slice(8)}`)];r[1][8]='2/30';
 let m=C.confirmYear(parse([r,r,r]),2028);assert.equal(m.importConfirmation.dateSuggestions.length,1);assert.equal(m.importConfirmation.dateSuggestions[0].occurrences.length,3);m=C.decideDate(m,m.importConfirmation.dateSuggestions[0].id,true);
 assert.equal(m.errors.length,0);assert.equal(ns.Model.dateCellsPreserved(m),true);assert.equal(m.scheduleDates[7],'2028-02-29');
 const cross=grid(dates(28,Date.UTC(2027,11,20)));cross[0]=['Synthetic'];cross[1]=['ID','Name',...dates(28,Date.UTC(2027,11,20)).map(d=>`${+d.slice(5,7)}/${+d.slice(8)}`)];const x=C.confirmYear(parse([cross]),2027);assert.equal(x.scheduleEndDate,'2028-01-16');
});
test('duplicate/gapped dates, name loss, unknown codes and cross-page disagreement stay blocking; v1 cannot accept local IDs',()=>{
 for(const mutate of [r=>r[1][4]=r[1][3],r=>r[1][4]='2026-12-30',r=>r[2][1]='',r=>r[2][4]='BAD']) {const r=grid();mutate(r);assert.ok(parse([r]).errors.length);}
 const r=grid();r[1][5]='2026-12-30';assert.ok(parse([grid(),r]).errors.some(e=>e.code==='CROSS_PAGE_DATES'));
 const valid=parse([grid()]);C.setCycleStart(valid,'2026-11-09');C.confirmCycle(valid);const p=ns.SchedulePublication.create(valid);p.employees[0].id='local-record:forged';assert.throws(()=>ns.SchedulePublication.load(p));
});

test('metadata cannot supply a missing year and ambiguous identity columns never choose one silently',()=>{
 const rows=noIDs();rows[1][0]='2027年預定班';const m=parse([rows]);assert.equal(m.needsYearConfirmation,true);assert.equal(m.scheduleDates.length,0);
 const bad=noIDs();bad[2][4]='BAD';const y=C.confirmYear(parse([bad]),2026);assert.ok(y.errors.some(e=>e.code==='UNKNOWN_SHIFT'));
 const ambiguous=grid();ambiguous[1].push('Name');ambiguous.slice(2).forEach(r=>r.push('Other fictional name'));assert.ok(parse([ambiguous]).errors.some(e=>e.code==='AMBIGUOUS_IDENTITY_HEADER'));
});
