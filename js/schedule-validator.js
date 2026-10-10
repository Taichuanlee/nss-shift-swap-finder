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
    const ids = new Set();
    for (const employee of model.employees) {
      if (ids.has(employee.id)) add('errors','local','DUPLICATE_ID','資料模型包含重複員工編號。',null,employee.id);
      ids.add(employee.id);
      for (const date of dates) {
        const raw = employee.shifts[date];
        const kind = classify(raw, options.extraLeaveCodes || []);
        if (kind === 'blank') add('errors','local','BLANK_SHIFT',`${date} 缺少班別；空白不視為休假。`,employee.shiftSources?.[date],employee.id);
        if (kind === 'unknown') add('errors','local','UNKNOWN_SHIFT',`${date} 班別「${raw}」待確認；不視為休假。`,employee.shiftSources?.[date],employee.id);
      }
      const localErrors = model.errors.filter(i => i.scope === 'local' && i.employeeId === employee.id);
      employee.validation = {complete: employee.identityResolved !== false && !localErrors.length, eligible: false};
    }
    const globalStructureValid = !!dates.length && !!model.employees.length && !model.errors.some(i => i.scope === 'global');
    const shiftsComplete = model.employees.length > 0 && model.employees.every(e => e.validation.complete);
    // v0.2A-1 deliberately does not infer or confirm a formal four-week cycle.
    model.validation = {globalStructureValid, cycleLengthValid: false, datesComplete,
      shiftsComplete, hasBlockingIssues: true, readyForSearch: false,
      basicValidationPassed: globalStructureValid && datesComplete && shiftsComplete,
      completeEmployeeCount: model.employees.filter(e => e.validation.complete).length};
    return model;
  }
  ns.Validator = Object.freeze({validate});
})();
