/* Versioned, memory-only publication adapter. No network or persistent storage. */
(() => {
  'use strict';
  const ns = window.NSSShiftSwapFinder;
  const FORMAT = 'nss-shift-swap-finder.schedule';
  const VERSION = 1;
  const fail = () => { throw new Error('班表發布資料格式不支援、資料不完整或驗證未通過。'); };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function keys(value, expected) {
    if (!record(value) || Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value,k))) fail();
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || ns.ImportConfirmation.addDays(value,0) !== value) fail();
  }
  function identity(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail();
  }
  function load(publication) {
    // Only this explicit schema crosses the boundary; never trust validation flags.
    keys(publication,['format','schemaVersion','publishedAt','cycle','dates','employees']);
    if (publication.format !== FORMAT || publication.schemaVersion !== VERSION ||
        typeof publication.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(publication.publishedAt) ||
        !Number.isFinite(Date.parse(publication.publishedAt)) || new Date(publication.publishedAt).toISOString() !== publication.publishedAt) fail();
    keys(publication.cycle,['startDate','endDate']);
    date(publication.cycle.startDate); date(publication.cycle.endDate);
    if (!Array.isArray(publication.dates) || !publication.dates.length || !Array.isArray(publication.employees) || !publication.employees.length) fail();
    publication.dates.forEach(date);
    const model = ns.Model.create('publication');
    model.scheduleDates = [...publication.dates];
    model.scheduleStartDate = model.scheduleDates[0];
    model.scheduleEndDate = model.scheduleDates.at(-1);
    const ids = new Set();
    model.employees = publication.employees.map(employee => {
      keys(employee,['id','name','shifts']);
      identity(employee.id); identity(employee.name);
      if (ids.has(employee.id) || employee.id.startsWith('unresolved-')) fail();
      ids.add(employee.id);
      keys(employee.shifts,model.scheduleDates);
      const shifts = Object.create(null);
      for (const day of model.scheduleDates) {
        const code = employee.shifts[day];
        if (typeof code !== 'string' || !['work','leave'].includes(ns.Model.classify(code))) fail();
        shifts[day] = code;
      }
      return {id:employee.id,name:employee.name,shifts,shiftSources:Object.create(null),
        shiftDetails:Object.create(null),identityResolved:true};
    });
    model.cycleStartDate = publication.cycle.startDate;
    model.cycleEndDate = publication.cycle.endDate;
    model.cycleSource = 'publication';
    model.cycleConfirmed = true;
    model.importConfirmation = {dateSuggestions:[]};
    model.dateCorrections = [];
    ns.Validator.validate(model);
    if (!model.validation.readyForSearch) fail();
    model.publication = {schemaVersion:VERSION,publishedAt:publication.publishedAt};
    return model;
  }
  function create(model) {
    // Revalidate a detached copy so export never changes the active schedule.
    const copy = JSON.parse(JSON.stringify(model));
    if (copy.importConfirmation?.dateSuggestions.some(s => !ns.ImportConfirmation.resolved(s))) fail();
    ns.Validator.validate(copy);
    if (!copy.validation.readyForSearch) fail();
    const publication = {format:FORMAT,schemaVersion:VERSION,publishedAt:new Date().toISOString(),
      cycle:{startDate:copy.cycleStartDate,endDate:copy.cycleEndDate},dates:[...copy.scheduleDates],
      employees:copy.employees.map(e => ({id:e.id,name:e.name,
        shifts:Object.fromEntries(copy.scheduleDates.map(day => [day,e.shifts[day]]))}))};
    load(publication);
    return publication;
  }
  function serialize(model) { return JSON.stringify(create(model),null,2); }
  function deserialize(text) {
    if (typeof text !== 'string' || text.length > 25 * 1024 * 1024) fail();
    let publication;
    try { publication = JSON.parse(text); } catch { fail(); }
    return load(publication);
  }
  ns.SchedulePublication = Object.freeze({FORMAT,VERSION,create,load,serialize,deserialize});
})();
