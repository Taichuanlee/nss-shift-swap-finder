// Run after building dist/pages. Only fictional in-memory schedules are imported.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {pdf, metadataGrid, grid} = require('./fixtures.cjs');
const XLSX = require('../vendor/sheetjs/xlsx.full.min.js');
const project = path.resolve(__dirname, '..');
const artifact = process.env.PAGES_ARTIFACT_DIR ? path.resolve(process.env.PAGES_ARTIFACT_DIR) : path.join(project, 'dist/pages');

test('published artifact imports PDF/XLSX/XLS under a Pages project subpath', async () => {
  assert.ok(fs.existsSync(path.join(artifact, 'index.html')), 'Build dist/pages before this test.');
  const prefix = '/nss-shift-swap-finder/';
  const requests = [], failures = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET' || !pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const relative = pathname.slice(prefix.length) || 'index.html';
    const target = path.resolve(artifact, relative);
    if (!target.startsWith(artifact + path.sep)) { res.writeHead(404).end(); return; }
    try {
      const data = fs.readFileSync(target);
      res.setHeader('Content-Type', /\.m?js$/.test(target) ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(project, 'test-data/pages-profile-'));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, viewport: {width: 320, height: 740}
    });
    browser.on('request', request => requests.push({url: request.url(), method: request.method()}));
    browser.on('response', response => { if (response.status() >= 400) failures.push(response.status()); });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', () => errors.push('page-error'));
    await page.goto(origin + prefix);
    const files = [{name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: pdf([metadataGrid(), metadataGrid()])}];
    for (const type of ['xlsx', 'xls']) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(grid()), 'Synthetic');
      files.push({name: `synthetic.${type}`, mimeType: 'application/octet-stream', buffer: Buffer.from(XLSX.write(workbook, {type: 'buffer', bookType: type}))});
    }
    for (const file of files) {
      await page.locator('#schedule-file').setInputFiles(file);
      await page.locator('#parse-button').click();
      await page.waitForFunction(() => !document.querySelector('#parse-button').disabled);
      assert.match(await page.locator('#result-state').textContent(), /基礎資料驗證通過/);
      const counts = await page.locator('#result-summary').evaluate(el => Array.from(el.querySelectorAll('dt')).map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
      assert.equal(counts.find(([title]) => title === '員工總人數')[1], '2');
      assert.ok(counts.some(([title, value]) => title.includes('日期數量') && value === '28'));
      await page.locator('#confirm-cycle').click();
      assert.equal(await page.locator('#import-progress li').last().getAttribute('data-state'), 'completed');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    // Directly verify additional PDF font/CMap resources from the same project base.
    const status = await page.evaluate(async () => Promise.all([
      'vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap', 'vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
      'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf'
    ].map(async resource => (await fetch(new URL(resource, document.baseURI))).status)));
    assert.deepEqual(status, [200, 200, 200]);
    assert.ok(requests.some(request => request.url.endsWith('/vendor/pdfjs/pdf.worker.mjs')));
    assert.ok(requests.every(request => request.method === 'GET' && request.url.startsWith(origin + prefix)));
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, {recursive: true, force: true});
  }
});
