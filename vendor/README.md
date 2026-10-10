# 本機解析函式庫

固定版本，執行時不使用 CDN。沒有 npm install 或額外執行期套件。

| 函式庫 | 版本 | 官方下載來源 | 授權 |
| --- | --- | --- | --- |
| PDF.js | 6.4.299 | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz | Apache-2.0，見 pdfjs/LICENSE |
| SheetJS CE | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | Apache-2.0，見 sheetjs/LICENSE |

PDF.js 使用 `legacy/build/pdf.mjs`、同版 `pdf.worker.mjs`、套件 CMap 與標準字型；各資源附帶授權保留。SheetJS 授權來源：https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE。

選擇原因與載入方式：PDF.js 能提供文字座標，透過本機 ES module 與 Worker 解碼；SheetJS 完整 standalone build 支援 XLSX／XLS，以本機 script 載入。只有程式、CMap 與字型資源可產生同源 GET；班表 bytes 不傳送到網路。

官方參考：[PDF.js](https://mozilla.github.io/pdf.js/getting_started/)、[SheetJS standalone](https://docs.sheetjs.com/docs/getting-started/installation/standalone/)。

主要程式檔 SHA-256（供檢查本機檔案一致性，不代表簽章驗證）：

| 檔案 | SHA-256 |
| --- | --- |
| `vendor/pdfjs/pdf.mjs` | `bc51f4874a66e3853189cb5d50aba4b3096afa83ed433b885d293a3d94583cdc` |
| `vendor/pdfjs/pdf.worker.mjs` | `bb422f60804477de4a0b09091d8347a916a387755ed1cbad24ccaec1d09c78bf` |
| `vendor/sheetjs/xlsx.full.min.js` | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` |
