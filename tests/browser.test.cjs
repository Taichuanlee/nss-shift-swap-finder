// Run with Playwright available on NODE_PATH. Generates only fictional in-memory files.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {pdf,grid,dates} = require('./fixtures.cjs');
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
  async function choose(name,mimeType,buffer) {await page.locator('#schedule-file').setInputFiles({name,mimeType,buffer});}
  async function parse() {await page.locator('#parse-button').click();await page.waitForFunction(()=>!document.querySelector('#parse-button').disabled);}
  for (const [name,mimeType,buffer] of [
   ['synthetic.pdf','application/pdf',pdf([grid()])],
   ['synthetic-multipage.pdf','application/pdf',pdf([grid(),grid()])],
   ['synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',spreadsheet()],
   ['synthetic.xls','application/vnd.ms-excel',spreadsheet(false,'xls')],
  ]) {
   await choose(name,mimeType,buffer);await parse();
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
        blocked:!fallback.validation.readyForSearch,errors:fallback.errors.map(e=>e.code)};
    } finally {Object.defineProperty(ReadableStream.prototype,Symbol.asyncIterator,descriptor);}
  },Array.from(pdf([(()=>{const g=grid(dates(33));g[1][4]='1/16';g[2][2]='OX';return g;})(),grid(dates(33))])));
  assert.equal(missingIterator.report.streamGetReader,true);
  assert.equal(missingIterator.report.streamAsyncIterator,false);
  assert.equal(missingIterator.report.probe.success,true);
  assert.equal(missingIterator.report.textExtractionMethod,'streamTextContent.getReader');
  assert.equal(missingIterator.report.lastFailure,null);
  assert.equal(missingIterator.method,'streamTextContent.getReader');
  assert.equal(missingIterator.identical,true);
  assert.equal(missingIterator.blocked,true);
  assert.ok(missingIterator.errors.includes('DATE_SEQUENCE'));
  assert.ok(missingIterator.errors.includes('UNKNOWN_SHIFT'));
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
  await page.locator('#remove-file').click();assert.equal(await page.locator('#parse-result').isVisible(),false);assert.equal(await page.locator('#parse-button').isDisabled(),true);
  await choose('scan.pdf','application/pdf',pdf([[]]));await parse();assert.match(await page.locator('#result-issues').textContent(),/OCR/);
  await choose('bad.pdf','application/pdf',Buffer.from('not a PDF'));await parse();assert.match(await page.locator('#status').textContent(),/PDF 無法讀取/);
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
  await choose('replacement.xlsx','application/octet-stream',spreadsheet());
  await page.evaluate(async()=>{await window.releaseRead();delete window.releaseRead;});
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#parse-result').isVisible(),false);
  assert.match(await page.locator('#status').textContent(),/尚未解析/);
  await choose('last.xlsx','application/octet-stream',spreadsheet());await parse();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(project,'test-data/mobile-result.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(project,'test-data/desktop-result.png'),fullPage:true});
  assert.deepEqual(pageErrors,[]);
  assert.ok(requests.every(r=>r.url.startsWith(origin+'/') && r.method==='GET'),'Only same-origin GETs for code/resources are allowed');
  assert.ok(!requests.some(r=>/synthetic|\.xlsx|\.xls|\/test-data/.test(r.url)),'Schedule bytes were never requested from a server');
  console.log(`Verified ${requests.length} same-origin resource GETs; zero uploads/external requests.`);
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
