// Run with Playwright available on NODE_PATH. Generates only fictional in-memory files.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {pdf,grid,metadataGrid,dates} = require('./fixtures.cjs');
const XLSX = require('../vendor/sheetjs/xlsx.full.min.js');
const project = path.resolve(__dirname,'..');
function spreadsheet(multiple=false,type='xlsx') {
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid()),'Synthetic A');
 if(multiple)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid()),'Synthetic B');
 return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:type}));
}
test('real browser local parsing, result states, selection reset, no outbound requests', async()=>{
 const requests=[], pageErrors=[];
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method !== 'GET' || !/^\/(index\.html|js\/[^/]+\.js|css\/style\.css|vendor\/[\w/.-]+)$/.test(url.pathname)) {res.writeHead(404).end();return;}
  const file=path.join(project,url.pathname);
  if(!file.startsWith(project+path.sep)) {res.writeHead(403).end();return;}
  try {const data=fs.readFileSync(file);res.setHeader('Content-Type',file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);} catch {res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 let browser;
 try {
  browser=await chromium.launchPersistentContext(path.join(project,'test-data/browser-profile'),{executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:{width:390,height:844}});
  const page=await browser.newPage();
  browser.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(`${origin}/index.html`);
  assert.equal(await page.locator('#parse-button').isDisabled(),true);
  async function progress() {return page.locator('#import-progress li').evaluateAll(els=>els.map(e=>e.dataset.state));}
  assert.deepEqual(await progress(),['current','pending','pending','pending']);
  await page.evaluate(()=>{
    window.scrollGuides=[];
    const original=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(options){window.scrollGuides.push({id:this.id,behavior:options?.behavior});return original.call(this,options);};
  });
  async function lastGuide() {return page.evaluate(()=>window.scrollGuides.at(-1));}
  async function guidedTo(id) {await page.waitForFunction(id=>document.activeElement.id===id&&window.scrollGuides.at(-1)?.id===id,id);}
  async function choose(name,mimeType,buffer) {await page.locator('#schedule-file').setInputFiles({name,mimeType,buffer});}
  async function parse() {await page.locator('#parse-button').click();await page.waitForFunction(()=>!document.querySelector('#parse-button').disabled);}
  for (const [name,mimeType,buffer] of [
   ['synthetic.pdf','application/pdf',pdf([grid()])],
   ['synthetic-multipage.pdf','application/pdf',pdf([grid(),grid()])],
   ['synthetic-metadata.pdf','application/pdf',pdf([metadataGrid(),metadataGrid()])],
   ['synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',spreadsheet()],
   ['synthetic.xls','application/vnd.ms-excel',spreadsheet(false,'xls')],
  ]) {
   await choose(name,mimeType,buffer);
   assert.deepEqual(await progress(),['completed','current','pending','pending']);
   await parse();
   assert.deepEqual(await progress(),['completed','completed','current','pending']);
   assert.equal(await page.locator('#status').textContent(),'班表解析成功！還差最後一步，請確認正式四週期。');
   await guidedTo('cycle-confirmation');
   assert.deepEqual(await lastGuide(),{id:'cycle-confirmation',behavior:'smooth'});
   assert.equal(await page.locator('#cycle-status-slot #status').count(),1);
   assert.equal(await page.locator('#status').count(),1);
   await page.waitForFunction(()=>{const r=document.querySelector('#confirm-cycle').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;},undefined,{timeout:5000}).catch(async()=>{
    const rect=await page.evaluate(()=>({scrollY,active:document.activeElement.id,top:document.querySelector('#confirm-cycle').getBoundingClientRect().top,bottom:document.querySelector('#confirm-cycle').getBoundingClientRect().bottom,viewport:innerHeight}));
    throw new Error(`Synthetic fixture ${name}: confirmation button outside viewport ${JSON.stringify(rect)}`);
   });
   assert.equal(await page.locator('#parse-result').isVisible(),true,`result: ${name}, ${await page.locator('#status').textContent()}`);
   assert.match(await page.locator('#result-state').textContent(),/基礎資料驗證通過/);
   assert.match(await page.locator('#result-state').textContent(),/尚未確認正式四週期/);
  }
  // Verify local resource paths and distinguish table failure from extraction failure.
  const resourceStatus=await page.evaluate(async()=>Promise.all([
    '/vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
    '/vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
    '/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  ].map(async path=>{const r=await fetch(path);return {status:r.status,bytes:(await r.arrayBuffer()).byteLength};})));
  assert.ok(resourceStatus.every(r=>r.status===200&&r.bytes>0));
  const probe=await page.evaluate(()=>window.NSSShiftSwapFinder.PdfParser.startDiagnostics());
  assert.equal(probe.probeSource,'generated-synthetic-pdf');
  assert.equal(probe.libraryVersion,'6.4.299');
  assert.equal(probe.probe.success,true);
  assert.ok(probe.probe.textItemCount>0);
  const missingIterator=await page.evaluate(async bytes=>{
    const parser=window.NSSShiftSwapFinder.PdfParser;
    const file=new File([new Uint8Array(bytes)],'synthetic.pdf');
    const normal=await parser.parse(file);
    const descriptor=Object.getOwnPropertyDescriptor(ReadableStream.prototype,Symbol.asyncIterator);
    try {
      // Simulate only the missing API; this is not an actual Safari test.
      delete ReadableStream.prototype[Symbol.asyncIterator];
      await parser.startDiagnostics();
      const fallback=await parser.parse(file);
      const method=fallback.pdfDiagnostics.textExtractionMethod;
      delete normal.pdfDiagnostics.textExtractionMethod;
      delete fallback.pdfDiagnostics.textExtractionMethod;
      return {report:parser.getDiagnostics(),method,identical:JSON.stringify(normal)===JSON.stringify(fallback),
        blocked:!fallback.validation.readyForSearch,errors:fallback.errors.map(e=>e.code),
        nonDailyCount:fallback.pdfNonDailyColumns.length,unresolvedCount:fallback.pdfUnresolvedColumns.length,
        dateCount:fallback.scheduleDates.length,dailyShiftCount:fallback.employees.reduce((n,e)=>n+Object.keys(e.shifts).length,0),
        annotations:fallback.employees[0].shiftDetails['2026-11-09'][0],on:fallback.employees[0].shifts['2026-11-10']};
    } finally {Object.defineProperty(ReadableStream.prototype,Symbol.asyncIterator,descriptor);}
  },Array.from(pdf([(()=>{const g=metadataGrid(dates(33));g[1][6]='1/16';g[2][4]='E休 -8';g[2][5]='O N';g[2][7]='OX';return g;})(),metadataGrid(dates(33))])));
  assert.equal(missingIterator.report.streamGetReader,true);
  assert.equal(missingIterator.report.streamAsyncIterator,false);
  assert.equal(missingIterator.report.probe.success,true);
  assert.equal(missingIterator.report.textExtractionMethod,'streamTextContent.getReader');
  assert.equal(missingIterator.report.lastFailure,null);
  assert.equal(missingIterator.method,'streamTextContent.getReader');
  assert.equal(missingIterator.identical,true);
  assert.equal(missingIterator.blocked,true);
  assert.equal(missingIterator.nonDailyCount,6);
  assert.equal(missingIterator.unresolvedCount,0);
  assert.equal(missingIterator.dateCount,34); // Both the anomalous and original dates remain.
  assert.equal(missingIterator.dailyShiftCount,68);
  assert.ok(missingIterator.errors.includes('DATE_SEQUENCE'));
  assert.ok(missingIterator.errors.includes('UNKNOWN_SHIFT'));
  assert.equal(missingIterator.annotations.raw,'E休 -8');
  assert.equal(missingIterator.annotations.normalized,'E');
  assert.equal(missingIterator.on,'ON');
  await page.evaluate(()=>window.NSSShiftSwapFinder.PdfParser.startDiagnostics());
  const redacted=await page.evaluate(async()=>{
    const parser=window.NSSShiftSwapFinder.PdfParser;
    const error=new TypeError('SYNTHETIC_PRIVATE_SENTINEL');
    error.stack='TypeError: SYNTHETIC_PRIVATE_SENTINEL\nprivateName@'+location.origin+'/vendor/pdfjs/pdf.mjs:22362:20\nPRIVATE_ID@example.invalid:1:2';
    const lib={getDocument(){return {promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>{throw error;}})}),destroy:async()=>{}};}};
    try {await parser.parseWithLibrary({arrayBuffer:async()=>new ArrayBuffer(0)},lib);}catch{}
    return parser.getDiagnostics();
  });
  assert.equal(redacted.lastFailure.matchesSyntheticProbe,false);
  assert.equal(redacted.lastFailure.stage,'text-extraction');
  assert.equal(redacted.lastFailure.stackLocations.length,1);
  assert.doesNotMatch(JSON.stringify(redacted),/SYNTHETIC_PRIVATE_SENTINEL|privateName|PRIVATE_ID|example.invalid/);
  await page.evaluate(()=>window.NSSShiftSwapFinder.PdfParser.stopDiagnostics());
  assert.equal(await page.evaluate(()=>window.NSSShiftSwapFinder.PdfParser.getDiagnostics()),null);
  // Exercise automatic date correction and explicit cycle confirmation in both API paths.
  const reviewRows=metadataGrid(dates(33,Date.UTC(2026,10,4)));
  reviewRows[1][11]='1/16'; reviewRows[2][5]='E休 -8'; reviewRows[2][6]='O N';
  for (const fallback of [false,true]) {
    if(fallback) await page.evaluate(()=>{
      window.iteratorDescriptor=Object.getOwnPropertyDescriptor(ReadableStream.prototype,Symbol.asyncIterator);
      delete ReadableStream.prototype[Symbol.asyncIterator];
    });
    await choose('date-confirmation.pdf','application/pdf',pdf([reviewRows,reviewRows,reviewRows]));
    assert.equal(await page.locator('#cycle-start').inputValue(),'');
    assert.equal(await page.locator('#date-suggestions .date-suggestion').count(),0);
    await parse();
    assert.equal(await page.locator('#date-suggestions .date-suggestion').count(),0);
    assert.match(await page.locator('#date-review-state').textContent(),/已自動修正 1 個日期標題/);
    assert.equal(await page.locator('#date-suggestions button').count(),0);
    assert.match(await page.locator('#date-review-state').textContent(),/通過/);
    assert.equal(await page.locator('#cycle-start').inputValue(),'2026-11-09');
    assert.equal(await page.locator('#cycle-end').textContent(),'2026-12-06');
    assert.match(await page.locator('#result-state').textContent(),/尚未確認/);
    assert.doesNotMatch(await page.locator('#result-issues').textContent(),/日期順序異常|日期有缺漏/);
    await page.locator('#cycle-start').fill('2026-11-10');
    assert.equal(await page.locator('#confirm-cycle').isDisabled(),true);
    assert.match(await page.locator('#cycle-state').textContent(),/超出班表/);
    await page.locator('#cycle-start').fill('2026-11-04');
    assert.equal(await page.locator('#cycle-end').textContent(),'2026-12-01');
    await page.locator('#confirm-cycle').click();
    assert.match(await page.locator('#result-state').textContent(),/匯入完成/);
    assert.deepEqual(await progress(),['completed','completed','completed','completed']);
    await guidedTo('identity-selection');
    const guidesAfterConfirm=await page.evaluate(()=>window.scrollGuides.length);
    await page.locator('#cycle-start').fill('2026-11-09');
    assert.match(await page.locator('#result-state').textContent(),/尚未確認/);
    assert.deepEqual(await progress(),['completed','completed','current','pending']);
    assert.equal(await page.evaluate(()=>window.scrollGuides.length),guidesAfterConfirm);
    await page.locator('#confirm-cycle').click();
    assert.match(await page.locator('#status').textContent(),/匯入完成/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(fallback) await page.evaluate(()=>{
      Object.defineProperty(ReadableStream.prototype,Symbol.asyncIterator,window.iteratorDescriptor);delete window.iteratorDescriptor;
    });
  }
  // v0.3: actual UI selection, explicit confirmation, remembered ID and resets.
  async function identityImport(rows) {
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'Identity');
    await choose('identity.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})));
    assert.equal(await page.locator('#identity-selection').isVisible(),false);
    assert.equal(await page.locator('#personal-schedule').isVisible(),false);
    await parse(); assert.equal(await page.locator('#identity-selection').isVisible(),false);
    await page.locator('#confirm-cycle').click(); await guidedTo('identity-selection');
  }
  const identityRows=grid(dates(33,Date.UTC(2026,11,23)));
  identityRows[3][1]=identityRows[2][1]; // two different IDs, same synthetic name
  await identityImport(identityRows);
  assert.equal(await page.locator('#personal-schedule').isVisible(),false);
  await page.locator('#employee-search').fill('EXAMPLE');
  assert.equal(await page.locator('.employee-option').count(),2);
  await page.locator('.employee-option').first().click();
  assert.equal(await page.locator('#identity-review').isVisible(),true);
  assert.equal(await page.locator('#personal-schedule').isVisible(),false);
  await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  assert.equal(await page.locator('.personal-week').count(),4);
  assert.equal(await page.locator('.personal-day').count(),28);
  assert.equal(await page.locator('.personal-day time').first().getAttribute('datetime'),'2026-12-28');
  // Modify start to Wednesday across New Year: clear the calendar immediately.
  await page.locator('#cycle-start').fill('2026-12-23');
  assert.equal(await page.locator('#identity-selection').isVisible(),false);
  assert.equal(await page.locator('.personal-day').count(),0);
  await page.locator('#confirm-cycle').click();await guidedTo('identity-selection');
  assert.equal(await page.locator('#remembered-identity').isVisible(),true);
  await page.locator('#use-remembered').click();
  assert.equal(await page.locator('#personal-schedule').isVisible(),false);
  await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  assert.equal(await page.locator('.personal-day time').first().getAttribute('datetime'),'2026-12-23');
  assert.equal(await page.locator('.day-weekday').first().textContent(),'週三');
  assert.equal(await page.locator('.personal-day time').last().getAttribute('datetime'),'2027-01-19');
  const expected=identityRows[2].slice(2,30);
  assert.deepEqual(await page.locator('.personal-day strong').allTextContents(),expected);
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem(window.NSSShiftSwapFinder.PersonalSchedule.STORAGE_KEY)));
  assert.deepEqual(stored,{version:1,id:'EXAMPLE001'});
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(project,'test-data/personal-mobile-synthetic.png'),fullPage:true});
  await page.locator('#personal-schedule').screenshot({path:path.join(project,'test-data/personal-calendar-synthetic.png')});
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('.personal-day').count(),28);
  await page.setViewportSize({width:320,height:740});
  await page.locator('#switch-employee').click();await guidedTo('identity-selection');
  assert.equal(await page.locator('.personal-day').count(),0);
  await page.locator('#employee-search').fill(identityRows[2][1]);
  assert.equal(await page.locator('.employee-option').count(),2);
  await page.locator('.employee-option').nth(1).click();
  assert.match(await page.locator('#identity-review-name').textContent(),/EXAMPLE002/);
  await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  assert.deepEqual(await page.locator('.personal-day strong').allTextContents(),identityRows[3].slice(2,30));
  await identityImport(identityRows);
  assert.equal(await page.locator('#remembered-identity').isVisible(),true);
  assert.equal(await page.locator('#personal-schedule').isVisible(),false);
  await page.locator('#use-remembered').click();await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  const changedRows=identityRows.map(row=>row.slice()); changedRows[2][0]='NEW001';changedRows[3][0]='NEW002';
  await identityImport(changedRows);
  assert.equal(await page.locator('#remembered-identity').isVisible(),false);
  await page.locator('#employee-search').fill('NEW001');await page.locator('.employee-option').click();
  await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  await page.locator('#forget-identity').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem(window.NSSShiftSwapFinder.PersonalSchedule.STORAGE_KEY)),null);
  await page.setViewportSize({width:390,height:844});
  // Same-shift-only grouped simulation and state invalidation.
  const swapDates=dates(33,Date.UTC(2026,11,23));
  const swapRows=[['Synthetic schedule'],['ID','Name',...swapDates],
    ['SELF','Synthetic Self',...swapDates.map((_,i)=>i===8?'A':i===16?'E':'OF')],
    ['OTHER','Synthetic Other',...swapDates.map((_,i)=>[15,20].includes(i)?'A':'OF')],
    ['CROSS','Synthetic Cross',...swapDates.map((_,i)=>i===15?'N':'OF')],
    ['UNSAFE','Synthetic Unsafe',...swapDates.map((_,i)=>[6,7,9,10,11,15,20].includes(i)?'A':'OF')]];
  await identityImport(swapRows);
  await page.locator('#cycle-start').fill(swapDates[0]);await page.locator('#confirm-cycle').click();await guidedTo('identity-selection');
  await page.locator('#employee-search').fill('SELF');await page.locator('.employee-option').click();
  assert.equal(await page.locator('#swap-search').isVisible(),false);
  await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  assert.equal(await page.locator('#swap-search').isVisible(),true);
  assert.equal(await page.locator('#exchange-picker').isVisible(),false);
  assert.equal(await page.locator('#search-swaps').isDisabled(),true);
  await page.locator(`.want-day[data-date="${swapDates[8]}"]`).click();await guidedTo('swap-search');
  assert.equal(await page.locator('#exchange-picker').isVisible(),true);
  assert.equal(await page.locator('#exchange-dates input').count(),26);
  for(const i of [15,20])await page.locator(`#exchange-dates input[value="${swapDates[i]}"]`).check();
  await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');
  assert.equal(await page.locator('.swap-group').count(),2);assert.equal(await page.locator('.swap-candidate').count(),2);
  assert.equal(await page.locator('#swap-results h4').allTextContents().then(a=>a.every(t=>t.includes('Synthetic Other'))),true);
  assert.equal(await page.locator('.swap-warnings').count(),0);
  assert.equal(await page.locator('.swap-changes small').count(),0);
  assert.doesNotMatch(await page.locator('.swap-candidate').allTextContents().then(a=>a.join(' ')),/受影響區段|風險|連續上班/);
  assert.doesNotMatch(await page.locator('#swap-results').textContent(),/連續上班限制|未符合/);
  await page.setViewportSize({width:320,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // v0.6: isolated, accessible, read-only candidate calendars at 320px.
  async function verifyCandidate(index,employeeRow,exchangeIndex) {
    const card=page.locator('.swap-candidate').nth(index),toggle=card.locator('.preview-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    const controls=await toggle.getAttribute('aria-controls');
    assert.equal(await page.locator(`#${controls}`).isVisible(),false);
    await toggle.focus();await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator(`#${controls}`).isVisible(),true);
    assert.equal(await card.locator('.candidate-preview .personal-week').count(),4);
    assert.equal(await card.locator('.candidate-preview .want-day').count(),0);
    const cells=await card.locator('.candidate-preview .personal-day').evaluateAll(els=>els.map(el=>({
      date:el.dataset.date,code:el.querySelector('strong').textContent,
      weekday:el.querySelector('.day-weekday').textContent,exchanged:el.classList.contains('exchanged-day')
    })));
    assert.equal(cells.length,28);assert.equal(cells.filter(c=>c.exchanged).length,2);
    for(let i=0;i<28;i++) {
      assert.equal(cells[i].date,swapDates[i]);
      assert.equal(cells[i].weekday,`週${['日','一','二','三','四','五','六'][new Date(`${swapDates[i]}T00:00:00Z`).getUTCDay()]}`);
      const original=employeeRow[i+2];
      const expected=i===8?`${original} → A`:i===exchangeIndex?`${original} → OF`:original;
      assert.equal(cells[i].code,expected);assert.equal(cells[i].exchanged,i===8||i===exchangeIndex);
    }
    const colors=await card.locator('.exchanged-day').evaluateAll(els=>els.map(el=>getComputedStyle(el).backgroundColor));
    assert.deepEqual(colors,['rgb(255, 241, 168)','rgb(255, 241, 168)']);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await toggle.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator(`#${controls}`).isVisible(),false);
    await toggle.click();
  }
  assert.equal(await page.locator('.preview-toggle[aria-expanded="false"]').count(),2);
  const labelsBeforePreview=await page.locator('#swap-results h4').allTextContents();
  await verifyCandidate(0,swapRows[3],15);
  assert.equal(await page.locator('.preview-toggle').nth(1).getAttribute('aria-expanded'),'false');
  await verifyCandidate(1,swapRows[3],20);
  assert.equal(await page.locator('.preview-toggle').first().getAttribute('aria-expanded'),'true');
  assert.deepEqual(await page.locator('#swap-results h4').allTextContents(),labelsBeforePreview);
  assert.equal(new Set(await page.locator('.candidate-preview').evaluateAll(els=>els.map(el=>el.id))).size,2);
  assert.equal(await page.locator('#emergency-mode').count(),0);
  assert.doesNotMatch(await page.locator('#swap-search').textContent(),/🆘|沒招|緊急模式/);
  assert.doesNotMatch(await page.locator('#swap-results').textContent(),/Synthetic Cross|跨班別交換/);
  await page.locator('#swap-results-panel').screenshot({path:path.join(project,'test-data/swap-mobile-synthetic.png')});
  await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');assert.equal(await page.locator('.swap-candidate').count(),2);
  assert.equal(await page.locator('.preview-toggle[aria-expanded="false"]').count(),2);
  await page.locator('.preview-toggle').first().click();
  await page.locator('#switch-employee').click();await guidedTo('identity-selection');
  assert.equal(await page.locator('#swap-search').isVisible(),false);assert.equal(await page.locator('.swap-candidate').count(),0);assert.equal(await page.locator('.candidate-preview').count(),0);
  await page.locator('#employee-search').fill('SELF');await page.locator('.employee-option').click();await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  await page.locator(`.want-day[data-date="${swapDates[8]}"]`).click();await guidedTo('swap-search');
  await page.locator(`#exchange-dates input[value="${swapDates[15]}"]`).check();await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');
  await page.locator('.preview-toggle').first().click();
  await page.locator('#cycle-start').fill(swapDates[1]);assert.equal(await page.locator('#swap-search').isVisible(),false);assert.equal(await page.locator('.swap-candidate').count(),0);assert.equal(await page.locator('.candidate-preview').count(),0);
  await page.locator('#confirm-cycle').click();await guidedTo('identity-selection');await page.locator('#use-remembered').click();await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
  await page.locator(`.want-day[data-date="${swapDates[8]}"]`).click();await guidedTo('swap-search');await page.locator(`#exchange-dates input[value="${swapDates[15]}"]`).check();await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');
  await page.locator('.preview-toggle').first().click();
  await choose('replacement.xlsx','application/octet-stream',spreadsheet());assert.equal(await page.locator('#swap-search').isVisible(),false);assert.equal(await page.locator('.swap-candidate').count(),0);assert.equal(await page.locator('.candidate-preview').count(),0);
  await page.setViewportSize({width:390,height:844});
  // v0.4.1: compact warnings and stable order for actual six-day/multiple risks.
  const riskRows=[['Synthetic schedule'],['ID','Name',...swapDates],
    ['SELF','Synthetic Self',...swapDates.map((_,i)=>[8,13,14,16,17,18].includes(i)?'A':'OF')],
    ['FRAGMENT','Synthetic Fragment',...swapDates.map((_,i)=>[6,15].includes(i)?'A':'OF')],
    ['CLEAN','Synthetic Clean',...swapDates.map((_,i)=>i===15?'A':'OF')],
    ['CROSS','Synthetic Cross',...swapDates.map((_,i)=>i===15?'N':i===6?'A':'OF')]];
  async function searchRiskRows(rows) {
    await identityImport(rows);
    await page.locator('#cycle-start').fill(swapDates[0]);await page.locator('#confirm-cycle').click();await guidedTo('identity-selection');
    await page.locator('#employee-search').fill('SELF');await page.locator('.employee-option').click();await page.locator('#confirm-identity').click();await guidedTo('personal-schedule');
    await page.locator(`.want-day[data-date="${swapDates[8]}"]`).click();await guidedTo('swap-search');
    await page.locator(`#exchange-dates input[value="${swapDates[15]}"]`).check();
    await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');
  }
  await searchRiskRows(riskRows);
  const sortedLabels=await page.locator('#swap-results h4').allTextContents();
  assert.match(sortedLabels[0],/Synthetic Clean/);assert.match(sortedLabels[1],/Synthetic Fragment/);assert.equal(sortedLabels.length,2);assert.doesNotMatch(sortedLabels.join(' '),/Synthetic Cross/);
  assert.match(await page.locator('.swap-candidate').first().textContent(),/⚠️ 連續上班 6 天/);
  assert.equal(await page.locator('.swap-candidate').first().locator('.swap-warnings li').count(),1);
  assert.equal(await page.locator('.swap-candidate').nth(1).locator('.swap-warnings li').count(),2);
  assert.match(await page.locator('.swap-candidate').nth(1).textContent(),/⚠️ 破碎班/);
  assert.equal(await page.locator('.swap-changes small').count(),0);
  assert.doesNotMatch(await page.locator('#swap-results').textContent(),/受影響區段|最多連續|無法計算實際休息時數/);
  await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#swap-results-panel').screenshot({path:path.join(project,'test-data/swap-risks-mobile-synthetic.png')});
  await page.locator('#search-swaps').click();await guidedTo('swap-results-panel');
  assert.deepEqual(await page.locator('#swap-results h4').allTextContents(),sortedLabels);
  const fragmentOnlyRows=riskRows.map(r=>r.slice());fragmentOnlyRows[2]=['SELF','Synthetic Self',...swapDates.map((_,i)=>i===8?'A':'OF')];
  await searchRiskRows(fragmentOnlyRows);
  assert.match(await page.locator('#swap-results h4').first().textContent(),/Synthetic Clean/);
  assert.equal(await page.locator('.swap-candidate').first().locator('.swap-warnings').count(),0);
  assert.match(await page.locator('.swap-candidate').nth(1).textContent(),/⚠️ 破碎班/);
  assert.doesNotMatch(await page.locator('.swap-candidate').nth(1).textContent(),/⚠️ 連續上班/);
  await page.setViewportSize({width:390,height:844});
  // Validation warnings cannot be bypassed by confirming a known typo.
  const unknownRows=reviewRows.map(r=>r.slice());unknownRows[2][12]='OX';
  await choose('unknown-code.pdf','application/pdf',pdf([unknownRows]));await parse();
  assert.equal(await page.locator('#date-suggestions button').count(),0);
  assert.match(await page.locator('#date-review-state').textContent(),/已自動修正/);
  assert.match(await page.locator('#result-issues').textContent(),/OX/);
  assert.doesNotMatch(await page.locator('#status').textContent(),/班表解析成功！/);
  assert.deepEqual(await progress(),['completed','current','pending','pending']);
  assert.equal(await page.locator('#issue-details').getAttribute('open'),'');
  await guidedTo('issue-details');
  assert.equal((await lastGuide()).id,'issue-details');
  assert.equal(await page.locator('#confirm-cycle').isDisabled(),true);
  const conflictingRows=reviewRows.map(r=>r.slice());conflictingRows[1][conflictingRows[1].length-2]='2026-11-11';
  await choose('conflicting-dates.pdf','application/pdf',pdf([conflictingRows]));await parse();
  assert.equal(await page.locator('#date-suggestions .date-suggestion').count(),1);
  await guidedTo('date-review');
  assert.equal((await lastGuide()).id,'date-review');
  assert.equal(await page.locator('#cycle-start').isDisabled(),true);
  await page.locator('#date-suggestions .reject-button').click();
  assert.match(await page.locator('#date-suggestions').textContent(),/保留原值/);
  await page.locator('#date-suggestions .confirm-button').click();
  assert.equal(await page.locator('#confirm-cycle').isDisabled(),true);
  assert.match(await page.locator('#result-issues').textContent(),/重複日期/);
  const unsupported=grid();unsupported[1][0]='Unsupported ID header';
  await choose('unsupported-table.pdf','application/pdf',pdf([unsupported]));await parse();
  assert.match(await page.locator('#status').textContent(),/文字擷取成功.*表格欄列辨識未通過/);
  assert.doesNotMatch(await page.locator('#status').textContent(),/文字擷取失敗/);
  await page.evaluate(()=>{window.originalModel=window.NSSShiftSwapFinder.Model;window.NSSShiftSwapFinder.Model={...window.originalModel,fromTables(){throw new TypeError('SYNTHETIC_PRIVATE_SENTINEL');}};});
  await choose('table-exception.pdf','application/pdf',pdf([grid()]));await parse();
  assert.match(await page.locator('#status').textContent(),/文字擷取成功.*表格辨識失敗/);
  assert.doesNotMatch(await page.locator('#status').textContent(),/文字擷取失敗|SYNTHETIC_PRIVATE_SENTINEL/);
  await page.evaluate(()=>{window.NSSShiftSwapFinder.Model=window.originalModel;delete window.originalModel;});
  await choose('multi.xlsx','application/octet-stream',spreadsheet(true));
  assert.equal(await page.locator('#parse-result').isVisible(),false);
  assert.equal(await page.locator('#result-summary').textContent(),'');
  assert.equal(await page.locator('#result-issues').textContent(),'');
  await parse();assert.equal(await page.locator('#sheet-choice').isVisible(),true);
  await page.locator('#sheet-select').selectOption('Synthetic B');await parse();assert.match(await page.locator('#result-state').textContent(),/基礎資料驗證通過/);
  await page.locator('#remove-file').click();assert.deepEqual(await progress(),['current','pending','pending','pending']);assert.equal(await page.locator('#parse-result').isVisible(),false);assert.equal(await page.locator('#parse-button').isDisabled(),true);
  await choose('scan.pdf','application/pdf',pdf([[]]));await parse();assert.match(await page.locator('#result-issues').textContent(),/OCR/);
  await choose('bad.pdf','application/pdf',Buffer.from('not a PDF'));await parse();assert.match(await page.locator('#status').textContent(),/PDF 無法讀取/);
  assert.deepEqual(await progress(),['completed','current','pending','pending']);
  assert.match(await page.locator('#import-progress li').nth(1).textContent(),/解析失敗/);
  // Delay file reading and select another file while the previous parse is running.
  await choose('stale.xlsx','application/octet-stream',spreadsheet());
  await page.evaluate(()=>{
    const original=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(){
      File.prototype.arrayBuffer=original;
      return new Promise(resolve=>{window.releaseRead=()=>original.call(this).then(resolve);});
    };
  });
  await page.locator('#parse-button').click();
  assert.match(await page.locator('#import-progress li').nth(1).textContent(),/解析中/);
  await choose('replacement.xlsx','application/octet-stream',spreadsheet());
  await page.evaluate(async()=>{await window.releaseRead();delete window.releaseRead;});
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#parse-result').isVisible(),false);
  assert.match(await page.locator('#status').textContent(),/尚未解析/);
  // A queued scroll must not pull the user back to the previous file's result.
  await page.evaluate(()=>{
    window.savedRAF=window.requestAnimationFrame;window.queuedGuides=[];
    window.requestAnimationFrame=callback=>{window.queuedGuides.push(callback);return window.queuedGuides.length;};
  });
  await choose('queued-guide.xlsx','application/octet-stream',spreadsheet());await parse();
  const guideCount=await page.evaluate(()=>window.scrollGuides.length);
  await choose('new-selection.xlsx','application/octet-stream',spreadsheet());
  await page.evaluate(()=>{
    window.requestAnimationFrame=window.savedRAF;delete window.savedRAF;
    for(const callback of window.queuedGuides)callback();delete window.queuedGuides;
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.scrollGuides.length),guideCount);
  assert.equal(await page.locator('#parse-result').isVisible(),false);
  assert.deepEqual(await progress(),['completed','current','pending','pending']);
  await page.emulateMedia({reducedMotion:'reduce'});
  await choose('last.xlsx','application/octet-stream',spreadsheet());await parse();
  await guidedTo('cycle-confirmation');
  assert.deepEqual(await lastGuide(),{id:'cycle-confirmation',behavior:'auto'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(project,'test-data/mobile-result.png'),fullPage:true});
  await page.setViewportSize({width:320,height:568});
  await choose('small-screen.xlsx','application/octet-stream',spreadsheet());await parse();
  await guidedTo('cycle-confirmation');
  assert.equal(await page.evaluate(()=>{const r=document.querySelector('#confirm-cycle').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1280,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(project,'test-data/desktop-result.png'),fullPage:true});
  assert.deepEqual(pageErrors,[]);
  assert.ok(requests.every(r=>r.url.startsWith(origin+'/') && r.method==='GET'),'Only same-origin GETs for code/resources are allowed');
  assert.ok(!requests.some(r=>/synthetic|\.xlsx|\.xls|\/test-data/.test(r.url)),'Schedule bytes were never requested from a server');
  console.log(`Verified ${requests.length} same-origin resource GETs; zero uploads/external requests.`);
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
