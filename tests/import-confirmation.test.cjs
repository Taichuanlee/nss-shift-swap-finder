const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {dates,grid,metadataGrid,items} = require('./fixtures.cjs');
const context = {window:{}, Date, Set, Uint8Array}; vm.createContext(context);
for (const file of ['schedule-model','schedule-validator','pdf-parser','import-confirmation']) {
  vm.runInContext(fs.readFileSync(`js/${file}.js`,'utf8'), context);
}
const {Model, Validator, PdfParser, ImportConfirmation:C} = context.window.NSSShiftSwapFinder;
const range = () => dates(33, Date.UTC(2026,10,4));
function sourceRows(typo=true) {
  const rows = metadataGrid(range());
  if (typo) rows[1][11] = '1/16';
  rows[2][5] = 'E休 -8'; rows[2][6] = 'O N';
  return rows;
}
function parse(rows=[sourceRows(),sourceRows(),sourceRows()]) {
  return C.initialize(PdfParser.positionedTables(rows.map((r,i) => ({pageNumber:i+1, items:items(r).reverse()}))), {autoCorrect:false});
}
function accept(model) {return C.decideDate(model,model.importConfirmation.dateSuggestions[0].id,true);}
test('one explicit decision corrects repeated three-page headers without changing source cells',()=>{
  const original=parse(); const suggestion=original.importConfirmation.dateSuggestions[0];
  assert.equal(suggestion.originalRaw,'1/16'); assert.equal(suggestion.correctedDate,'2026-11-11');
  assert.equal(suggestion.occurrences.length,3); assert.equal(original.dateCorrections.length,0);
  assert.equal(original.validation.readyForSearch,false);
  const m=accept(original);
  assert.equal(original.dateColumns.filter(c=>c.raw==='1/16').every(c=>c.date==='2026-01-16'),true);
  assert.equal(m.scheduleDates.length,33); assert.equal(m.scheduleStartDate,'2026-11-04');
  assert.equal(m.scheduleEndDate,'2026-12-06'); assert.equal(m.employees.length,2);
  assert.equal(m.dateCorrections.length,3); assert.equal(m.dateColumns.filter(c=>c.raw==='1/16').every(c=>c.date==='2026-11-11'),true);
  assert.equal(m.errors.length,0); assert.equal(m.validation.basicValidationPassed,true);
  assert.equal(m.validation.readyForSearch,false); assert.equal(m.cycleConfirmed,false);
  assert.equal(m.pdfNonDailyColumns.length,9); assert.equal(m.pdfUnresolvedColumns.length,0);
  for (const e of m.employees) {
    assert.equal(Object.keys(e.shifts).length,33);
    for (let i=0;i<range().length;i++) {
      const originalCell=sourceRows()[e.id==='EXAMPLE001'?2:3][i+4];
      assert.equal(e.shifts[range()[i]],Model.normalizeShift(originalCell));
      assert.equal(e.shiftDetails[range()[i]].length,3);
      assert.equal(e.shiftDetails[range()[i]].every(d=>d.raw===originalCell),true);
    }
  }
  assert.equal(C.decideDate(m,suggestion.id,true),m); // No repeat warning or duplicate audit.
  Validator.validate(m); assert.equal(m.errors.length,0);
});
test('rejection retains original dates and blocks cycle confirmation; decision can be reconsidered',()=>{
  let m=parse(); m=C.decideDate(m,m.importConfirmation.dateSuggestions[0].id,false);
  assert.equal(m.importConfirmation.dateSuggestions[0].status,'rejected');
  assert.equal(m.dateCorrections.length,0); assert.ok(m.errors.some(e=>e.code==='DATE_SEQUENCE'));
  C.setCycleStart(m,'2026-11-09'); assert.equal(C.confirmCycle(m),false);
  m=accept(m); C.setCycleStart(m,'2026-11-09'); assert.equal(C.confirmCycle(m),true);
});
test('formal cycle suggestion never auto-confirms; edits revoke confirmation and retain outside dates',()=>{
  const m=accept(parse()); assert.equal(m.cycleCandidates[0].startDate,'2026-11-09');
  assert.equal(C.confirmCycle(m),false);
  C.setCycleStart(m,'2026-11-09'); assert.equal(m.cycleEndDate,'2026-12-06');
  assert.equal(m.validation.readyForSearch,false); assert.equal(C.confirmCycle(m),true);
  assert.equal(m.validation.readyForSearch,true); assert.equal(m.validation.hasBlockingIssues,false);
  assert.equal(m.employees[0].validation.eligible,true); assert.ok(m.employees[0].shifts['2026-11-04']);
  C.setCycleStart(m,'2026-11-04'); assert.equal(m.cycleEndDate,'2026-12-01');
  assert.equal(m.cycleConfirmed,false); assert.equal(m.validation.readyForSearch,false);
  assert.equal(C.confirmCycle(m),true); assert.equal(m.scheduleDates.length,33);
  for (const bad of ['2026-11-10','2026-11-03','2026-02-30','2026-13-01','']) {
    C.setCycleStart(m,bad); assert.equal(C.confirmCycle(m),false); assert.equal(m.validation.readyForSearch,false);
  }
});
test('confirmed correction preserves unrelated date conflicts and gaps',()=>{
  for (const badDate of ['2026-11-11','2026-11-29']) {
    const rows=sourceRows(); rows[1][25]=badDate;
    const m=accept(parse([rows,rows,rows]));
    assert.equal(m.validation.basicValidationPassed,false);
    assert.ok(m.errors.some(e=>e.code==='DUPLICATE_DATE_COLUMN' || e.code==='DATE_GAP'));
    C.setCycleStart(m,'2026-11-09'); assert.equal(C.confirmCycle(m),false);
  }
});
test('cross-page differences remain blocking after the known typo is confirmed',()=>{
  const different=sourceRows(); different[1][20]='2026-11-19';
  const m=accept(parse([sourceRows(),different,sourceRows()]));
  assert.ok(m.errors.some(e=>e.code==='CROSS_PAGE_DATES'));
  assert.equal(m.validation.readyForSearch,false);
});
test('unknown codes and conflicting daily shifts remain blocking after correction',()=>{
  for(const code of ['OX','A特']) {
    const rows=sourceRows();rows[2][12]=code;
    const m=accept(parse([rows]));
    assert.ok(m.errors.some(e=>e.code==='UNKNOWN_SHIFT'||e.code==='BLANK_SHIFT'));
    assert.equal(m.employees[1].validation.complete,true);
    C.setCycleStart(m,'2026-11-09');assert.equal(C.confirmCycle(m),false);
  }
  const rows=sourceRows(); rows[2][11]='N';
  const m=accept(parse([sourceRows(),rows]));
  assert.ok(m.errors.some(e=>e.code==='SHIFT_CONFLICT'&&e.conflict.date==='2026-11-11'));
  assert.equal(m.employees[0].shiftDetails['2026-11-11'].length,2);
});
test('geometry/Excel merged-cell errors survive source rebuilding',()=>{
  const m=parse(); Model.issue(m,'errors','global','COLUMN_ALIGNMENT','Synthetic geometry error');
  const rebuilt=accept(m); assert.ok(rebuilt.errors.some(e=>e.code==='COLUMN_ALIGNMENT'));
  assert.equal(rebuilt.validation.basicValidationPassed,false);
  const rows=grid(range()); rows[1][9]='1/16';
  const excel=C.initialize(Validator.validate(Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map((r,i)=>r.map((value,j)=>({value,source:{sheet:'Synthetic',row:i+1,column:j+1}})))}],'excel')));
  Model.issue(excel,'errors','global','MERGED_DATA','Synthetic merge error');
  assert.ok(accept(excel).errors.some(e=>e.code==='MERGED_DATA'));
});
test('no suggestion without two-sided date evidence; calendar math handles year boundaries',()=>{
  const rows=sourceRows(); rows[1][12]='2026-11-14';
  assert.equal(parse([rows]).importConfirmation.dateSuggestions.length,0);
  assert.equal(C.addDays('2026-12-20',27),'2027-01-16');
  const m=C.initialize(Validator.validate(Model.fromTables([{source:{sheet:'Synthetic'},rows:grid(dates(28,Date.UTC(2026,11,20))).map(r=>r.map(value=>({value})))}],'excel')));
  C.setCycleStart(m,'2026-12-20'); assert.equal(C.confirmCycle(m),true);
});

test('multiple independent suggestions can be confirmed in sequence without losing earlier decisions',()=>{
  const rows=sourceRows(); rows[1][19]='2/16';
  let m=parse([rows,rows,rows]); assert.equal(m.importConfirmation.dateSuggestions.length,2);
  const ids=m.importConfirmation.dateSuggestions.map(s=>s.id);
  m=C.decideDate(m,ids[0],true); assert.ok(m.errors.length);
  m=C.decideDate(m,ids[1],true);
  assert.equal(m.errors.length,0); assert.equal(m.dateCorrections.length,6);
  assert.equal(m.importConfirmation.dateSuggestions.every(s=>s.status==='accepted'),true);
  assert.equal(m.scheduleDates.length,33);
});
