const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const project=path.resolve(__dirname,'..');
test('mobile special search controls, previews, hidden context, mode and identity resets',async()=>{
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.join(project,pathname);
  if(!file.startsWith(project+path.sep)){res.writeHead(403).end();return;}
  try {
   let bytes=fs.readFileSync(file);
   // Exercise the real controller and HTML with a synthetic model; full import has its own browser suite.
   if(pathname==='/index.html')bytes=Buffer.from(bytes.toString().replace('<script src="js/app.js" defer></script>',''));
   res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');res.end(bytes);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.evaluate(()=>{
   const ns=window.NSSShiftSwapFinder,ds=Array.from({length:28},(_,i)=>ns.ImportConfirmation.addDays('2026-12-07',i));
   const rows=[['ID','Name',...ds],['SELF','Synthetic Self',...ds.map((d,i)=>i===0?'A':'OF')],['OTHER','Synthetic Other',...ds.map((d,i)=>i===10?'E':'O')]];
   const m=ns.Model.fromTables([{source:{sheet:'Synthetic'},rows:rows.map(r=>r.map(value=>({value})))}],'excel');
   m.cycleStartDate=ds[0];m.cycleEndDate=ds[27];m.cycleConfirmed=true;ns.Validator.validate(m);
   window.testModel=m;window.testController=ns.SwapUI.createController(document,()=>{});
   document.querySelector('#personal-schedule').hidden=false;
   const day=document.createElement('button');day.className='want-day';day.dataset.date=ds[0];day.textContent='D1';document.querySelector('#personal-weeks').append(day);
   window.testController.setIdentity(m,'SELF');
  });
  assert.equal(await page.locator('#special-search').isChecked(),false);
  await page.locator('.want-day').click();
  const d2=page.locator('#exchange-dates input[value="2026-12-17"]'),d3=page.locator('#exchange-dates input[value="2026-12-18"]');
  await d2.check();await d3.check();assert.equal(await page.locator('#exchange-dates input:checked').count(),2);
  await page.locator('#special-search').check();assert.equal(await page.locator('#exchange-dates input:checked').count(),0);
  assert.equal(await page.locator('#search-swaps').isDisabled(),true);
  await page.locator('#special-shift').selectOption('E');await d3.check();await d2.check();
  assert.equal(await page.locator('#exchange-dates input:checked').count(),1);assert.equal(await d3.isChecked(),false);
  await page.locator('#search-swaps').click();assert.equal(await page.locator('.swap-candidate').count(),1);
  assert.match(await page.locator('#swap-results-note').textContent(),/人工確認/);
  assert.doesNotMatch(await page.locator('#swap-results').textContent(),/邊界參考不足/);
  await page.locator('.preview-toggle').click();assert.equal(await page.locator('.candidate-preview').isVisible(),true);
  assert.doesNotMatch(await page.locator('.candidate-preview').textContent(),/無法顯示/);
  assert.equal(await page.evaluate(()=>window.testModel.employees[1].shifts['2026-12-07']),'O');
  await page.locator('#special-shift').selectOption('N');assert.equal(await page.locator('#swap-results-panel').isVisible(),false);
  await page.locator('#search-swaps').click();assert.equal(await page.locator('.swap-candidate').count(),0);
  assert.doesNotMatch(await page.locator('#swap-results').textContent(),/邊界參考不足/);
  await page.locator('#special-search').uncheck();assert.equal(await page.locator('#exchange-dates input:checked').count(),0);
  await d2.check();await page.locator('#search-swaps').click();assert.equal(await page.locator('.swap-candidate').count(),0);
  await page.locator('#special-search').check();await page.evaluate(()=>window.testController.setIdentity(window.testModel,'SELF'));
  assert.equal(await page.locator('#special-search').isChecked(),false);assert.equal(await page.locator('#special-shift-picker').isVisible(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
