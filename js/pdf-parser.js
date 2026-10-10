(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  const invalidEncoding = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/;
  // Exact, user-confirmed hospital headers; never infer from cell codes.
  const nonDailyHeaders = Object.freeze({
    '11月預定夜班': 'novemberPlannedShift',
    '12月預定夜班': 'decemberPlannedShift',
    '單位': 'qualifiedPosition',
  });
  const nonDailyKind = value => {
    const header=String(value ?? '').trim();
    return Object.hasOwn(nonDailyHeaders,header)?nonDailyHeaders[header]:null;
  };
  const stages = Object.freeze({
    'library-load': 'PDF 函式庫載入', 'file-read': '本機檔案讀取',
    'document-load': 'PDF 載入（含 Worker 初始化）', 'page-load': 'PDF 頁面載入',
    'text-extraction': 'PDF 文字擷取', 'text-encoding': 'PDF 文字編碼檢查',
    'table-recognition': 'PDF 表格辨識', 'data-validation': 'PDF 資料驗證', 'complete': 'PDF 解析完成',
  });
  function diagnostics() {
    return {stage: 'library-load', pageCount: 0, pageNumber: null, textItemCount: 0,
      nonEmptyTextItemCount: 0, invalidEncodingItemCount: 0, pages: [], errorType: null, cleanupFailed: false};
  }
  function safeType(error) {
    const allowed = ['Error', 'TypeError', 'RangeError', 'PasswordException', 'InvalidPDFException',
      'UnknownErrorException', 'UnexpectedResponseException', 'AbortException', 'FormatError'];
    return allowed.includes(error?.name) ? error.name : 'UnclassifiedError';
  }
  function diagnosticSummary(info) {
    if (!info) return '';
    const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
    const type = safeType({name: info.errorType});
    return `階段：${stages[info.stage] || '未知'}；頁數：${count(info.pageCount)}；文字項目：${count(info.textItemCount)}${info.pageNumber ? `；目前頁：${count(info.pageNumber)}` : ''}${info.errorType ? `；錯誤類型：${type}` : ''}`;
  }
  function failure(stage, code, message, info, error) {
    info.stage = stage;
    info.errorType = safeType(error);
    const result = new Error(`${message}（${diagnosticSummary(info)}）`);
    result.name = 'PdfParseError';
    result.code = code;
    result.stage = stage;
    result.diagnostics = info;
    return result; // Never retain raw message, stack or cause from the library.
  }
  let debugReport = null;
  function localDevelopment() {
    const url = new URL(document.baseURI);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  }
  function documentOptions(data) {
    return {data, isEvalSupported:false, useSystemFonts:false,
      useWorkerFetch:false, disableFontFace:true, verbosity:0, stopAtErrors:true,
      cMapUrl:new URL('vendor/pdfjs/cmaps/',document.baseURI).href, cMapPacked:true,
      standardFontDataUrl:new URL('vendor/pdfjs/standard_fonts/',document.baseURI).href};
  }
  function syntheticDiagnosticPdf() {
    // ASCII-only probe, generated without opening any user-selected document.
    const stream = 'BT /F1 12 Tf 20 50 Td (API probe) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, i) => {offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${object}\nendobj\n`;});
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Uint8Array.from(pdf, c=>c.charCodeAt(0));
  }
  function textExtractionMethod(page) {
    // XFA uses a separate path inside getTextContent; do not bypass it.
    return !page.isPureXfa && typeof window.ReadableStream === 'function' &&
      typeof window.ReadableStream.prototype[Symbol.asyncIterator] !== 'function'
      ? 'streamTextContent.getReader' : 'getTextContent';
  }
  async function readPageText(page) {
    const params = {includeMarkedContent:false};
    if (textExtractionMethod(page) === 'getTextContent') return page.getTextContent(params);
    // Public PDF.js streaming API; same chunk aggregation as getTextContent,
    // without modifying browser prototypes or the vendored library/Worker.
    const reader = page.streamTextContent(params).getReader();
    const content = {items:[], styles:Object.create(null), lang:null};
    let complete = false;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) {complete = true; return content;}
        if (!Array.isArray(value?.items)) throw new TypeError('Invalid PDF text content chunk');
        content.lang ??= value.lang;
        Object.assign(content.styles, value.styles);
        content.items.push(...value.items);
      }
    } finally {
      // Reader cleanup must not replace the primary extraction exception.
      if (!complete) {try {await reader.cancel();} catch {}}
      try {reader.releaseLock();} catch {}
    }
  }
  async function startDiagnostics() {
    if (!localDevelopment()) throw new Error('診斷模式僅限本機 HTTP 開發環境。');
    debugReport = null;
    let task, stage = 'library-load';
    const report = {probeSource:'generated-synthetic-pdf', libraryVersion:null,
      streamGetReader:typeof window.ReadableStream?.prototype.getReader === 'function',
      streamAsyncIterator:typeof window.ReadableStream?.prototype[Symbol.asyncIterator] === 'function',
      probe:null, lastFailure:null};
    try {
      const lib = await loadLibrary();
      report.libraryVersion = lib.version;
      stage = 'document-load';
      task = lib.getDocument(documentOptions(syntheticDiagnosticPdf()));
      const pdf = await task.promise;
      stage = 'page-load';
      const page = await pdf.getPage(1);
      stage = 'text-extraction';
      report.textExtractionMethod = textExtractionMethod(page);
      const content = await readPageText(page);
      report.probe = {success:true, stage, textItemCount:content.items.length};
    } catch (error) {
      // Complete exception is safe ONLY here: input is the fixed synthetic PDF.
      report.probe = {success:false, stage, name:safeType(error),
        message:String(error.message || ''), stack:String(error.stack || '')};
    } finally {
      if (task) {try {await task.destroy();} catch {report.cleanupFailed = true;}}
    }
    debugReport = report;
    return getDiagnostics();
  }
  function recordDevelopmentFailure(error, info) {
    if (!debugReport || !localDevelopment()) return;
    const probe = debugReport.probe;
    const matches = probe?.success === false && probe.stage === info.stage &&
      probe.name === safeType(error) && probe.message === error.message;
    // Never retain arbitrary document-derived messages or raw real-file stacks.
    const locations = String(error.stack || '').split('\n').flatMap(line=>{
      const match = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/(?:js\/pdf-parser\.js|vendor\/pdfjs\/pdf(?:\.worker)?\.mjs):\d+:\d+/);
      return match ? [match[0]] : [];
    });
    debugReport.lastFailure = {stage:info.stage, name:safeType(error), pageCount:info.pageCount,
      pageNumber:info.pageNumber, textItemCount:info.textItemCount, matchesSyntheticProbe:matches,
      message:matches ? probe.message : '[未經合成診斷比對的訊息已隱藏]', stackLocations:locations};
  }
  function getDiagnostics() {
    return debugReport ? JSON.parse(JSON.stringify(debugReport)) : null;
  }
  function stopDiagnostics() {debugReport = null;}
  const heightForRow = items => Math.max(4,...items.map(i=>i.height || 0));
  function positionedTables(pages) {
    const tables = [], structureIssues = [];
    for (const {pageNumber, items} of pages) {
      const usable = items.filter(i => typeof i.str === 'string' && i.str.trim());
      if (!usable.length) {
        structureIssues.push({code:'NO_PAGE_TEXT', message:'文字擷取流程完成，但未取得非空白文字；可能為掃描影像或缺少文字映射，尚不能判定原因。本階段不提供 OCR。', source:{page:pageNumber}});
        continue;
      }
      if (usable.some(i => invalidEncoding.test(i.str))) {
        structureIssues.push({code:'TEXT_ENCODING_INVALID', message:'文字擷取成功，但含替代字元或異常控制碼，無法信任文字編碼；未判定為掃描文件。', source:{page:pageNumber}});
        continue;
      }
      if (usable.some(i => !Array.isArray(i.transform) || i.transform.length < 6 || !i.transform.every(Number.isFinite) || !Number.isFinite(i.width))) {
        structureIssues.push({code:'INVALID_TEXT_GEOMETRY', message:'文字擷取成功，但座標資料無效，無法可靠辨識表格。', source:{page:pageNumber}});
        continue;
      }
      // PDF text extraction order is ignored. Group by baseline, then by X.
      const lines = [];
      for (const item of [...usable].sort((a,b)=>b.transform[5]-a.transform[5] || a.transform[4]-b.transform[4])) {
        const y = item.transform[5];
        let line = lines.find(l=>Math.abs(l.y-y) <= 2);
        if (!line) {line={y,items:[]};lines.push(line);}
        line.items.push(item);
      }
      let anchors = null, table = null;
      const titles = [];
      const consumed = new Set();
      let previousBodyY = null;
      for (const line of lines) {
        if (consumed.has(line)) continue;
        const sorted = line.items.sort((a,b)=>a.transform[4]-b.transform[4]);
        let headerCells = sorted.map(i=>({value:i.str,source:{page:pageNumber,x:i.transform[4],y:line.y}}));
        let header = ns.Model.headerInfo(headerCells);
        if (header) {
          const dateItems = header.dateIndices.map(i=>sorted[i]);
          const gaps = dateItems.slice(1).map((i,n)=>i.transform[4]-dateItems[n].transform[4]).sort((a,b)=>a-b);
          const pitch = gaps[Math.floor(gaps.length/2)];
          if (gaps.some(g=>g < pitch*0.65 || g > pitch*1.35)) structureIssues.push({code:'IRREGULAR_DATE_COLUMNS',message:'日期表頭間距異常，無法確認每日欄位對應。',source:{page:pageNumber,y:line.y}});
          const height = Math.max(...sorted.map(i=>i.height || 0), 4);
          const band = lines.filter(l=>Math.abs(l.y-line.y)<=height*1.2);
          const groups = [];
          // Join fragments in the same header column, including vertically wrapped dates.
          for (const item of band.flatMap(l=>l.items).sort((a,b)=>a.transform[4]-b.transform[4])) {
            const center=item.transform[4]+item.width/2;
            let group=groups.find(g=>Math.abs(g.center-center)<Math.min(9,pitch*0.4));
            if(!group){group={center,items:[]};groups.push(group);}
            group.items.push(item);
          }
          const merged = groups.sort((a,b)=>a.center-b.center).map(g=>{
            const parts=g.items.sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4]);
            const value=parts.filter(i=>!/^[(（][一二三四五六日天][)）]$/.test(i.str.trim())).map(i=>i.str.trim()).join('');
            const left=Math.min(...parts.map(i=>i.transform[4])),right=Math.max(...parts.map(i=>i.transform[4]+i.width));
            return {str:value,width:right-left,height,transform:[1,0,0,1,left,line.y]};
          });
          const mergedCells=merged.map(i=>({value:i.str,source:{page:pageNumber,x:i.transform[4],y:line.y}}));
          const mergedHeader=ns.Model.headerInfo(mergedCells);
          if(mergedHeader) {
            headerCells=mergedCells;header=mergedHeader;
            sorted.splice(0,sorted.length,...merged);
            band.forEach(l=>consumed.add(l));
          }
          anchors = sorted.map(i=>({x:i.transform[4]+(i.width || 0)/2, left:i.transform[4], right:i.transform[4]+(i.width || 0)}));
          if (anchors.some((a,i)=>i && a.x-anchors[i-1].x < 8)) {
            structureIssues.push({code:'OVERLAPPING_HEADER',message:'日期／身分表頭位置重疊，無法可靠分欄。',source:{page:pageNumber,y:line.y}});
          }
          table = {source:{page:pageNumber}, title:titles.filter(t=>t.y>line.y+height*1.2).map(t=>t.text).join(' '),rows:[headerCells]};
          // Titles remain rows so shared date context can resolve partial dates.
          table.rows.unshift([{value:table.title,source:{page:pageNumber}}]);
          tables.push(table);
          continue;
        }
        if (!anchors) {titles.push({y:line.y,text:sorted.map(i=>i.str).join(' ')});continue;}
        const row = anchors.map(a=>({value:'',source:{page:pageNumber,x:a.x,y:line.y}}));
        let misaligned = false;
        const collisionColumns = [];
        const identity=ns.Model.headerInfo(table.rows[1]);
        for (const item of sorted) {
          const x = item.transform[4], right = x+(item.width || 0), center=(x+right)/2;
          let index = 0;
          for (let i=1;i<anchors.length;i++) if(Math.abs(center-anchors[i].x)<Math.abs(center-anchors[index].x)) index=i;
          const a=anchors[index];
          const leftBoundary=index ? (anchors[index-1].x+a.x)/2 : a.x-Math.max(30,(anchors[1]?.x-a.x || 30)/2);
          const rightBoundary=index<anchors.length-1 ? (a.x+anchors[index+1].x)/2 : a.x+Math.max(30,(a.x-anchors[index-1]?.x || 30)/2);
          // Text crossing column boundaries is unsafe, even if its center can be assigned.
          if (x < leftBoundary-2 || right > rightBoundary+2) misaligned=true;
          if (identity?.dateIndices.includes(index) && row[index].value && ns.Model.classify(row[index].value)!=='unknown' && ns.Model.classify(item.str)!=='unknown') collisionColumns.push(index);
          row[index].value += (row[index].value ? ' ' : '') + item.str;
          row[index].source = {page:pageNumber,x,y:line.y};
        }
        if(collisionColumns.length && identity.dateIndices.some(index=>!row[index]?.value)) misaligned=true;
        // Isolated text well below employee rows is outside the table (e.g. page footer).
        const hasIdentity=identity&&row[identity.name]?.value&&row[identity.id]?.value;
        if(!hasIdentity&&previousBodyY!==null&&previousBodyY-line.y>heightForRow(sorted)*3&&sorted.every(i=>ns.Model.classify(i.str)==='unknown')) continue;
        if(hasIdentity)previousBodyY=line.y;
        if (misaligned) structureIssues.push({code:'COLUMN_ALIGNMENT',message:'文字跨越欄界或偏離表頭位置，日期與班別可能錯位；未判定為可靠班表。',source:{page:pageNumber,y:line.y}});
        table.rows.push(row);
      }
      if (!table) structureIssues.push({code:'NO_POSITIONED_HEADER',message:'無法依座標辨識姓名、員工編號與日期欄；不支援此頁表格結構。',source:{page:pageNumber}});
    }
    const nonDailyColumns = tables.flatMap(table=>{
      const header=ns.Model.headerInfo(table.rows[1]);
      if(!header)return [];
      return table.rows[1].flatMap((cell,index)=>{
        const kind=nonDailyKind(cell.value);
        if(!kind)return [];
        return [{kind,rawHeader:cell.value,source:cell.source,
          values:table.rows.slice(2).filter(r=>r[header.id]?.value&&r[header.name]?.value)
            .map(r=>({employeeId:r[header.id].value,rawValue:r[index]?.value||'',source:r[index]?.source}))}];
      });
    });
    // Adapt only the shared adapter's header classification. Original tables and
    // non-daily values stay intact in memory and never enter employee.shifts.
    const dailyTables=tables.map(table=>({...table,rows:table.rows.map((row,index)=>
      index===1?row.map(cell=>nonDailyKind(cell.value)?{...cell,value:'備註'}:cell):row)}));
    const model = ns.Model.fromTables(dailyTables,'pdf');
    for (const error of structureIssues) ns.Model.issue(model,'errors','global',error.code,error.message,error.source);
    // Recognition describes geometry and identity mapping; date/code validation
    // remains independent and retains all existing search restrictions.
    model.pdfTableRecognized = tables.length === pages.length && tables.length > 0 &&
      structureIssues.length === 0 && model.employees.length > 0 && model.scheduleDates.length > 0 &&
      !model.errors.some(e => e.code === 'UNIDENTIFIED_ROW');
    model.pdfNonDailyColumns = nonDailyColumns;
    model.pdfHeaderMetadata = nonDailyColumns.map(({rawHeader,source})=>({rawHeader,source}));
    // Preserve every unmapped column and its per-employee values in memory.
    model.pdfUnresolvedColumns = tables.flatMap(table=>{
      const header=ns.Model.headerInfo(table.rows[1]);
      if(!header)return [];
      return table.rows[1].flatMap((cell,index)=>{
        if(index===header.name||index===header.id||header.dateIndices.includes(index)||cell.value==='備註'||nonDailyKind(cell.value))return [];
        return [{rawHeader:cell.value,source:cell.source,values:table.rows.slice(2).filter(r=>r[header.id]?.value&&r[header.name]?.value).map(r=>({employeeId:r[header.id].value,rawShift:r[index]?.value||'',source:r[index]?.source}))}];
      });
    });
    return ns.Validator.validate(model);
  }
  let library;
  async function loadLibrary() {
    if (location.protocol === 'file:') throw new Error('PDF 解析需要本機 HTTP 模式；請依 README 啟動本機伺服器後開啟網頁。');
    library ||= import('../vendor/pdfjs/pdf.mjs').then(lib=>{
      lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.mjs', document.baseURI).href;
      return lib;
    }).catch(()=>{library=null;throw new Error('PDF 函式庫未載入，請確認本機模組與 Worker 資源。');});
    return library;
  }
  // Separate orchestration enables synthetic stage-failure regression tests.
  async function parseWithLibrary(file, lib, info = diagnostics()) {
    if (debugReport) debugReport.lastFailure = null;
    let task;
    try {
      info.stage = 'file-read';
      const data = new Uint8Array(await file.arrayBuffer());
      info.stage = 'document-load';
      task = lib.getDocument(documentOptions(data));
      const pdf = await task.promise;
      info.pageCount = pdf.numPages;
      if (pdf.numPages > 100) throw failure('document-load', 'PAGE_LIMIT', 'PDF 超過 100 頁，目前無法安全處理。', info);
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        info.pageNumber = pageNumber;
        info.stage = 'page-load';
        const page = await pdf.getPage(pageNumber);
        info.stage = 'text-extraction';
        info.textExtractionMethod = textExtractionMethod(page);
        const content = await readPageText(page);
        if (!Array.isArray(content?.items)) throw new TypeError();
        const textItems = content.items.filter(i => typeof i.str === 'string');
        const stats = {pageNumber, textItemCount:textItems.length,
          nonEmptyTextItemCount:textItems.filter(i=>i.str.trim()).length,
          invalidEncodingItemCount:textItems.filter(i=>invalidEncoding.test(i.str)).length};
        info.pages.push(stats);
        info.textItemCount += stats.textItemCount;
        info.nonEmptyTextItemCount += stats.nonEmptyTextItemCount;
        info.invalidEncodingItemCount += stats.invalidEncodingItemCount;
        pages.push({pageNumber, items:content.items});
        // Cleanup cannot change a successful extraction into a misleading failure.
        try { page.cleanup(); } catch { info.cleanupFailed = true; }
      }
      info.pageNumber = null;
      info.stage = 'table-recognition';
      const model = positionedTables(pages);
      if (info.invalidEncodingItemCount) info.stage = 'text-encoding';
      else if (!info.nonEmptyTextItemCount) info.stage = 'text-extraction';
      else if (model.pdfTableRecognized) info.stage = model.validation.basicValidationPassed ? 'complete' : 'data-validation';
      model.pdfDiagnostics = info;
      return model;
    } catch (error) {
      if (error.name === 'PdfParseError') throw error;
      recordDevelopmentFailure(error, info);
      const messages = {
        'file-read': ['FILE_READ_FAILED', '本機 PDF 檔案讀取失敗。'],
        'document-load': ['DOCUMENT_LOAD_FAILED', 'PDF 載入失敗；請確認文件、Worker 與本機資源，尚未開始文字擷取。'],
        'page-load': ['PAGE_LOAD_FAILED', 'PDF 頁面載入失敗；該頁尚未開始文字擷取。'],
        'text-extraction': ['TEXT_EXTRACTION_FAILED', 'PDF 已載入，但頁面文字擷取失敗；可能涉及字型或文字映射，原因尚待確認。未使用 OCR 或雲端解析。'],
        'table-recognition': ['TABLE_RECOGNITION_FAILED', 'PDF 文字擷取成功，但表格辨識失敗；請確認表頭與欄列結構。'],
      };
      let [code, message] = messages[info.stage] || ['PDF_PROCESSING_FAILED', 'PDF 處理失敗。'];
      if (info.stage === 'document-load' && error.name === 'PasswordException') {
        code = 'PASSWORD_REQUIRED'; message = 'PDF 已加密或需要密碼；請使用未加密的本機副本。';
      } else if (info.stage === 'document-load' && error.name === 'InvalidPDFException') {
        code = 'INVALID_PDF'; message = 'PDF 無法讀取，檔案可能損毀或格式不正確。';
      }
      throw failure(info.stage, code, message, info, error);
    } finally {
      if (task) {
        try { await task.destroy(); } catch { info.cleanupFailed = true; }
      }
    }
  }
  async function parse(file) {
    const info = diagnostics();
    let lib;
    try { lib = await loadLibrary(); }
    catch (error) {
      const message = location.protocol === 'file:'
        ? 'PDF 解析需要本機 HTTP 模式；請依 README 啟動本機伺服器。'
        : 'PDF 函式庫載入失敗，請確認本機模組與資源。';
      throw failure('library-load', 'LIBRARY_LOAD_FAILED', message, info, error);
    }
    return parseWithLibrary(file, lib, info);
  }
  ns.PdfParser = Object.freeze({parse, positionedTables, parseWithLibrary, diagnosticSummary,
    startDiagnostics, getDiagnostics, stopDiagnostics});
})();
