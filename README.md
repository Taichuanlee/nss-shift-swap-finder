# NSS Shift Swap Finder

護理師換班搜尋工具 · Phase 1 / v0.1

獨立的前端工具，未來協助從四週期班表尋找換班對象、分析雙方班表影響。系統不會自動執行換班。

## 在 Mac 上開啟

在 Finder 開啟 `/Users/becklee/Documents/GitHub/nss-shift-swap-finder`，雙擊 `index.html`，或以右鍵「打開檔案的應用程式」選擇 Safari／Google Chrome。無需安裝套件、啟動伺服器或建置。

## 已完成

- 繁體中文首頁，手機優先並支援桌面。
- 選擇檔案與拖曳匯入；一次接受一個 `.pdf`、`.xlsx` 或 `.xls`。
- 依副檔名辨識格式（不分大小寫），顯示檔名與格式、移除或重新選擇。
- 不支援格式與多檔案的錯誤提示。
- 四步驟流程說明、隱私提醒及「開始解析」預留入口。
- 鍵盤焦點樣式、狀態訊息朗讀與長檔名換行。

## 尚未實作

「開始解析」只顯示尚未開放的訊息，不讀取檔案內容。姓名與日期選擇、PDF／Excel 解析、班表驗證、換班搜尋與建議均留待後續階段。

副檔名辨識僅用於介面提示，不代表檔案內容已通過驗證。

## 架構與擴充

```text
nss-shift-swap-finder/
├── index.html
├── css/style.css
├── js/app.js
├── README.md
└── .gitignore
```

使用原生 HTML、CSS 與 JavaScript，無框架、後端或資料庫。`app.js` 以封閉模組隔離狀態，分離 `FileFormat` 與匯入控制器，並提供 `window.NSSShiftSwapFinder` 命名空間。使用一般 deferred script，讓直接開啟本機 HTML 也能操作。

`Services` 保留 `pdfParser`、`excelParser`、`scheduleValidator`、`swapEngine` 四個入口，目前皆為 `null`。後續可在 `js/` 新增獨立模組，定義服務契約與注入機制後整合 NSS；目前未引入解析套件。

## 隱私與版本管理

檔案僅由瀏覽器暫存參照，移除或關閉頁面即釋放；不保存到本機儲存空間、不讀取班表內容、不傳送到伺服器。本專案不含網路請求、追蹤程式或外部字型。

請勿放入或提交真實護理師班表與員工個資。`.gitignore` 預設排除 PDF／Excel 檔案，仍應自行確認其他格式不含個資。

## 手動驗收

使用空白或不含個資的檔案測試：

1. 開啟首頁，確認「開始解析」初始停用。
2. 選擇或拖曳 PDF、XLSX、XLS（含大寫副檔名），確認檔名、格式與按鈕啟用。
3. 點擊「開始解析」，確認僅顯示尚未開放訊息。
4. 移除檔案，確認檔名清除、按鈕停用。
5. 拖曳不支援的檔案或多個檔案，確認錯誤提示與按鈕停用。
6. 使用手機寬度與桌面寬度檢查排版，使用 Tab／Enter 操作選擇、移除與解析按鈕。
