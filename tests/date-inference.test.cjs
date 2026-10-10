// All documents and identities are fictional; no real schedule content is saved.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {dates,grid,items} = require('./fixtures.cjs');
const ctx={window:{},Date,Set,Uint8Array};vm.createContext(ctx);
for(const file of ['schedule-model','schedule-validator','pdf-parser','import-confirmation']) {
  vm.runInContext(fs.readFileSync(`js/${file}.js`,'utf8'),ctx);
}
const ns=ctx.window.NSSShiftSwapFinder,C=ns.ImportConfirmation;
function page(rows,i) {return {pageNumber:i+1,items:items(rows).reverse()};}
function parse(rows) {return C.initialize(ns.PdfParser.positionedTables(rows.map(page)));}
function rowsFor(first,index,typo,partial=false) {
  const ds=dates(33,Date.parse(first)),rows=grid(ds);
  rows[0]=[`Synthetic schedule ${first.slice(0,4)}`];
  if(partial)rows[1]=['ID','Name',...ds.map(d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))}`)];
  rows[1][index+2]=typo;
  // Distinct values and exact source positions catch date/shift movement.
  rows[2]=['EXAMPLE001','Example Nurse 1',...ds.map((_,i)=>['A休 -8','N','E','OF','ON','O8','OZ'][i%7])];
  return {rows,ds};
}
function verifyCells(m,rows,ds,repeats=1) {
  assert.deepEqual(Array.from(m.scheduleDates),ds);
  assert.equal(ns.Model.dateCellsPreserved(m),true);
  assert.equal(Object.keys(m.employees[0].shifts).length,33);
  for(const [i,date] of ds.entries()) {
    assert.equal(m.employees[0].shifts[date],ns.Model.normalizeShift(rows[2][i+2]));
    assert.equal(m.employees[0].shiftDetails[date].length,repeats);
    assert.equal(m.employees[0].shiftDetails[date].every(d=>d.raw===rows[2][i+2]),true);
  }
}
test('generic inference supports different years/months, month boundaries and leap days',()=>{
  for(const [first,index,typo,expected] of [
    ['2026-11-04',7,'1/16','2026-11-11'],
    ['2027-04-08',7,'2/2','2027-04-15'],
    ['2027-04-25',6,'2/2','2027-05-01'],
    ['2026-12-25',7,'2/2','2027-01-01'],
    ['2027-02-21',7,'2/30','2027-02-28'],
    ['2028-02-22',7,'2/30','2028-02-29'],
  ]) {
    for(const partial of [false,true]) {
      const {rows,ds}=rowsFor(first,index,typo,partial),m=parse([rows,rows,rows]);
      assert.equal(m.importConfirmation.dateSuggestions.length,1,`${first}, ${partial}`);
      assert.equal(m.importConfirmation.dateSuggestions[0].status,'automatic',`${first}, ${partial}`);
      assert.equal(m.importConfirmation.dateSuggestions[0].correctedDate,expected);
      assert.equal(m.dateCorrections.filter(c=>c.kind==='date-header').length,3);
      assert.equal(m.dateCorrections.every(c=>c.reason&&c.source&&c.originalRaw&&c.correctedDate&&c.confirmedBy==='automatic'),true);
      assert.equal(m.dateColumns.filter(c=>c.raw===typo).every(c=>c.correctedDate===expected),true);
      assert.equal(m.errors.length,0);assert.equal(m.validation.readyForSearch,false);
      verifyCells(m,rows,ds,3);
      assert.equal(C.initialize(m),m); // Idempotent, not repeated correction.
    }
  }
});
test('partial cross-year typo restores implicit year rollover and records derived changes',()=>{
  const {rows,ds}=rowsFor('2026-12-24',7,'2/2',true); // Mistyped Dec 31 before Jan 1.
  const m=parse([rows]);verifyCells(m,rows,ds);
  assert.equal(m.importConfirmation.dateSuggestions[0].correctedDate,'2026-12-31');
  assert.ok(m.dateCorrections.some(c=>c.kind==='year-context'&&c.originalDate.startsWith('2026-01')&&c.correctedDate.startsWith('2027-01')));
  assert.equal(m.cycleCandidates[0].startDate,ds[5]);
});
test('multiple independently bounded typos are applied as one verified batch',()=>{
  const {rows,ds}=rowsFor('2027-04-08',7,'2/2');rows[1][21]='8/8';
  const m=parse([rows,rows]);
  assert.equal(m.importConfirmation.dateSuggestions.length,2);
  assert.equal(m.importConfirmation.dateSuggestions.every(s=>s.status==='automatic'),true);
  assert.equal(m.dateCorrections.length,4);verifyCells(m,rows,ds,2);
});
test('adjacent ambiguous typos and contradictory neighbors do not change source data',()=>{
  for(const next of ['8/8','2027-04-18']) {
    const {rows}=rowsFor('2027-04-08',7,'2/2');rows[1][10]=next;
    const original=ns.PdfParser.positionedTables([page(rows,0)]),before=JSON.stringify(original.dateColumns);
    const m=C.initialize(original);
    assert.equal(m,original);assert.equal(JSON.stringify(m.dateColumns),before);
    assert.equal(m.dateCorrections.length,0);assert.equal(m.validation.readyForSearch,false);
    assert.ok(m.errors.length);
  }
});
test('cross-page date disagreement blocks automation including different range endpoints',()=>{
  for(const conflictingIndex of [0,7,18,32]) {
    const {rows}=rowsFor('2027-04-08',7,'2/2');const different=rows.map(r=>r.slice());
    different[1][conflictingIndex+2]=conflictingIndex===7?'3/3':'2027-07-01';
    const m=parse([rows,different]);
    assert.equal(m.dateCorrections.length,0);
    assert.equal(m.importConfirmation.dateSuggestions.every(s=>s.status==='pending'),true);
    assert.equal(m.validation.readyForSearch,false);
    assert.ok(m.errors.some(e=>e.code==='CROSS_PAGE_DATES'));
  }
});
test('duplicate dates, incomplete sequences and shift conflicts veto the entire automatic batch',()=>{
  for(const bad of ['2027-04-15','2027-07-02']) {
    const {rows}=rowsFor('2027-04-08',7,'2/2');rows[1][34]=bad;
    const m=parse([rows]);assert.equal(m.dateCorrections.length,0);
    assert.equal(m.importConfirmation.dateSuggestions[0].status,'pending');
    assert.equal(m.validation.readyForSearch,false);
  }
  const {rows}=rowsFor('2027-04-08',7,'2/2'),other=rows.map(r=>r.slice());other[2][9]='N';
  const m=parse([rows,other]);assert.equal(m.dateCorrections.length,0);
  assert.ok(m.errors.some(e=>e.code==='SHIFT_CONFLICT'));
});
test('geometry uncertainty and any changed source cell prevent automatic correction',()=>{
  const {rows}=rowsFor('2027-04-08',7,'2/2');
  const raw=ns.PdfParser.positionedTables([page(rows,0)]);raw.pdfTableRecognized=false;
  assert.equal(C.initialize(raw).dateCorrections.length,0);
  const originalModel=ns.Model;
  ns.Model={...originalModel,rebuildDates(model,corrections){
    const m=originalModel.rebuildDates(model,corrections);
    m.employees[0].shifts['2027-04-15']='E';return m;
  }};
  try {assert.equal(parse([rows]).dateCorrections.length,0);}finally{ns.Model=originalModel;}
});
test('unknown shift remains blocking while a safe date typo is corrected',()=>{
  const {rows}=rowsFor('2027-04-08',7,'2/2');rows[2][10]='OX';
  const m=parse([rows]);assert.equal(m.importConfirmation.dateSuggestions[0].status,'automatic');
  assert.ok(m.errors.some(e=>e.code==='UNKNOWN_SHIFT'));assert.equal(m.validation.readyForSearch,false);
  C.setCycleStart(m,'2027-04-13');assert.equal(C.confirmCycle(m),false);
});
test('automatic dates never confirm the cycle; every cycle date must be in the parsed range',()=>{
  const {rows,ds}=rowsFor('2027-04-08',7,'2/2'),m=parse([rows]);
  assert.equal(m.cycleConfirmed,false);assert.equal(m.cycleCandidates[0].startDate,ds[5]);
  assert.equal(C.confirmCycle(m),false);
  C.setCycleStart(m,ds[5]);assert.equal(m.cycleEndDate,ds[32]);assert.equal(C.confirmCycle(m),true);
  C.setCycleStart(m,ds[6]);assert.equal(C.confirmCycle(m),false);
  C.setCycleStart(m,'2027-04-07');assert.equal(C.confirmCycle(m),false);
  assert.equal(m.scheduleDates.length,33);
});
