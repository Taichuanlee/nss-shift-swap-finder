(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  function cellValue(cell, date1904) {
    if (!cell) return '';
    if (cell.t === 'e') return '[儲存格錯誤]';
    if (cell.f) return '[公式需確認]'; // Do not evaluate formulas or external links.
    if (cell.t === 'n' && window.XLSX.SSF.is_date(cell.z || '')) {
      const p = window.XLSX.SSF.parse_date_code(cell.v, {date1904});
      return p ? ns.Model.iso(p.y, p.m, p.d) || '[無效 Excel 日期]' : '[無效 Excel 日期]';
    }
    return cell.v ?? '';
  }
  function tableFromSheet(sheet, sheetName, date1904 = false) {
    const XLSX = window.XLSX;
    if (!sheet['!ref']) return {source: {sheet: sheetName}, rows: [], title: ''};
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r > 10000 || range.e.c > 500) throw new Error('工作表範圍過大；目前支援最多 10,001 列與 501 欄。');
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const address = XLSX.utils.encode_cell({r, c});
        row.push({value: cellValue(sheet[address], date1904), source: {sheet: sheetName, row: r+1, column: c+1, cell: address}});
      }
      rows.push(row);
    }
    // Only expand identity headers, never copy a merged date or shift across cells.
    const mergedIssues = [];
    const headers = rows.map((row, index) => ({row: index + range.s.r, info: ns.Model.headerInfo(row)})).filter(h=>h.info);
    for (const merge of sheet['!merges'] || []) {
      const anchor = rows[merge.s.r - range.s.r]?.[merge.s.c];
      if (!anchor) continue;
      if (ns.Model.dateParts(anchor.value)) mergedIssues.push(anchor.source);
      if (/^(姓名|員工姓名|護理師姓名|編號|員工編號|員編|工號)$/i.test(ns.Model.text(anchor.value)) && merge.s.c === merge.e.c) {
        for (let r = merge.s.r; r <= merge.e.r; r++) rows[r-range.s.r][merge.s.c].value = anchor.value;
      }
      // Non-header merged values in date columns must never silently become repeated shifts.
      if (headers.some(h => merge.e.r > h.row && h.info.dateIndices.some(c=>c>=merge.s.c && c<=merge.e.c))) mergedIssues.push(anchor.source);
    }
    return {source: {sheet: sheetName}, rows, title: rows.slice(0,5).map(r=>r.map(c=>c.value).join(' ')).join(' '), mergedIssues};
  }
  async function parse(file, {sheetName} = {}) {
    if (!window.XLSX) throw new Error('Excel 函式庫未載入，請確認 vendor/sheetjs 本機資源。');
    let workbook;
    try { workbook = window.XLSX.read(await file.arrayBuffer(), {type:'array', cellDates:false, cellNF:true, cellFormula:true, bookVBA:false}); }
    catch { throw new Error('無法讀取 Excel；檔案可能損毀、加密或不是支援的 XLSX／XLS。'); }
    const date1904 = !!workbook.Workbook?.WBProps?.date1904;
    const tables = workbook.SheetNames.map(name => tableFromSheet(workbook.Sheets[name], name, date1904));
    const candidates = tables.filter(t => t.rows.some(r => ns.Model.headerInfo(r)));
    if (!candidates.length) throw new Error('沒有可辨識的班表工作表；需要姓名、員工編號與日期表頭，日期須含年份或可唯一辨識的年份標題。');
    if (!sheetName && candidates.length > 1) return {needsSheetSelection:true, sheetNames:candidates.map(t=>t.source.sheet)};
    const table = sheetName ? candidates.find(t => t.source.sheet === sheetName) : candidates[0];
    if (!table) throw new Error('指定工作表不是可辨識的班表。');
    const model = ns.Model.fromTables([table], 'excel');
    for (const source of table.mergedIssues) ns.Model.issue(model,'errors','global','MERGED_DATA','日期或班別跨欄合併，無法可靠對應每日班別。',source);
    return ns.Validator.validate(model);
  }
  ns.ExcelParser = Object.freeze({parse, tableFromSheet});
})();
