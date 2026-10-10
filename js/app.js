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
    const resultPanel = root.querySelector('#parse-result');
    const resultSummary = root.querySelector('#result-summary');
    const issues = root.querySelector('#result-issues');
    const sheetChoice = root.querySelector('#sheet-choice');
    const sheetSelect = root.querySelector('#sheet-select');
    function clearResult() {
      generation++;
      result = null;
      resultPanel.hidden = true;
      resultSummary.replaceChildren();
      issues.replaceChildren();
      sheetChoice.hidden = true;
      sheetSelect.replaceChildren();
      root.querySelector('#file-state').textContent = '已選擇 · 尚未解析';
    }
    function showResult(model) {
      result = model;
      resultPanel.hidden = false;
      const complete = model.validation.completeEmployeeCount;
      const stats = [
        ['檔案類型', model.sourceType === 'pdf' ? 'PDF' : 'Excel'],
        ['員工總人數', model.employees.length],
        ['可辨識員工人數', model.employees.filter(e => e.identityResolved).length],
        ['資料異常員工人數', model.employees.length - complete],
        ['已辨識日期數量', model.scheduleDates.length],
        ['班表顯示起訖', `${model.scheduleStartDate || '未辨識'} ～ ${model.scheduleEndDate || '未辨識'}`],
        ['警告數量', model.warnings.length], ['錯誤數量', model.errors.length],
      ];
      for (const [label, value] of stats) {
        const dt = root.createElement('dt'), dd = root.createElement('dd');
        dt.textContent = label; dd.textContent = String(value);
        resultSummary.append(dt, dd);
      }
      const state = model.validation.basicValidationPassed ? '基礎資料驗證通過' : model.employees.length && model.scheduleDates.length ? '部分資料解析成功／存在待確認問題' : '未取得可靠班表資料';
      root.querySelector('#result-state').textContent = `檔案已讀取 · ${state} · 尚未確認正式四週期`;
      for (const item of [...model.errors, ...model.warnings]) {
        const li = root.createElement('li');
        const place = item.source?.page ? `第 ${item.source.page} 頁${item.source.y !== undefined ? `，y=${Math.round(item.source.y)}` : ''}` : item.source?.sheet ? `工作表 ${item.source.sheet} ${item.source.cell || ''}` : '';
        li.textContent = `${item.scope === 'global' ? '全域' : `個別員工 ${item.employeeId || ''}`}：${item.message}${place ? `（${place}）` : ''}`;
        issues.append(li);
      }
      let message = model.validation.basicValidationPassed ? '基礎驗證通過，尚未確認正式四週期，不能進入換班搜尋。' : '已讀取檔案，解析或驗證有問題；請查看下方結果。';
      if (model.pdfDiagnostics) {
        const stage = model.pdfDiagnostics.stage;
        if (stage === 'text-encoding') message = 'PDF 文字擷取成功，但文字編碼異常；請查看下方結果。';
        else if (stage === 'text-extraction') message = 'PDF 已載入，文字擷取流程完成但未取得非空白文字；原因尚待確認。';
        else if (stage === 'table-recognition') message = 'PDF 文字擷取成功，但表格欄列辨識未通過；請查看下方結果。';
        else if (stage === 'data-validation') message = 'PDF 文字擷取與表格欄列辨識完成，但資料驗證未通過；請查看下方待確認問題。';
        message += `（${Services.pdfParser.diagnosticSummary(model.pdfDiagnostics)}）`;
      }
      announce(message, !model.validation.basicValidationPassed);
      root.querySelector('#file-state').textContent = '已讀取 · 四週期未確認';
    }

    function announce(message, error = false) {
      status.textContent = message;
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
      resultPanel.hidden = true;
      resultSummary.replaceChildren();
      issues.replaceChildren();
      parseButton.disabled = true;
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
          announce('找到多張可能的班表，請選擇工作表後再次開始解析。');
        } else showResult(model);
      } catch (error) {
        if (token !== generation) return;
        result = null;
        announce(error.message || '無法解析班表，請確認檔案格式。', true);
        root.querySelector('#file-state').textContent = '讀取／解析失敗';
      } finally {
        if (token === generation) parseButton.disabled = !selectedFile;
      }
    });
    sheetSelect.addEventListener('change', () => {
      generation++; result = null; resultPanel.hidden = true;
      resultSummary.replaceChildren(); issues.replaceChildren();
      parseButton.disabled = !selectedFile;
      announce('已切換工作表，請重新開始解析。');
    });
  }

  // Stable namespace for future NSS integration and separately loaded services.
  Object.assign(ns, {version: '0.2A-1', FileFormat, Services});
  createImportController(document);
})();
