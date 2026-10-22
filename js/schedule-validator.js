(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  function validate(model, options = {}) {
    const {issue, classify, DAY} = ns.Model;
    // Revalidation replaces validator issues; source/parser issues remain.
    model.errors = model.errors.filter(i => !i.validationIssue);
    model.warnings = model.warnings.filter(i => !i.validationIssue);
    const add = (severity, scope, code, message, source, id) => {
      issue(model, severity, scope, code, message, source, id);
      model[severity].at(-1).validationIssue = true;
    };
    const dates = model.scheduleDates;
    let datesComplete = dates.length > 0 && !model.unresolvedDateColumns.length;
    for (let i = 0; i < dates.length; i++) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dates[i]) || !Number.isFinite(Date.parse(dates[i])) || new Date(Date.parse(dates[i])).toISOString().slice(0,10) !== dates[i]) {
        datesComplete = false;
        add('errors','global','INVALID_DATE','資料模型含無效日期。');
      }
      if (i && Date.parse(dates[i]) - Date.parse(dates[i-1]) !== DAY) {
        datesComplete = false;
        add('errors','global','DATE_GAP','日期有缺漏、重複或順序異常，未補入推測日期。');
      }
    }
    // Compare repeated full-range headers; genuinely split date ranges remain supported.
    const headers = new Map();
    for (const col of model.dateColumns) {
      const key = `${col.tableIndex}:${col.headerRow}`;
      if (!headers.has(key)) headers.set(key, []);
      headers.get(key).push(col);
    }
    const groups = [...headers.values()];
    for (let i = 1; i < groups.length; i++) {
      const b = groups[i];
      for (const a of groups.slice(0, i)) {
        const overlap = a.filter(c => c.date && b.some(d => d.date === c.date)).length;
        const repeatedRange = (a[0].date === b[0].date && a.at(-1).date === b.at(-1).date) || overlap > Math.min(a.length,b.length)/2;
        if (repeatedRange && (a.length !== b.length || a.some((col, j) => col.date !== b[j]?.date))) {
          datesComplete = false;
          add('errors', 'global', 'CROSS_PAGE_DATES', '相同範圍的表頭日期不一致，請確認各頁日期及班別對應。', b[0].source);
          break;
        }
      }
    }
    const ids = new Set();
    for (const employee of model.employees) {
      if (ids.has(employee.id)) add('errors','local','DUPLICATE_ID','資料模型包含重複員工編號。',null,employee.id);
      ids.add(employee.id);
      for (const date of dates) {
        const raw = employee.shifts[date];
        const kind = classify(raw, options.extraLeaveCodes || []);
        if (kind === 'blank') add('warnings','local','BLANK_SHIFT',`${date} 缺少班別；空白不視為休假。`,employee.shiftSources?.[date],employee.id);
        if (kind === 'unknown') add('errors','local','UNKNOWN_SHIFT',`${date} 班別「${raw}」待確認；不視為休假。`,employee.shiftSources?.[date],employee.id);
      }
      const localErrors = model.errors.filter(i => i.scope === 'local' && i.employeeId === employee.id);
      const unknownDates=dates.filter(d=>classify(employee.shifts[d])==='blank');
      employee.validation = {complete: employee.identityResolved !== false && !localErrors.length && !unknownDates.length, incomplete:unknownDates.length>0, unknownDates, eligible:false};
    }
    const globalStructureValid = !!dates.length && !!model.employees.length && !model.errors.some(i => i.scope === 'global');
    const shiftsComplete = model.employees.length > 0 && model.employees.every(e => e.validation.complete);
    const cycleLengthValid = !!model.cycleStartDate && !!model.cycleEndDate &&
      /^\d{4}-\d{2}-\d{2}$/.test(model.cycleStartDate) && /^\d{4}-\d{2}-\d{2}$/.test(model.cycleEndDate) &&
      Number.isFinite(Date.parse(model.cycleStartDate)) &&
      new Date(model.cycleStartDate).toISOString().slice(0,10) === model.cycleStartDate &&
      Date.parse(model.cycleEndDate) - Date.parse(model.cycleStartDate) === 27 * DAY;
    const cycleDatesComplete = cycleLengthValid && Array.from({length:28}, (_,i) =>
      new Date(Date.parse(model.cycleStartDate) + i * DAY).toISOString().slice(0,10)).every(d => dates.includes(d));
    if (model.cycleConfirmed && (!cycleLengthValid || !cycleDatesComplete)) {
      add('errors','global','CYCLE_RANGE_INVALID','正式四週期須為連續 28 天，且每天都在已匯入的班表中。');
    }
    const readyForSearch = globalStructureValid && datesComplete &&
      !model.errors.length && model.cycleConfirmed && cycleLengthValid && cycleDatesComplete;
    for (const employee of model.employees) employee.validation.eligible = readyForSearch && employee.identityResolved !== false && !model.errors.some(e=>e.employeeId===employee.id) && dates.some(d=>['work','leave'].includes(classify(employee.shifts[d])));
    model.validation = {globalStructureValid, cycleLengthValid, cycleDatesComplete, datesComplete,
      shiftsComplete, hasBlockingIssues: !readyForSearch, readyForSearch,
      basicValidationPassed: globalStructureValid && datesComplete && !model.errors.length,
      completeEmployeeCount: model.employees.filter(e => e.validation.complete).length};
    return model;
  }
  ns.Validator = Object.freeze({validate});
})();
