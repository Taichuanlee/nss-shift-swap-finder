/* Classic-script module keeps direct file:// opening available without a server. */
(() => {
  'use strict';

  const FileFormat = Object.freeze({
    detect(name) {
      const extension = name.split('.').pop().toLowerCase();
      return ({ pdf: 'PDF', xlsx: 'Excel', xls: 'Excel' })[extension] || null;
    },
  });

  // Future integration points. No file contents are read in Phase 1.
  const Services = Object.freeze({
    pdfParser: null,
    excelParser: null,
    scheduleValidator: null,
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

    function announce(message, error = false) {
      status.textContent = message;
      status.classList.toggle('error', error);
    }

    function reset() {
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
    parseButton.addEventListener('click', () => {
      if (!selectedFile) return;
      announce('解析功能尚未開放（Phase 1 / v0.1）。目前未讀取檔案內容，也未產生換班建議。');
    });
  }

  // Stable namespace for future NSS integration and separately loaded services.
  window.NSSShiftSwapFinder = Object.freeze({ version: '0.1', FileFormat, Services });
  createImportController(document);
})();
