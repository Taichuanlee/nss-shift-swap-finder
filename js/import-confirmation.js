/* Evidence-based, in-memory date corrections and explicit cycle decisions. Does not parse files or perform search. */
(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  const {DAY} = ns.Model;
  const addDays = (date, days) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
    const time = Date.parse(date);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date) return null;
    return new Date(time + days * DAY).toISOString().slice(0,10);
  };
  const resolved = suggestion => suggestion.status === 'accepted' || suggestion.status === 'automatic';
  function groupedHeaders(model) {
    const headers = new Map();
    for (const col of model.dateColumns) {
      const key = `${col.tableIndex}:${col.headerRow}`;
      if (!headers.has(key)) headers.set(key, []);
      headers.get(key).push(col);
    }
    for (const columns of headers.values()) columns.sort((a,b) => a.index-b.index);
    return headers;
  }
  function rawMatches(col, date) {
    const p = ns.Model.dateParts(col.raw), expected = ns.Model.dateParts(date);
    return p && expected && p.month === expected.month && p.day === expected.day && (!p.year || p.year === expected.year);
  }
  function crossPageConsistent(original, next) {
    const before = [...groupedHeaders(original).values()], after = [...groupedHeaders(next).values()];
    for (let i=0; i<before.length; i++) for (let j=i+1; j<before.length; j++) {
      const a = before[i], b = before[j];
      const overlap = a.filter(c => b.some(d => d.date === c.date)).length;
      // Repeated full-range pages must agree. Non-overlapping split ranges are allowed.
      if (overlap <= Math.min(a.length,b.length)/2) continue;
      if (a.length !== b.length || after[i].some((c,k) => c.index !== after[j][k].index || c.date !== after[j][k].date)) return false;
      for (let k=0; k<a.length; k++) {
        if (a[k].date !== b[k].date && !(rawMatches(a[k],after[i][k].date) && rawMatches(b[k],after[j][k].date))) return false;
      }
    }
    return true;
  }
  function rebuild(model, decisions) {
    const corrections = decisions.filter(resolved).flatMap(s => s.occurrences.map(o => ({...o,
      correctedDate:s.correctedDate, confirmedBy:s.status === 'automatic' ? 'automatic' : 'user',
      reason:s.reason, kind:'date-header'})));
    const next = ns.Model.rebuildDates(model, corrections);
    // A corrected month/day can also restore subsequent implicit year rollover.
    // Preserve those changed interpretations as audit entries, without counting
    // them as additional mistyped date titles.
    for (const col of next.dateColumns) {
      const old = model.dateColumns.find(c => c.tableIndex === col.tableIndex && c.headerRow === col.headerRow && c.index === col.index);
      if (old && old.date !== col.date && !corrections.some(c => c.tableIndex === col.tableIndex && c.headerRow === col.headerRow && c.index === col.index)) {
        corrections.push({tableIndex:col.tableIndex, headerRow:col.headerRow, index:col.index,
          originalRaw:col.raw, originalDate:old.date, correctedDate:col.date, source:col.source,
          confirmedBy:'automatic', reason:'日期標題修正後，依連續欄位重新判定跨年年份。', kind:'year-context'});
      }
    }
    for (const audit of (model.dateCorrections || []).filter(c => c.kind === 'year-context')) {
      if (!corrections.some(c => c.tableIndex === audit.tableIndex && c.headerRow === audit.headerRow && c.index === audit.index) &&
          next.dateColumns.some(c => c.tableIndex === audit.tableIndex && c.headerRow === audit.headerRow && c.index === audit.index && c.date === audit.correctedDate)) corrections.push(audit);
    }
    next.importConfirmation = {dateSuggestions:decisions};
    next.dateCorrections = corrections;
    const startDate = addDays(next.scheduleEndDate,-27);
    next.cycleCandidates = startDate ? [{startDate,endDate:next.scheduleEndDate,source:'last-28-days'}] : [];
    ns.Validator.validate(next);
    if (next.pdfDiagnostics && next.pdfTableRecognized) {
      next.pdfDiagnostics.stage = next.validation.basicValidationPassed ? 'complete' : 'data-validation';
    }
    return next;
  }
  function initialize(model, {autoCorrect = true} = {}) {
    if (model.importConfirmation) return model;
    const headers = groupedHeaders(model), suggestions = new Map();
    // Suggest only when the preceding and following date independently agree.
    // Partial month/day headers are checked against the expected calendar year,
    // rather than trusting year rollover inferred through a mistyped month.
    for (const columns of headers.values()) {
      for (let i = 1; i < columns.length - 1; i++) {
        const col = columns[i], expected = addDays(columns[i-1].date, 1);
        if (!expected || col.date === expected || !rawMatches(columns[i+1], addDays(expected,1))) continue;
        const key = `${col.index}|${col.raw}|${expected}`;
        if (!suggestions.has(key)) suggestions.set(key, {id:key, originalRaw:col.raw,
          originalDate:col.date, correctedDate:expected, status:'pending',
          reason:'依日期欄位順序，前一日加一天與後一日減一天唯一指向相同日期。', occurrences:[]});
        suggestions.get(key).occurrences.push({tableIndex:col.tableIndex, headerRow:col.headerRow,
          index:col.index, originalRaw:col.raw, originalDate:col.date, source:col.source});
      }
    }
    model.importConfirmation = {dateSuggestions:[...suggestions.values()]};
    model.dateCorrections = [];
    const startDate = addDays(model.scheduleEndDate, -27);
    model.cycleCandidates = startDate ? [{startDate, endDate:model.scheduleEndDate, source:'last-28-days'}] : [];
    if (autoCorrect && model.sourceType === 'pdf' && suggestions.size) {
      const decisions = model.importConfirmation.dateSuggestions.map(s => ({...s,status:'automatic'}));
      const candidate = rebuild(model,decisions);
      let blockedReason = '';
      if (!model.pdfTableRecognized) blockedReason = '欄位位置尚未可靠辨識。';
      else if (!crossPageConsistent(model,candidate)) blockedReason = '各頁同一位置的日期不一致。';
      else if (!candidate.validation.globalStructureValid || !candidate.validation.datesComplete ||
          candidate.errors.some(e => ['SHIFT_CONFLICT','IDENTITY_CONFLICT','MISSING_IDENTITY','DUPLICATE_ID'].includes(e.code))) {
        blockedReason = '修正後仍有日期或資料衝突。';
      } else if (!ns.Model.dateCellsPreserved(candidate)) blockedReason = '無法確認班別與原始欄位完全對應。';
      if (!blockedReason) return candidate;
      // All-or-nothing: never leave a partly auto-corrected source on failure.
      for (const s of model.importConfirmation.dateSuggestions) s.manualReason = blockedReason;
    }
    return model;
  }
  function decideDate(model, id, accept) {
    model = initialize(model);
    const suggestion = model.importConfirmation.dateSuggestions.find(s => s.id === id);
    if (!suggestion || resolved(suggestion)) return model;
    if (!accept) {
      suggestion.status = 'rejected';
      model.cycleConfirmed = false;
      return ns.Validator.validate(model);
    }
    const decisions = model.importConfirmation.dateSuggestions.map(s => s.id === id ? {...s, status:'accepted'} : s);
    const next = rebuild(model,decisions);
    return next;
  }
  function setCycleStart(model, startDate) {
    model = initialize(model);
    model.cycleStartDate = addDays(startDate, 0);
    model.cycleEndDate = addDays(startDate, 27);
    model.cycleSource = 'user';
    model.cycleConfirmed = false;
    return ns.Validator.validate(model);
  }
  function confirmCycle(model) {
    ns.Validator.validate(model);
    const unresolved = model.importConfirmation?.dateSuggestions.some(s => !resolved(s));
    if (unresolved || !model.validation.basicValidationPassed || !model.validation.cycleLengthValid ||
        !model.validation.cycleDatesComplete || model.errors.length) return false;
    model.cycleConfirmed = true;
    ns.Validator.validate(model);
    return model.validation.readyForSearch;
  }
  ns.ImportConfirmation = Object.freeze({initialize, decideDate, setCycleStart, confirmCycle, addDays, resolved});
})();
