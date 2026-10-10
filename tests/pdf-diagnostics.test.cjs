// Error messages intentionally contain fake sensitive text to verify redaction.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {grid,items} = require('./fixtures.cjs');
function setup({failAt, errorName='Error', cleanupFails=false, badEncoding=false, badGeometry=false}={}) {
 const c={window:{},document:{baseURI:'http://127.0.0.1:8000/index.html'},URL,Uint8Array,Date,Set};vm.createContext(c);
 for(const name of ['schedule-model','schedule-validator','pdf-parser'])vm.runInContext(fs.readFileSync(`js/${name}.js`,'utf8'),c);
 const ns=c.window.NSSShiftSwapFinder,calls=[];
 const fail=()=>{const e=new Error('FAKE_PRIVATE_TEXT');e.name=errorName;throw e;};
 const file={arrayBuffer:async()=>{calls.push('file-read');if(failAt==='file-read')fail();return new ArrayBuffer(0);}};
 const lib={getDocument(options){calls.push('document-load');assert.equal(options.stopAtErrors,true);assert.equal(options.verbosity,0);assert.equal(options.cMapUrl,'http://127.0.0.1:8000/vendor/pdfjs/cmaps/');assert.equal(options.standardFontDataUrl,'http://127.0.0.1:8000/vendor/pdfjs/standard_fonts/');if(failAt==='document-sync')fail();
  return {promise:(async()=>{if(failAt==='document-load')fail();return {numPages:1,getPage:async()=>{calls.push('page-load');if(failAt==='page-load')fail();return {getTextContent:async()=>{calls.push('text-extraction');if(failAt==='text-extraction')fail();const data=items(grid());if(badEncoding)data[0].str='\uFFFD';if(badGeometry)data[0].transform=null;return {items:data};},cleanup(){calls.push('page-cleanup');if(cleanupFails)fail();}};}};})(),destroy:async()=>{calls.push('document-cleanup');if(cleanupFails)fail();}};
 }};
 if(failAt==='table-recognition')ns.Model={...ns.Model,fromTables:fail};
 return {parser:ns.PdfParser,file,lib,calls,environment:c};
}
test('file/getDocument/getPage/getTextContent/table exceptions have distinct sanitized stages',async()=>{
 for(const stage of ['file-read','document-sync','document-load','page-load','text-extraction','table-recognition']) {
  const {parser,file,lib,calls}=setup({failAt:stage});
  await assert.rejects(parser.parseWithLibrary(file,lib),e=>{
   assert.equal(e.stage,stage==='document-sync'?'document-load':stage);
   assert.ok(!e.message.includes('FAKE_PRIVATE_TEXT'));
   assert.ok(!JSON.stringify(e.diagnostics).includes('FAKE_PRIVATE_TEXT'));
   assert.equal(e.cause,undefined);
   if(stage==='table-recognition') {assert.match(e.message,/文字擷取成功.*表格辨識失敗/);assert.doesNotMatch(e.message,/文字擷取失敗/);assert.ok(e.diagnostics.textItemCount>0);}
   if(stage==='page-load')assert.ok(!calls.includes('text-extraction'));
   if(stage==='document-load')assert.ok(!calls.includes('page-load'));
   return true;
  });
 }
});
test('reader fallback consumes every chunk and releases lock; read errors cancel without masking',async()=>{
 for(const failRead of [false,true]) {
  const s=setup();s.environment.window.ReadableStream=function(){};
  const chunks=[{items:items(grid()).slice(0,12),styles:{},lang:'en'},
    {items:items(grid()).slice(12),styles:{},lang:'en'}];
  let index=0,cancelled=0,released=0,destroyed=0;
  const reader={async read(){if(failRead)throw new TypeError('FAKE_PRIVATE_TEXT');return index<chunks.length?{done:false,value:chunks[index++]}:{done:true};},
    async cancel(){cancelled++;throw new Error('cleanup');},releaseLock(){released++;if(failRead)throw new Error('cleanup');}};
  const page={getTextContent(){throw new Error('native must not be called');},streamTextContent(params){assert.equal(params.includeMarkedContent,false);return {getReader:()=>reader};},cleanup(){}};
  const lib={getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>page}),destroy:async()=>{destroyed++;}})};
  if(failRead)await assert.rejects(s.parser.parseWithLibrary(s.file,lib),e=>{assert.equal(e.stage,'text-extraction');assert.equal(e.diagnostics.errorType,'TypeError');assert.doesNotMatch(e.message,/FAKE_PRIVATE_TEXT|cleanup/);return true;});
  else {const m=await s.parser.parseWithLibrary(s.file,lib);assert.equal(m.validation.basicValidationPassed,true);assert.equal(m.employees.length,2);assert.equal(m.pdfDiagnostics.textExtractionMethod,'streamTextContent.getReader');}
  assert.equal(cancelled,failRead?1:0);assert.equal(released,1);assert.equal(destroyed,1);
 }
});
test('pure XFA keeps native getTextContent even when stream async iteration is absent',async()=>{
 const s=setup();s.environment.window.ReadableStream=function(){};
 const original=s.lib.getDocument;
 s.lib.getDocument=options=>{const task=original(options);task.promise=task.promise.then(doc=>({...doc,getPage:async n=>({...await doc.getPage(n),isPureXfa:true})}));return task;};
 const m=await s.parser.parseWithLibrary(s.file,s.lib);assert.equal(m.pdfDiagnostics.textExtractionMethod,'getTextContent');assert.equal(m.validation.basicValidationPassed,true);
});
test('password/invalid PDF retain specific load errors; unknown error names are sanitized',async()=>{
 for(const [name,code] of [['PasswordException','PASSWORD_REQUIRED'],['InvalidPDFException','INVALID_PDF'],['FAKE_PRIVATE_TEXT','DOCUMENT_LOAD_FAILED']]) {
  const {parser,file,lib}=setup({failAt:'document-load',errorName:name});
  await assert.rejects(parser.parseWithLibrary(file,lib),e=>{assert.equal(e.code,code);assert.ok(!e.message.includes('FAKE_PRIVATE_TEXT'));assert.ok(!JSON.stringify(e.diagnostics).includes('FAKE_PRIVATE_TEXT'));return true;});
 }
});
test('cleanup failures cannot overwrite success or primary stage failures',async()=>{
 const good=setup({cleanupFails:true});const model=await good.parser.parseWithLibrary(good.file,good.lib);assert.equal(model.validation.basicValidationPassed,true);assert.equal(model.pdfDiagnostics.cleanupFailed,true);
 const bad=setup({failAt:'text-extraction',cleanupFails:true});await assert.rejects(bad.parser.parseWithLibrary(bad.file,bad.lib),e=>{assert.equal(e.stage,'text-extraction');assert.equal(e.diagnostics.cleanupFailed,true);return true;});
});
test('obvious encoding anomalies and invalid geometry are not text extraction exceptions',async()=>{
 for(const [options,code,stage] of [[{badEncoding:true},'TEXT_ENCODING_INVALID','text-encoding'],[{badGeometry:true},'INVALID_TEXT_GEOMETRY','table-recognition']]) {
  const s=setup(options);const model=await s.parser.parseWithLibrary(s.file,s.lib);assert.equal(model.pdfDiagnostics.stage,stage);assert.ok(model.errors.some(e=>e.code===code));assert.equal(model.validation.globalStructureValid,false);assert.ok(model.pdfDiagnostics.textItemCount>0);
 }
});

test('wrapped edge dates, left-aligned shifts and footer preserve every dated column',()=>{
 const s=setup(),ds=require('./fixtures.cjs').dates(35),raw=[];
 const add=(str,x,y,width=str.length*3)=>raw.push({str,width,height:6,transform:[1,0,0,1,x,y]});
 add('Synthetic schedule 2026',20,750);add('ID',20,700);add('Name',90,700);
 ds.forEach((date,i)=>{
  const x=180+i*24,month=String(+date.slice(5,7)),day=String(+date.slice(8));
  if(i===0||i===ds.length-1){add(month+'/',x+5,703);add(day,x+5,697);}
  else add(month+'/'+day,x+5,700);
  add(i%2?'OF':'A',x+1,680,i%2?6:3);
 });
 add('EXAMPLE001',20,680);add('Example Nurse',90,680);add('Synthetic footer',300,600);
 const model=s.parser.positionedTables([{pageNumber:1,items:raw.reverse()}]);
 assert.equal(model.scheduleDates.length,35);assert.equal(model.employees.length,1);assert.equal(model.validation.basicValidationPassed,true);assert.equal(model.employees[0].shifts[ds[0]],'A');assert.equal(model.employees[0].shifts[ds.at(-1)],'A');
});
test('unresolved side columns retain raw per-employee values without guessing dates',()=>{
 const s=setup(),raw=items(grid());raw.push({str:'Month carryover',width:40,height:8,transform:[1,0,0,1,1800,726]},{str:'OF',width:10,height:8,transform:[1,0,0,1,1800,702]});
 const model=s.parser.positionedTables([{pageNumber:1,items:raw}]);
 assert.ok(model.pdfUnresolvedColumns.length);assert.ok(model.pdfUnresolvedColumns.some(c=>c.values.some(v=>v.rawShift==='OF')));assert.equal(model.validation.globalStructureValid,false);
 assert.equal(model.pdfTableRecognized,true);
});
test('recognized tables with invalid data report validation, not recognition failure',async()=>{
 const s=setup(),original=s.lib.getDocument;
 s.lib.getDocument=options=>{
  const task=original(options),promise=task.promise;
  task.promise=promise.then(doc=>({...doc,getPage:async()=>({
   getTextContent:async()=>{const data=items(grid());data.find(i=>i.str==='A').str='OX';return {items:data};},cleanup(){}
  })}));return task;
 };
 const model=await s.parser.parseWithLibrary(s.file,s.lib);
 assert.equal(model.pdfTableRecognized,true);
 assert.equal(model.pdfDiagnostics.stage,'data-validation');
 assert.ok(model.errors.some(e=>e.code==='UNKNOWN_SHIFT'));
 assert.equal(model.validation.basicValidationPassed,false);
 assert.equal(model.validation.readyForSearch,false);
});
test('exact confirmed non-daily headers preserve raw values and sources outside daily shifts',()=>{
 const s=setup(),{metadataGrid,dates}=require('./fixtures.cjs');
 const original=s.parser.positionedTables([{pageNumber:1,items:items(grid(dates(33)))}]);
 const m=s.parser.positionedTables([1,2].map(pageNumber=>({pageNumber,items:items(metadataGrid(dates(33)))})));
 assert.equal(m.employees.length,2);assert.equal(m.scheduleDates.length,33);
 assert.equal(JSON.stringify(m.employees.map(e=>e.shifts)),JSON.stringify(original.employees.map(e=>e.shifts)));
 assert.equal(m.pdfNonDailyColumns.length,6);assert.equal(m.pdfUnresolvedColumns.length,0);
 assert.equal(m.errors.length,0);assert.equal(m.validation.basicValidationPassed,true);
 for(const c of m.pdfNonDailyColumns){assert.ok(c.rawHeader);assert.ok(c.kind);assert.ok(c.source.page);assert.equal(c.values.length,2);assert.ok(c.values.every(v=>v.rawValue&&v.employeeId.startsWith('EXAMPLE')&&v.source.page===c.source.page));}
 assert.equal(m.pdfNonDailyColumns.find(c=>c.kind==='qualifiedPosition').values[0].rawValue,'A');
});
test('similar or unknown headers remain unresolved, including unrecognized non-shift prefix columns',()=>{
 const s=setup();
 for(const label of ['10月預定夜班','11月預定夜班備註','11 月預定夜班','單位備註','toString']) {
  const rows=grid();rows[1].push(label);rows.slice(2).forEach(r=>r.push('N'));
  const m=s.parser.positionedTables([{pageNumber:1,items:items(rows)}]);
  assert.equal(m.pdfNonDailyColumns.length,0);assert.ok(m.errors.some(e=>e.code==='UNMAPPED_COLUMN'));
  assert.ok(m.pdfUnresolvedColumns.some(c=>c.rawHeader===label));
 }
 const raw=items(grid());raw.push({str:'未確認欄',width:14,height:8,transform:[1,0,0,1,0,726]},
  {str:'資格甲',width:14,height:8,transform:[1,0,0,1,0,702]},{str:'資格乙',width:14,height:8,transform:[1,0,0,1,0,678]});
 const m=s.parser.positionedTables([{pageNumber:1,items:raw}]);
 assert.ok(m.errors.some(e=>e.code==='UNMAPPED_COLUMN'));assert.ok(m.pdfUnresolvedColumns.some(c=>c.rawHeader==='未確認欄'));
});
