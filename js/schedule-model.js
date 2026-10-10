/* Shared rules and table adapter. No format-specific or network operations. */
(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder = window.NSSShiftSwapFinder || {};
  const DAY = 86400000;
  const work = new Set(['A', 'E', 'N']);
  const leave = new Set(['O', 'OF', 'ON', 'OZ', 'O1', 'O6', 'O8']);
  const text = value => String(value ?? '').trim();
  function iso(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function dateParts(value) {
    const s = text(value);
    let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s*[（(][一二三四五六日天][)）])?$/);
    if (m) return {year: +m[1], month: +m[2], day: +m[3]};
    m = s.match(/^(\d{1,2})[/月-](\d{1,2})日?(?:\s*[（(][一二三四五六日天][)）])?$/);
    return m ? {year: null, month: +m[1], day: +m[2]} : null;
  }
  function classify(raw, extraLeaveCodes = []) {
    const code = text(raw); // Preserve original code; never collapse OF into O.
    if (!code) return 'blank';
    if (work.has(code)) return 'work';
    if (leave.has(code) || extraLeaveCodes.includes(code)) return 'leave';
    return 'unknown';
  }
  function normalizeShift(raw) {
    const value = text(raw);
    if (/^O\s+N$/.test(value)) return 'ON';
    // Consume the whole string as confirmed tokens, with optional whitespace.
    // A partial match must never discard an unknown character or annotation.
    const parts = [], tokens = /\s+|-8|休|[AEN]/gy;
    let cursor = 0;
    while (cursor < value.length) {
      tokens.lastIndex = cursor;
      const match = tokens.exec(value);
      if (!match) return value;
      cursor = tokens.lastIndex;
      if (!/^\s+$/.test(match[0])) parts.push(match[0]);
    }
    // Only one confirmed work code plus at most one of each annotation.
    // Unknown text and repeated annotations stay unknown.
    const codes = parts.filter(p=>p !== '休' && p !== '-8');
    if (codes.length === 1 && work.has(codes[0]) &&
        parts.filter(p=>p === '休').length <= 1 && parts.filter(p=>p === '-8').length <= 1) {
      return codes[0];
    }
    return value;
  }
  function create(sourceType) {
    return {sourceType, scheduleStartDate: null, scheduleEndDate: null, scheduleDates: [],
      cycleStartDate: null, cycleEndDate: null, cycleSource: null, cycleConfirmed: false,
      cycleCandidates: [], employees: [], unresolvedDateColumns: [], warnings: [], errors: [],
      sourceInfo: [], dateColumns: [],
      validation: {globalStructureValid: false, cycleLengthValid: false, datesComplete: false,
        shiftsComplete: false, hasBlockingIssues: true, readyForSearch: false}};
  }
  function issue(model, severity, scope, code, message, source = null, employeeId = null) {
    model[severity].push({scope, code, message, source, employeeId});
  }
  const nameHeader = /^(姓名|員工姓名|護理師|護理師姓名|name)$/i;
  const idHeader = /^(編號|員工編號|員編|工號|職工編號|id|employee\s*id)$/i;
  function headerInfo(row) {
    const name = row.findIndex(c => nameHeader.test(text(c.value)));
    const id = row.findIndex(c => idHeader.test(text(c.value)));
    const dateIndices = row.map((c, i) => dateParts(c.value) ? i : -1).filter(i => i >= 0);
    return name >= 0 && id >= 0 && dateIndices.length >= 2 ? {name, id, dateIndices} : null;
  }
  function fromTables(tables, sourceType) {
    const model = create(sourceType);
    const employeeMap = new Map();
    let headerCount = 0;
    for (const table of tables) {
      model.sourceInfo.push({source: table.source, title: table.title || ''});
      let header = null;
      let columns = [];
      let initialHeaderRow = null;
      for (let r = 0; r < table.rows.length; r++) {
        const row = table.rows[r];
        const h = headerInfo(row);
        if (h) {
          headerCount++;
          header = h;
          if (initialHeaderRow === null) initialHeaderRow = r;
          const contextText = [...table.rows.slice(0, initialHeaderRow), row].flat().map(c => text(c.value)).join(' ');
          const years = [...new Set((contextText.match(/\b(?:19|20|21)\d{2}\b/g) || []).map(Number))];
          const first = dateParts(row[h.dateIndices[0]].value);
          let year = first.year || (years.length === 1 ? years[0] : null);
          let previous = null;
          columns = h.dateIndices.map(index => {
            const cell = row[index];
            const p = dateParts(cell.value);
            if (p.year) year = p.year;
            else if (previous?.month === 12 && p.month === 1 && year) year++;
            const date = year ? iso(year, p.month, p.day) : null;
            previous = p;
            const column = {index, date, raw: text(cell.value), source: cell.source};
            model.dateColumns.push(column);
            if (!date) {
              model.unresolvedDateColumns.push(column);
              issue(model, 'errors', 'global', 'UNRESOLVED_DATE', '日期無效或缺少可唯一辨識的年份，請確認原始表頭。', cell.source);
            }
            return column;
          });
          for (let index = h.dateIndices[0]; index <= h.dateIndices.at(-1); index++) {
            if (!h.dateIndices.includes(index)) {
              const column = {index, date: null, raw: text(row[index]?.value), source: row[index]?.source};
              model.unresolvedDateColumns.push(column);
              issue(model, 'errors', 'global', 'DATE_COLUMN_ALIGNMENT', '日期欄中含無法辨識的表頭，不能略過此欄或位移班別。', column.source);
            }
          }
          const knownMetadata = /^(備註|單位|職稱|合計|總計|note|unit|role|total)$/i;
          row.forEach((cell, index) => {
            if (index !== h.name && index !== h.id && !h.dateIndices.includes(index) && text(cell.value) && !knownMetadata.test(text(cell.value)) && (index < h.dateIndices[0] || index > h.dateIndices.at(-1))) {
              const column = {index, date: null, raw: text(cell.value), source: cell.source};
              model.unresolvedDateColumns.push(column);
              issue(model, 'errors', 'global', 'UNMAPPED_COLUMN', '表頭含無法辨識的欄位，不能確認是否為未辨識日期；未略過該問題。', cell.source);
            }
          });
          const dates = columns.map(c => c.date).filter(Boolean);
          if (new Set(dates).size !== dates.length) issue(model, 'errors', 'global', 'DUPLICATE_DATE_COLUMN', '同一表頭有重複日期，無法可靠對應班別。', table.source);
          for (let i = 1; i < columns.length; i++) {
            const a = columns[i - 1], b = columns[i];
            if (a.date && b.date && Date.parse(b.date) - Date.parse(a.date) !== DAY) {
              const expected = new Date(Date.parse(a.date) + DAY).toISOString().slice(0, 10);
              issue(model, 'errors', 'global', 'DATE_SEQUENCE', `日期順序異常：讀到 ${b.raw}，依前欄應為 ${expected}；請確認原始班表，未自動修正。`, b.source);
            }
          }
          continue;
        }
        if (!header) continue;
        if (row.every(c => !text(c.value))) continue;
        const name = text(row[header.name]?.value);
        const rawId = text(row[header.id]?.value);
        // Explicitly known total/annotation rows are not employee records.
        if (/^(合計|總計|備註|人數|total)$/i.test(name) || /^(合計|總計|備註|人數|total)$/i.test(rawId)) continue;
        if (!name && !rawId) {
          if (columns.some(c => text(row[c.index]?.value))) issue(model, 'errors', 'global', 'UNIDENTIFIED_ROW', '表頭下有無法辨識身分的資料列，欄列可能錯位。', row[0]?.source);
          continue;
        }
        const id = rawId || `unresolved-${model.employees.length + 1}`;
        let employee = employeeMap.get(id);
        if (!employee) {
          employee = {id, name, shifts: Object.create(null), shiftSources: Object.create(null),
            shiftDetails: Object.create(null), identityResolved: !!rawId && !!name, validation: {complete: false, eligible: false}};
          employeeMap.set(id, employee);
          model.employees.push(employee);
        } else {
          issue(model, 'warnings', 'local', 'DUPLICATE_EMPLOYEE_ID', '員工編號再次出現，已依編號合併並檢查班別衝突。', row[header.id]?.source, id);
          if (employee.name !== name) {
            employee.identityResolved = false;
            issue(model, 'errors', 'local', 'IDENTITY_CONFLICT', '相同員工編號對應不同姓名，需確認身分。', row[header.name]?.source, id);
          }
        }
        if (!rawId || !name) issue(model, 'errors', 'local', 'MISSING_IDENTITY', '員工姓名或編號缺漏；未以其他員工身分代替。', row[header.name]?.source, id);
        for (const column of columns) {
          if (!column.date) continue;
          const cell = row[column.index];
          const raw = String(cell?.value ?? '');
          const normalized = normalizeShift(raw);
          const source = cell?.source || {...table.source, row: r + 1, column: column.index + 1};
          // Preserve every source cell, including repeated pages and conflicts.
          (employee.shiftDetails[column.date] ||= []).push({raw, normalized, source});
          if (Object.hasOwn(employee.shifts, column.date)) {
            if (employee.shifts[column.date] !== normalized) {
              issue(model, 'errors', 'local', 'SHIFT_CONFLICT', `同一員工在 ${column.date} 有不同班別；保留先前值並標示衝突。`, source, id);
              model.errors.at(-1).conflict = {date: column.date, previous: employee.shifts[column.date], incoming: normalized, incomingRaw:raw, previousSource: employee.shiftSources[column.date]};
            }
          } else {
            employee.shifts[column.date] = normalized;
            employee.shiftSources[column.date] = source;
          }
        }
      }
      if (!header) issue(model, 'errors', 'global', 'TABLE_NOT_RECOGNIZED', '無法辨識姓名、員工編號與至少兩個日期欄，請確認表格配置。', table.source);
    }
    if (!headerCount || !model.employees.length) issue(model, 'errors', 'global', 'NO_EMPLOYEES', '未取得可靠的員工班別資料。');
    model.scheduleDates = [...new Set(model.dateColumns.map(c => c.date).filter(Boolean))].sort();
    model.scheduleStartDate = model.scheduleDates[0] || null;
    model.scheduleEndDate = model.scheduleDates.at(-1) || null;
    return model;
  }
  ns.Model = Object.freeze({create, issue, fromTables, headerInfo, dateParts, iso, classify, normalizeShift, text, DAY,
    shiftCodes: Object.freeze({work: Object.freeze([...work]), leave: Object.freeze([...leave])})});
})();
