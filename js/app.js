/* Classic-script module keeps direct file:// opening available without a server. */
(() => {
  'use strict';

  const FileFormat = Object.freeze({
    detect(name) {
      const extension = name.split('.').pop().toLowerCase();
      return ({ pdf: 'PDF', xlsx: 'Excel', xls: 'Excel' })[extension] || null;
    },
  });

  const ns = window.NSSShiftSwapFinder;
  // Parsers share one data model and validator; swap search stays unavailable.
  const Services = Object.freeze({
    pdfParser: ns.PdfParser,
    excelParser: ns.ExcelParser,
    scheduleValidator: ns.Validator,
    importConfirmation: ns.ImportConfirmation,
    swapEngine: null,
  });

  function createImportController(root) {
    const input = root.querySelector('#schedule-file');
    const dropZone = root.querySelector('#drop-zone');
    const selected = root.querySelector('#selected-file');
    const fileName = root.querySelector('#file-name');
    const fileFormat = root.querySelector('#file-format');
    const status = root.querySelector('#status');
    const parseButton = root.querySelector('#parse-button');
    let selectedFile = null;
    let dragDepth = 0;
    let generation = 0;
    let result = null;
    let guidanceRevision = 0;
    const resultPanel = root.querySelector('#parse-result');
    const resultSummary = root.querySelector('#result-summary');
    const issues = root.querySelector('#result-issues');
    const sheetChoice = root.querySelector('#sheet-choice');
    const sheetSelect = root.querySelector('#sheet-select');
    const dateSuggestions = root.querySelector('#date-suggestions');
    const cycleStart = root.querySelector('#cycle-start');
    const cycleEnd = root.querySelector('#cycle-end');
    const cycleFields = root.querySelector('#cycle-fields');
    const confirmCycle = root.querySelector('#confirm-cycle');
    const progressSteps = Array.from(root.querySelectorAll('#import-progress li'));
    const issueDetails = root.querySelector('#issue-details');
    const personal = ns.PersonalSchedule.createController(root, guideTo);
    function setProgress(current, complete = false, currentLabel = '目前階段') {
      progressSteps.forEach((step,index) => {
        const state = complete || index < current ? 'completed' : index === current ? 'current' : 'pending';
        step.dataset.state = state;
        step.querySelector('.progress-number').textContent = state === 'completed' ? '✓' : String(index+1);
        step.querySelector('.progress-state').textContent = state === 'completed' ? '已完成' : state === 'current' ? currentLabel : '尚未完成';
        if (state === 'current') step.setAttribute('aria-current','step');
        else step.removeAttribute('aria-current');
      });
    }
    function placeStatus(target) {
      if (status.parentElement !== target) target.append(status);
    }
    function guideTo(target) {
      const revision = ++guidanceRevision, token = generation;
      // Let the result card and the button settle before scrolling. Fast Excel
      // parsing can otherwise race the browser's scroll anchoring after a click.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (token !== generation || revision !== guidanceRevision || resultPanel.hidden || target.hidden) return;
        // Focus the section, not the date input: do not open a mobile keyboard.
        target.focus({preventScroll:true});
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({behavior:reducedMotion ? 'auto' : 'smooth',block:'start'});
      }));
    }
    setProgress(0);
    function clearResult() {
      generation++;
      result = null;
      personal.setSchedule(null);
      placeStatus(root.querySelector('#import-status-slot'));
      dateSuggestions.replaceChildren();
      cycleStart.value = ''; cycleEnd.textContent = ''; cycleFields.disabled = true;
      resultPanel.hidden = true;
      resultSummary.replaceChildren();
      issues.replaceChildren();
      sheetChoice.hidden = true;
      sheetSelect.replaceChildren();
      issueDetails.open = false;
      root.querySelector('#file-state').textContent = '已選擇 · 尚未解析';
    }
    function showResult(model, {guide = false} = {}) {
      model = Services.importConfirmation.initialize(model);
      result = model;
      resultSummary.replaceChildren(); issues.replaceChildren();
      renderConfirmation(model);
      resultPanel.hidden = false;
      personal.setSchedule(model);
      const complete = model.validation.completeEmployeeCount;
      const stats = [
        ['檔案類型', model.sourceType === 'pdf' ? 'PDF' : 'Excel'],
        ['員工總人數', model.employees.length],
        ['可辨識員工人數', model.employees.filter(e => e.identityResolved).length],
        ['資料異常員工人數', model.employees.length - complete],
        ['已辨識日期數量', model.scheduleDates.length],
        ['班表顯示起訖', `${model.scheduleStartDate || '未辨識'} ～ ${model.scheduleEndDate || '未辨識'}`],
        ['自動修正日期標題', model.importConfirmation.dateSuggestions.filter(s => s.status === 'automatic').length],
        ['正式四週期', model.cycleStartDate ? `${model.cycleStartDate} ～ ${model.cycleEndDate}（${model.cycleConfirmed ? '已確認' : '尚未確認'}）` : '尚未確認'],
        ['警告數量', model.warnings.length], ['錯誤數量', model.errors.length],
      ];
      for (const [label, value] of stats) {
        const dt = root.createElement('dt'), dd = root.createElement('dd');
        dt.textContent = label; dd.textContent = String(value);
        resultSummary.append(dt, dd);
      }
      const state = model.validation.basicValidationPassed ? '基礎資料驗證通過' : model.employees.length && model.scheduleDates.length ? '部分資料解析成功／存在待確認問題' : '未取得可靠班表資料';
      root.querySelector('#result-state').textContent = `檔案已讀取 · ${state} · ${model.cycleConfirmed ? '正式四週期已確認' : '尚未確認正式四週期'}${model.validation.readyForSearch ? ' · 匯入完成' : ''}`;
      for (const item of [...model.errors, ...model.warnings]) {
        const li = root.createElement('li');
        const place = item.source?.page ? `第 ${item.source.page} 頁${item.source.y !== undefined ? `，y=${Math.round(item.source.y)}` : ''}` : item.source?.sheet ? `工作表 ${item.source.sheet} ${item.source.cell || ''}` : '';
        li.textContent = `${item.scope === 'global' ? '全域' : `個別員工 ${item.employeeId || ''}`}：${item.message}${place ? `（${place}）` : ''}`;
        issues.append(li);
      }
      const unresolvedDates = model.importConfirmation.dateSuggestions.some(s => !Services.importConfirmation.resolved(s));
      const blocked = !model.validation.basicValidationPassed || model.errors.length > 0 || unresolvedDates;
      let message = !blocked ? '基礎驗證通過，尚未確認正式四週期，不能進入換班搜尋。' : '已讀取檔案，解析或驗證有問題；請查看下方結果。';
      if (model.validation.readyForSearch) message = '匯入完成。請在下方選擇自己並確認身分。';
      else if (!blocked) message = '班表解析成功！還差最後一步，請確認正式四週期。';
      if (model.pdfDiagnostics && !model.validation.basicValidationPassed) {
        const stage = model.pdfDiagnostics.stage;
        if (stage === 'text-encoding') message = 'PDF 文字擷取成功，但文字編碼異常；請查看下方結果。';
        else if (stage === 'text-extraction') message = 'PDF 已載入，文字擷取流程完成但未取得非空白文字；原因尚待確認。';
        else if (stage === 'table-recognition') message = 'PDF 文字擷取成功，但表格欄列辨識未通過；請查看下方結果。';
        else if (stage === 'data-validation') message = 'PDF 文字擷取與表格欄列辨識完成，但資料驗證未通過；請查看下方待確認問題。';
        message += `（${Services.pdfParser.diagnosticSummary(model.pdfDiagnostics)}）`;
      }
      const statusTarget = root.querySelector(blocked ? '#import-status-slot' : '#cycle-status-slot');
      placeStatus(statusTarget);
      announce(message, blocked);
      root.querySelector('#file-state').textContent = model.validation.readyForSearch ? '匯入完成' : '已讀取 · 等待確認';
      setProgress(model.validation.readyForSearch ? 3 : blocked ? 1 : 2,model.validation.readyForSearch,blocked ? '需要處理' : '目前階段');
      if (guide) {
        if (blocked) {
          issueDetails.open = true;
          guideTo(root.querySelector(unresolvedDates ? '#date-review' : '#issue-details'));
        } else if (!model.cycleConfirmed) {
          issueDetails.open = false;
          guideTo(root.querySelector('#cycle-confirmation'));
        }
      }
    }

    function renderConfirmation(model) {
      dateSuggestions.replaceChildren();
      const suggestions = model.importConfirmation.dateSuggestions;
      const automaticCount = suggestions.filter(s => s.status === 'automatic').length;
      for (const suggestion of suggestions.filter(s => s.status !== 'automatic')) {
        const box = root.createElement('div'); box.className = 'date-suggestion';
        const message = root.createElement('p');
        const pages = [...new Set(suggestion.occurrences.map(o => o.source?.page).filter(Boolean))];
        const place = pages.length ? `第 ${pages.join('、')} 頁` : `${suggestion.occurrences.length} 個表頭位置`;
        const correctedLabel = `${Number(suggestion.correctedDate.slice(5,7))}/${Number(suggestion.correctedDate.slice(8))}`;
        message.textContent = `${suggestion.originalRaw} → ${correctedLabel}（${place}）。前後日期顯示此處可能誤植。${suggestion.manualReason || ''}`;
        box.append(message);
        if (suggestion.status === 'accepted') {
          message.textContent += '已依您的確認套用，原始日期與修正紀錄仍保留。';
        } else {
          if (suggestion.status === 'rejected') message.textContent += '您已選擇保留原值，日期問題尚未解決，不能完成匯入。';
          const actions = root.createElement('div'); actions.className = 'confirmation-actions';
          const accept = root.createElement('button'); accept.type = 'button'; accept.className = 'confirm-button';
          accept.textContent = '確認修正全部相同位置';
          accept.addEventListener('click', () => showResult(Services.importConfirmation.decideDate(result, suggestion.id, true), {guide:true}));
          actions.append(accept);
          if (suggestion.status === 'pending') {
            const reject = root.createElement('button'); reject.type = 'button'; reject.className = 'reject-button'; reject.textContent = '保留原日期';
            reject.addEventListener('click', () => showResult(Services.importConfirmation.decideDate(result, suggestion.id, false), {guide:true}));
            actions.append(reject);
          }
          box.append(actions);
        }
        dateSuggestions.append(box);
      }
      const dateErrors = model.errors.filter(i => i.scope === 'global' && /DATE|COLUMN|TABLE|HEADER|GEOMETRY|PAGE|TEXT|MERGED|UNIDENTIFIED|NO_EMPLOYEES/.test(i.code));
      root.querySelector('#date-review-state').textContent = dateErrors.length ?
        (suggestions.some(s => !Services.importConfirmation.resolved(s)) ? '日期需要您確認。請先處理以下建議。' : '無法安全推斷日期或確認欄位對應，請核對原班表及下方錯誤；不能完成匯入。') : `${automaticCount ? `已自動修正 ${automaticCount} 個日期標題。` : ''}日期檢查通過。`;
      const pending = suggestions.some(s => !Services.importConfirmation.resolved(s));
      cycleFields.disabled = pending || !model.validation.basicValidationPassed;
      root.querySelector('#display-range').textContent = `${model.sourceType === 'pdf' ? 'PDF' : 'Excel'} 已辨識顯示範圍：${model.scheduleStartDate || '未辨識'} ～ ${model.scheduleEndDate || '未辨識'}（${model.scheduleDates.length} 天）。${pending ? '日期修正前，此範圍可能有誤。' : ''}`;
      cycleStart.value = model.cycleSource === 'user' ? (model.cycleStartDate || '') : (model.cycleCandidates[0]?.startDate || '');
      cycleEnd.textContent = Services.importConfirmation.addDays(cycleStart.value,27) || '請選擇有效開始日期';
      // A displayed suggestion never sets cycleConfirmed or makes the model ready.
      const end = cycleEnd.textContent;
      const covered = Array.from({length:28}, (_,i) => Services.importConfirmation.addDays(cycleStart.value,i)).every(d => model.scheduleDates.includes(d));
      confirmCycle.disabled = cycleFields.disabled || !covered || model.cycleConfirmed;
      root.querySelector('#cycle-state').textContent = cycleFields.disabled ? '請先解決日期及班別問題，再確認正式四週期。' : model.cycleConfirmed ?
        `已確認 ${model.cycleStartDate} ～ ${model.cycleEndDate}，共 28 天。修改開始日期後需要再次確認。` : covered ?
        `建議 ${cycleStart.value} ～ ${end}，共 28 天。請核對後按下確認。` : '這個四週期超出班表或有缺漏日期，請調整開始日期。';
    }
    cycleStart.addEventListener('input', () => {
      if (!result) return;
      guidanceRevision++;
      personal.invalidate();
      const value = cycleStart.value;
      result = Services.importConfirmation.setCycleStart(result, value);
      showResult(result);
      // Preserve an empty/invalid user entry instead of resetting to the suggestion.
      if (!value) { cycleStart.value = ''; cycleEnd.textContent = '請選擇有效開始日期'; confirmCycle.disabled = true; }
    });
    confirmCycle.addEventListener('click', () => {
      if (!result) return;
      guidanceRevision++;
      result = Services.importConfirmation.setCycleStart(result, cycleStart.value);
      Services.importConfirmation.confirmCycle(result);
      showResult(result);
      if (result.validation.readyForSearch) guideTo(root.querySelector('#identity-selection'));
    });

    function announce(message, error = false) {
      if (!result) placeStatus(root.querySelector('#import-status-slot'));
      if (status.textContent !== message) status.textContent = message;
      status.classList.toggle('error', error);
    }

    function reset() {
      clearResult();
      selectedFile = null;
      input.value = '';
      selected.hidden = true;
      fileName.textContent = '';
      fileFormat.textContent = '';
      parseButton.disabled = true;
      setProgress(0);
    }

    function selectFiles(files) {
      reset();
      if (files.length !== 1) {
        announce('請一次選擇一個 PDF 或 Excel 班表檔案。', true);
        return;
      }
      const file = files[0];
      const format = FileFormat.detect(file.name);
      if (!format) {
        announce('不支援此檔案格式，請選擇 .pdf、.xlsx 或 .xls 檔案。', true);
        return;
      }
      selectedFile = file;
      setProgress(1);
      fileName.textContent = file.name;
      fileFormat.textContent = format;
      selected.hidden = false;
      parseButton.disabled = false;
      announce(`已辨識為 ${format} 格式。檔案僅保留於此頁面，尚未解析。`);
    }

    input.addEventListener('change', () => {
      // Canceling the chooser should preserve the existing selection.
      if (input.files.length) selectFiles(Array.from(input.files));
    });
    root.querySelector('#remove-file').addEventListener('click', () => {
      reset();
      announce('已移除檔案，您可以重新選擇班表。');
      input.focus();
    });
    dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    dropZone.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('drag-over');
      selectFiles(Array.from(event.dataTransfer?.files || []));
    });
    // Prevent dropped files outside the import zone from navigating away.
    root.addEventListener('dragover', (event) => event.preventDefault());
    root.addEventListener('drop', (event) => event.preventDefault());
    parseButton.addEventListener('click', async () => {
      if (!selectedFile) return;
      const file = selectedFile;
      const token = ++generation;
      const sheetName = sheetSelect.value || undefined;
      result = null;
      personal.setSchedule(null);
      resultPanel.hidden = true;
      resultSummary.replaceChildren();
      issues.replaceChildren();
      parseButton.disabled = true;
      setProgress(1,false,'解析中');
      issueDetails.open = false;
      announce('正在裝置上讀取與驗證班表…');
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('檔案超過 25 MB，請選擇較小的班表檔案。');
        const parser = FileFormat.detect(file.name) === 'PDF' ? Services.pdfParser : Services.excelParser;
        const model = await parser.parse(file, {sheetName});
        if (token !== generation) return;
        if (model.needsSheetSelection) {
          sheetSelect.replaceChildren();
          for (const name of model.sheetNames) {
            const option = root.createElement('option'); option.value = name; option.textContent = name; sheetSelect.append(option);
          }
          sheetChoice.hidden = false;
          setProgress(1,false,'選擇工作表');
          announce('找到多張可能的班表，請選擇工作表後再次開始解析。');
        } else showResult(model, {guide:true});
      } catch (error) {
        if (token !== generation) return;
        result = null;
        personal.setSchedule(null);
        setProgress(1,false,'解析失敗');
        announce(error.message || '無法解析班表，請確認檔案格式。', true);
        root.querySelector('#file-state').textContent = '讀取／解析失敗';
      } finally {
        if (token === generation) parseButton.disabled = !selectedFile;
      }
    });
    sheetSelect.addEventListener('change', () => {
      generation++; result = null; personal.setSchedule(null); resultPanel.hidden = true;
      resultSummary.replaceChildren(); issues.replaceChildren();
      parseButton.disabled = !selectedFile;
      setProgress(1);
      announce('已切換工作表，請重新開始解析。');
    });
  }

  // Stable namespace for future NSS integration and separately loaded services.
  Object.assign(ns, {version: '0.3', FileFormat, Services});
  createImportController(document);
})();
