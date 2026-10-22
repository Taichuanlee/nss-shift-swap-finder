const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {dates,grid,items} = require('./fixtures.cjs');
const context={window:{},console,Date,Set,Uint8Array};vm.createContext(context);
vm.runInContext(fs.readFileSync('vendor/sheetjs/xlsx.full.min.js','utf8'),context);
context.window.XLSX=context.XLSX;
for(const path of ['schedule-model','schedule-validator','pdf-parser','excel-parser'])vm.runInContext(fs.readFileSync(`js/${path}.js`,'utf8'),context);
const ns=context.window.NSSShiftSwapFinder;
function parseGrid(rows) {return ns.Validator.validate(ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map((row,r)=>row.map((value,c)=>({value,source:{row:r+1,column:c+1}})))}],'excel'));}
function pdfRows(rows=grid(), pageNumber=1) {return {pageNumber,items:items(rows).reverse()};}
function excel(rows=grid(),type='xlsx',second=false,extra={}) {
 const X=context.XLSX,wb=X.utils.book_new(),sheet=X.utils.aoa_to_sheet(rows);
 Object.assign(sheet,extra);
 X.utils.book_append_sheet(wb,sheet,'Synthetic schedule');
 if(second)X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet(rows),'Another schedule');
 const bytes=X.write(wb,{type:'array',bookType:type});
 return {arrayBuffer:async()=>bytes};
}
test('coordinate PDF, extracted order ignored, cycle remains unconfirmed',()=>{
 const m=ns.PdfParser.positionedTables([pdfRows()]);assert.equal(m.employees.length,2);assert.equal(m.scheduleDates.length,28);assert.equal(m.employees[0].shifts[dates()[3]],'OF');assert.equal(m.validation.basicValidationPassed,true);assert.equal(m.validation.readyForSearch,false);assert.equal(m.cycleStartDate,null);
});
test('multi-page PDF and repeated headers merge without duplicate dates/employees',()=>{
 const rows=grid();const m=ns.PdfParser.positionedTables([pdfRows(rows),pdfRows(rows,2)]);assert.equal(m.employees.length,2);assert.equal(m.scheduleDates.length,28);assert.equal(m.errors.length,0);assert.ok(m.warnings.some(w=>w.code==='DUPLICATE_EMPLOYEE_ID'));
});
test('split pages preserve outside-cycle dates',()=>{
 const ds=dates(33);const m=ns.PdfParser.positionedTables([pdfRows(grid(ds.slice(0,17))),pdfRows(grid(ds.slice(17)),2)]);assert.equal(m.scheduleDates.length,33);assert.equal(m.validation.basicValidationPassed,true);
});
test('PDF date column or shift position drift blocks globally',()=>{
 for(const which of ['header','shift']) {
  const p=pdfRows();const target=p.items.find(i=>which==='header' ? i.str===dates()[1] : i.str==='OF');target.transform[4]+=30;
  const m=ns.PdfParser.positionedTables([p]);assert.equal(m.validation.globalStructureValid,false);assert.ok(m.errors.some(i=>i.code===(which==='header'?'IRREGULAR_DATE_COLUMNS':'COLUMN_ALIGNMENT')));
 }
});
test('scan/no-text PDF produces understandable blocking error',()=>{
 const m=ns.PdfParser.positionedTables([{pageNumber:1,items:[]}]);assert.ok(m.errors.some(i=>i.code==='NO_PAGE_TEXT'));assert.equal(m.validation.globalStructureValid,false);
});
test('XLSX and XLS binary decoding (not only mocked rows)',async()=>{
 for(const type of ['xlsx','xls']) {const m=await ns.ExcelParser.parse(excel(grid(),type));assert.equal(m.employees.length,2);assert.equal(m.validation.basicValidationPassed,true);}
});
test('Excel title below first row, irrelevant sheets not selected',async()=>{
 const rows=[[],['extra title'],...grid()];const X=context.XLSX,wb=X.utils.book_new();
 X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['Not a schedule'],['metadata']]),'First non-schedule sheet');
 X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet(rows),'Real synthetic table');
 const bytes=X.write(wb,{type:'array',bookType:'xlsx'});const m=await ns.ExcelParser.parse({arrayBuffer:async()=>bytes});assert.equal(m.scheduleDates.length,28);assert.equal(m.sourceInfo[0].source.sheet,'Real synthetic table');
});
test('multiple candidate sheets require selection',async()=>{
 const f=excel(grid(),'xlsx',true);const result=await ns.ExcelParser.parse(f);assert.equal(result.needsSheetSelection,true);assert.equal(result.sheetNames.length,2);
 const m=await ns.ExcelParser.parse(f,{sheetName:'Another schedule'});assert.equal(m.validation.basicValidationPassed,true);
});
test('merged title allowed; merged date blocks globally',async()=>{
 const ok=await ns.ExcelParser.parse(excel(grid(),'xlsx',false,{'!merges':[{s:{r:0,c:0},e:{r:0,c:6}}]}));assert.equal(ok.validation.basicValidationPassed,true);
 const bad=await ns.ExcelParser.parse(excel(grid(),'xlsx',false,{'!merges':[{s:{r:1,c:2},e:{r:1,c:3}}]}));assert.equal(bad.validation.globalStructureValid,false);
});
test('Excel numeric dates in 1900/1904 systems, no timezone drift',async()=>{
 const X=context.XLSX;
 for(const date1904 of [false,true]) {
  const wb=X.utils.book_new();wb.Workbook={WBProps:{date1904}};
  const rows=grid();const sheet=X.utils.aoa_to_sheet(rows);
  for(let i=0;i<28;i++) {const v=(Date.parse(dates()[i])-Date.UTC(1899,11,30))/86400000-(date1904?1462:0);sheet[X.utils.encode_cell({r:1,c:i+2})]={t:'n',v,z:'yyyy-mm-dd'};}
  X.utils.book_append_sheet(wb,sheet,'Dates');const bytes=X.write(wb,{type:'array',bookType:'xlsx'});
  const m=await ns.ExcelParser.parse({arrayBuffer:async()=>bytes});assert.equal(m.scheduleStartDate,dates()[0]);assert.equal(m.validation.basicValidationPassed,true);
 }
});
test('cross-month and cross-year partial dates',()=>{
 const ds=dates(28,Date.UTC(2026,11,20));const rows=grid(ds);rows[1]=['ID','Name',...ds.map(d=>`${+d.slice(5,7)}/${+d.slice(8)}`)];
 const m=parseGrid(rows);assert.equal(m.scheduleStartDate,'2026-12-20');assert.equal(m.scheduleEndDate,'2027-01-16');assert.equal(m.validation.basicValidationPassed,true);
});
test('unknown O code and blanks are local, healthy employees retained',()=>{
 const rows=grid();rows[2][3]='OX';rows[2][4]='';const m=parseGrid(rows);
 assert.equal(m.employees[0].shifts[dates()[1]],'OX');assert.equal(ns.Model.classify('OX'),'unknown');assert.equal(ns.Model.classify('OF'),'leave');assert.equal(ns.Model.classify(''),'blank');assert.equal(m.validation.globalStructureValid,true);assert.equal(m.employees[0].validation.complete,false);assert.equal(m.employees[1].validation.complete,true);
 ns.Validator.validate(m,{extraLeaveCodes:['OX']});assert.ok(!m.errors.some(i=>i.code==='UNKNOWN_SHIFT'));assert.ok(m.warnings.some(i=>i.code==='BLANK_SHIFT'));
});
test('eight confirmed annotations normalize in PDF and Excel while preserving every raw cell',()=>{
 const inputs=['A 休','E 休','N 休','O N','E 休 -8','E -8 休','N 休 -8','N -8 休'];
 const expected=['A','E','N','ON','E','E','N','N'];
 const rows=grid();inputs.forEach((raw,i)=>rows[2][i+2]=raw);
 for(const m of [parseGrid(rows),ns.PdfParser.positionedTables([pdfRows(rows)])]) {
  inputs.forEach((raw,i)=>{const date=dates()[i],e=m.employees[0];assert.equal(e.shifts[date],expected[i]);assert.equal(e.shiftDetails[date][0].raw,raw);assert.equal(e.shiftDetails[date][0].normalized,expected[i]);assert.ok(e.shiftDetails[date][0].source);assert.equal(ns.Model.classify(e.shifts[date]),expected[i]==='ON'?'leave':'work');});
  assert.ok(!m.errors.some(e=>e.code==='UNKNOWN_SHIFT'));assert.equal(m.validation.shiftsComplete,true);assert.equal(m.validation.readyForSearch,false);
 }
});
test('annotation ordering is explicit; unknown text and existing leave codes remain unchanged',()=>{
 for(const raw of ['休 E','-8 E 休','休 -8 E','E -8','-8 E',' E  休\t-8 '])assert.equal(ns.Model.normalizeShift(raw),'E');
 for(const raw of ['休','-8','O 休','ON 休','E 休假','E 休 -9','N -8 -8','O N X','N O','休 O N','OF -8','e 休','A特','E病','AN休','A-80','A- 8休']) {
  assert.equal(ns.Model.normalizeShift(raw),raw);assert.equal(ns.Model.classify(ns.Model.normalizeShift(raw)),'unknown');
 }
 for(const raw of ns.Model.shiftCodes.leave){assert.equal(ns.Model.normalizeShift(raw),raw);assert.equal(ns.Model.classify(raw),'leave');}
 assert.equal(ns.Model.classify(ns.Model.normalizeShift('')),'blank');
 const rows=grid();rows[2][2]=' E  休\t-8 ';const m=parseGrid(rows);assert.equal(m.employees[0].shiftDetails[dates()[0]][0].raw,' E  休\t-8 ');
});
test('confirmed token combinations work with or without whitespace and retain raw values',()=>{
 const inputs=['A休 -8','A-8休','E休 -8','N-8休','A -8','E 休','N休'];
 const expected=['A','A','E','N','A','E','N'];
 const rows=grid();inputs.forEach((raw,i)=>rows[2][i+2]=raw);
 for(const model of [parseGrid(rows),ns.PdfParser.positionedTables([pdfRows(rows)])])inputs.forEach((raw,i)=>{
  const employee=model.employees[0],date=dates()[i];
  assert.equal(ns.Model.normalizeShift(raw),expected[i]);assert.equal(employee.shifts[date],expected[i]);
  assert.equal(ns.Model.classify(employee.shifts[date]),'work');
  assert.equal(employee.shiftDetails[date][0].raw,raw);assert.equal(employee.shiftDetails[date][0].normalized,expected[i]);
 });
 for(const code of ['A','E','N'])for(const annotations of ['', '休','-8','休-8','-8休'])for(const join of ['', ' ','\t']) {
  const raw=[code,...(annotations.match(/-8|休/g)||[])].join(join);
  assert.equal(ns.Model.normalizeShift(raw),code);assert.equal(ns.Model.classify(ns.Model.normalizeShift(raw)),'work');
 }
 assert.equal(ns.Model.normalizeShift('ON'),'ON');assert.equal(ns.Model.classify(ns.Model.normalizeShift('ON')),'leave');
 const unknown=grid();unknown[2][2]='A特';unknown[2][3]='E病';const m=parseGrid(unknown);
 assert.equal(m.errors.filter(e=>e.code==='UNKNOWN_SHIFT').length,2);
 assert.equal(m.employees[0].shiftDetails[dates()[0]][0].raw,'A特');
});
test('repeated cells preserve annotations; only different normalized shifts conflict',()=>{
 const rows=grid();rows[2][2]='E 休';const repeated=[...rows[2]];repeated[2]='E -8 休';rows.push(repeated);
 const same=parseGrid(rows);assert.ok(!same.errors.some(e=>e.code==='SHIFT_CONFLICT'));assert.equal(same.employees[0].shiftDetails[dates()[0]].length,2);
 const changed=[...repeated];changed[2]='N 休';rows.push(changed);const conflict=parseGrid(rows);
 assert.equal(conflict.employees[0].shifts[dates()[0]],'E');assert.equal(conflict.employees[0].shiftDetails[dates()[0]].length,3);
 assert.equal(conflict.errors.find(e=>e.code==='SHIFT_CONFLICT').conflict.incoming,'N');
});
test('employee same-date conflict local; different-name duplicate ID local',()=>{
 const rows=grid();rows.push(['EXAMPLE001','Another fictional name',...dates().map(()=> 'N')]);const m=parseGrid(rows);assert.equal(m.employees.length,2);assert.ok(m.errors.some(i=>i.code==='SHIFT_CONFLICT'));assert.ok(m.errors.some(i=>i.code==='IDENTITY_CONFLICT'));assert.equal(m.employees[1].validation.complete,true);
});
test('global date errors never silently corrected (1/16 vs 11/11)',()=>{
 const rows=grid();rows[1]=['ID','Name',...dates().map(d=>`${+d.slice(5,7)}/${+d.slice(8)}`)];rows[1][4]='1/16';const m=parseGrid(rows);assert.equal(m.validation.globalStructureValid,false);assert.ok(m.errors.some(i=>i.message.includes('2026-11-11')));assert.ok(m.scheduleDates.includes('2026-01-16'));
});
test('invalid/yearless dates and duplicate dates block; malformed middle column not skipped',()=>{
 for(const label of ['2026-02-30',dates()[0],'nonsense']) {const rows=grid();rows[1][3]=label;const m=parseGrid(rows);assert.equal(m.validation.globalStructureValid,false);}
 const rows=grid();rows[0]=['No year'];rows[1]=['ID','Name',...dates().map(d=>d.slice(5).replace('-','/'))];assert.ok(parseGrid(rows).unresolvedDateColumns.length);
});
test('validator idempotent; formulas not executed',async()=>{
 const m=parseGrid(grid());ns.Validator.validate(m);ns.Validator.validate(m);assert.equal(m.errors.length,0);
 const rows=grid();const m2=await ns.ExcelParser.parse(excel(rows,'xlsx',false,{D3:{t:'n',v:1,f:'WEBSERVICE("https://invalid.example")'}}));assert.ok(m2.errors.some(i=>i.code==='UNKNOWN_SHIFT'));
});

test('unknown edge header never silently drops its daily shifts',()=>{
 for(const index of [2,29]) {const rows=grid();rows[1][index]='unreadable';const m=parseGrid(rows);assert.equal(m.validation.globalStructureValid,false);assert.ok(m.unresolvedDateColumns.length);}
});
test('reordered identity and date columns, merged unknown shift blocked',async()=>{
 const rows=grid().map((row,r)=>r? [row[1],...row.slice(2),row[0]]:row);
 const m=await ns.ExcelParser.parse(excel(rows));assert.equal(m.validation.basicValidationPassed,true);
 const unknown=grid();unknown[2][2]='OX';const bad=await ns.ExcelParser.parse(excel(unknown,'xlsx',false,{'!merges':[{s:{r:2,c:2},e:{r:2,c:3}}]}));assert.equal(bad.validation.globalStructureValid,false);
});
