# NSS Shift Swap Finder

護理師換班搜尋工具 · v0.3

沿用既有 PDF／Excel 解析與首頁設計，加入通用日期推斷、安全自動修正及正式四週期確認。班表與匯入確認紀錄只保留於瀏覽器記憶體；明確確認身分後，只將該員工 ID 記住於這部裝置的 localStorage。本階段不提供逐格編輯、換班搜尋或換班建議。

## Mac 本機使用

在 Terminal 執行（需要 Python 3，無須安裝專案套件）：

```sh
cd /Users/becklee/Documents/GitHub/nss-shift-swap-finder
python3 scripts/serve.py
```

用 Chrome、Safari 或其他支援現代 JavaScript 模組的瀏覽器開啟 <http://127.0.0.1:8000/>。結束時回到 Terminal 按 Control+C。若 8000 已使用，可執行 `python3 scripts/serve.py --port 8001` 並開啟對應網址。

這是僅綁定 `127.0.0.1` 的靜態程式伺服器，不處理班表資料，也不接受上傳；不提供 `test-data/`、`sources/` 或 `.git/`。PDF.js 模組與 Worker 需要 HTTP；直接雙擊 `index.html` 的 `file://` 模式不支援 PDF 解析。

1. 選擇或拖曳一個 PDF、XLSX 或 XLS（最多 25 MB）。
2. 按「開始解析」。多張可能的 Excel 班表會顯示工作表選單，選擇後再按一次。
3. 系統依實際日期欄位順序推斷異常日期。證據充分、跨頁一致且重建後無日期或班別衝突時，背景自動修正，摘要顯示修正標題數量；同一標題重複三頁只計一次。不會修改來源 PDF。
   若不能安全修正，保留原資料與人工確認建議；沒有唯一推斷時需核對原班表，不能完成匯入。人工確認單一建議也不會忽略其他錯誤。
4. 日期與班別驗證通過後，核對正式四週期開始日期；可修改開始日期，結束日自動加 27 天。按下「確認這個正式四週期」後才完成匯入確認。修改開始日期需重新確認，超出班表或有日期缺漏的範圍不能確認。
5. 查看員工人數、日期數量、班表顯示範圍、正式四週期與錯誤／警告。週期外日期仍保留。換班搜尋尚未開放。
6. 更換或移除檔案立即清除前份班表狀態，舊的非同步結果不會覆蓋新選擇。

### 匯入操作引導

主要操作區顯示「上傳班表 → 解析班表 → 確認四週期 → 匯入完成」，以顏色、文字與勾號區分已完成、目前階段及尚未完成。選檔後等待解析，解析中顯示狀態；解析失敗或資料仍有問題時停留於解析階段，不標示匯入完成。

日期與班別驗證通過、正式四週期尚未確認時，顯示「班表解析成功！還差最後一步，請確認正式四週期。」提示只保留一份並顯示於四週期確認區，頁面平順捲動至該處。日期需處理時優先捲動至日期建議；其他班別／資料錯誤會展開錯誤清單並引導至該處。修改四週期開始日期不會反覆捲動，確認完成後才顯示「匯入完成」。減少動態效果設定改用即時捲動，區域聚焦不會自動開啟手機鍵盤。

How it works 說明本階段的四個匯入步驟，明確區分讀取班表與完成四週期確認；不提供換班搜尋。

## 解析支援與限制

### PDF

使用文字座標重建列，再依表頭欄界對應身分與每日班別；不採用原始文字擷取順序。支援多頁與重複表頭，依員工編號合併，保留全部日期與來源頁碼／座標。重複編號會警告；同日不同班別或同編號不同姓名會列為個別員工衝突，保留衝突兩值供後續定位。

目前支援可擷取文字、表頭含「姓名／Name」、「員工編號／ID」及每欄日期的橫向表格。表頭文字需能各自擷取為文字項目；文字跨欄、偏離欄位、無法辨識身分列或某頁缺少表頭都會阻擋全域可信度。此版不支援 OCR、掃描型 PDF、加密 PDF、旋轉／複雜多層表頭、表格跨頁但無重複表頭、只有日數的表頭。中文 CMap 與標準字型已本機保存；特殊字型文件仍可能無法辨識。

解析器已完成合成資料回歸與使用者提供文件的本機 Chrome 匯入確認測試；不代表完整支援其他醫院 PDF 格式。實際文件內容與員工資料不收錄於此文件或測試紀錄。

### Excel

使用 SheetJS 解碼 XLSX 與 XLS，掃描全部工作表與資料列找表頭，沒有假設第一張工作表或第一列就是班表。支援欄位位置變動、合併標題、身分表頭的直向合併、文字日期與有日期格式的數值儲存格、1900／1904 日期系統。跨欄／跨列合併的每日日期或班別無法可靠配對，會標示全域問題，不填補為相同班別。

多張候選工作表先由使用者選擇，不自行合併；無可辨識表頭會解釋原因。需姓名、員工編號與至少兩個日期欄。格式未標記為日期的數值不猜成日期。公式不運算、巨集不執行、外部連結不抓取；公式儲存格標示待確認。加密或損毀檔案不支援。XLS 已通過合成 BIFF8 檔案測試；其他歷史版本與特殊編碼尚未驗證。

### 共用日期與班別規則

- 日期使用 `YYYY-MM-DD`，以 UTC 日期運算，避免本機時區偏移。
- 支援完整西元日期，或在表頭／標題有唯一年份時使用月／日。原始解析器會依序處理 12 月到 1 月的跨年；其他逆序先保留原值，再依下述安全條件推斷。缺少年份、無效日期、日期中間出現不可辨識欄、重複／缺漏／順序異常皆標示全域錯誤。只依前一日加一天與後一日減一天指向同一日期的證據推斷，不包含任何固定日期替換。使用 UTC 日曆運算，處理跨月、跨年及閏年；月／日表頭也會重新判定受誤植影響的跨年年份。
- PDF 自動修正需欄列可靠、跨頁同位置日期一致、候選完整日期連續且無重複／衝突；重建後逐格核對原始值、正規化班別及來源位置。多個可獨立推斷的異常一起檢查、全數通過才套用；失敗時整批保留原值。相鄰多個異常、首末日期誤植或缺少兩側證據不強行猜測。未知班別仍獨立阻擋匯入完成。
- 工作班別：`A`、`E`、`N`。休假白名單：`O`、`OF`、`ON`、`OZ`、`O1`、`O6`、`O8`。
- 保留每格原始代碼及正規化班別，不把 `OF` 改成 `O`。未知 O 系列與其他未知代碼均待確認，空白不是休假。
- `Validator.validate(model, {extraLeaveCodes: [...]})` 預留本次解析白名單；此版沒有班別白名單確認或逐格編輯介面，也不修改全域白名單。
- 全域錯誤阻擋整份班表可信度。局部錯誤只標記對應員工 `validation.complete=false`，其他完整員工仍保留，供後續排除機制使用。

## 架構與資料模型

```text
index.html                 既有首頁、工作表選擇、日期與週期確認、結果與警告
css/style.css              原有設計與結果區樣式
js/app.js                  選檔與非同步狀態、確認操作、統計呈現
js/personal-schedule.js    身分搜尋與確認、記住唯一 ID、個人 28 天班表
js/import-confirmation.js  日期建議／決策、修正追溯、正式四週期確認
js/schedule-model.js       資料模型、共用日期／班別、表格轉換
js/schedule-validator.js   全域與局部驗證
js/pdf-parser.js           PDF.js 與座標欄列辨識
js/excel-parser.js         SheetJS 與工作表／日期系統辨識
vendor/                    固定版函式庫、CMap、字型與授權
scripts/serve.py           僅提供程式資源的本機伺服器
tests/                    合成資料、單元、伺服器與瀏覽器整合測試
test-data/                本機私有測試、截圖與瀏覽器 profile（Git 忽略）
```

沿用封閉 JavaScript 模組及 `window.NSSShiftSwapFinder` 命名空間。`Services` 對接兩種解析器與驗證器；`swapEngine` 維持 `null`。未來換班引擎僅依賴共用模型。

解析器回傳 `sourceType`、`scheduleStartDate`、`scheduleEndDate`、`scheduleDates`、`employees`（`id`、`name`、`shifts`、來源資訊與個別驗證）、`unresolvedDateColumns`、`warnings`、`errors`、`validation`。錯誤含 `scope`（global／local）、`code`、訊息、來源位置及相關員工編號。

`ImportConfirmation.initialize(model)` 回傳已完成安全日期推斷的模型，PDF 符合所有條件時自動套用；呼叫端須使用回傳模型。Excel 保留人工建議流程。未通過安全檢查則保留原模型，`decideDate()` 記錄人工接受／拒絕決策。兩種修正都透過 `Model.rebuildDates()` 從原始欄位重建對應，原始表格以私有 WeakMap 留在記憶體。

`dateColumns[].raw` 保留原始標題；`dateCorrections` 記錄原始日期、推斷日期、頁碼／位置、原因與 `confirmedBy`（automatic／user）。`kind=date-header` 表示標題修正，`kind=year-context` 記錄修正後受影響的年份解讀。摘要只計算不同的自動修正標題，不重複計入頁數或年份解讀。`Model.dateCellsPreserved()` 從原始表格逐格核對班別及來源，並核對儲存格總數。所有追溯資料只在記憶體，不自動保存或輸出。

`setCycleStart()` 設定開始日期及自動計算結束日，同時撤銷確認；`confirmCycle()` 僅在基礎資料、全部錯誤及連續 28 天覆蓋檢查通過時設定 `cycleConfirmed=true`。`cycleSource` 為 `user`。`readyForSearch` 只有全部必要驗證及明確週期確認通過才為 true；目前沒有搜尋引擎或搜尋入口。`scheduleDates` 與所有 `shifts` 保留週期外日期。`basicValidationPassed` 與 `completeEmployeeCount` 供統計使用。

## 函式庫與安全

- **PDF.js 6.4.299**：Mozilla 官方 `pdfjs-dist` 的 legacy ES module 與同版 Worker，適合文字座標擷取。按解析時才載入，Worker 在裝置內運作。CMap／標準字型需求僅抓取本機資源，不採用遠端文件 URL。
- **SheetJS 0.20.3**：官方完整 standalone script，以本機 deferred script 載入，涵蓋 XLSX／XLS 與日期系統。未使用 Worker；大型 Excel 仍可能暫時阻塞主執行緒。
- 無其他執行期依賴、框架、資料庫或雲端解析。來源、授權與主要檔案校驗碼見 `vendor/README.md`。
- 僅同源程式、Worker、字型資源有 GET 請求；班表以 `File.arrayBuffer()` 讀入記憶體，不送到伺服器。CSP 限制外部連線與表單提交。程式不記錄完整班表、只使用 localStorage 記住已確認的員工 ID，不使用 IndexedDB，也不保存解析結果。
- `test-data/` 已建立並忽略；PDF／Excel 副檔名亦預設忽略。請勿提交任何真實班表／個資。未修改 `sources/`（開發時此目錄不存在）。

## 測試

`test-data/` 已放入不含個資的合成範例（檔名以 `synthetic-` 開頭），可直接在首頁選擇：正常／多頁／無文字 PDF、正常 XLSX／XLS，以及含局部異常與多工作表的 XLSX。若需要重新產生，可執行 `node tests/generate-fixtures.cjs`；既有同名檔案不會被覆寫。這些文件均被 Git 忽略。

需要 Node.js，無需安裝套件即可執行核心測試：

```sh
node --test tests/parsers.test.cjs tests/pdf-diagnostics.test.cjs tests/import-confirmation.test.cjs tests/date-inference.test.cjs tests/personal-schedule.test.cjs
python3 -B tests/server.test.py
```

瀏覽器整合測試需要現有 Playwright 與 Google Chrome（沒有納入執行期依賴）：

```sh
node --test tests/browser.test.cjs
```

若 Playwright 不在預設搜尋路徑，透過 `NODE_PATH` 指定既有安裝位置。Chrome 預設為 Mac 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，可用 `CHROME_PATH` 覆寫。

合成測試涵蓋：座標 PDF、多頁、重複表頭、日期／班別錯位、無文字 PDF、實際 XLSX／XLS 解碼、合併儲存格、多工作表、Excel 日期系統、跨月跨年、未知 O 代碼、空白班別、員工衝突、局部與全域錯誤、資料清除及過期非同步結果。瀏覽器測試生成真實 PDF bytes 並由本機 PDF.js／Worker 解碼，也檢查手機／桌面無水平溢出及零外傳請求。

測試涵蓋不同年份／月份的通用推斷、自動修正、接受／拒絕人工修正、三頁一次套用、跨月、跨年、二月 28／29 天、多個異常、矛盾日期、跨頁不一致、原始值及欄位對應保留、班別異常及四週期範圍／確認。Chrome 整合測試也實際操作確認區塊，並測試缺少串流非同步迭代時的 Safari 相容路徑、手機寬度及更換檔案清除狀態。伺服器測試確認私人資料路徑與上傳仍被阻擋。測試資料全為合成資料；真實文件只在本機記憶體另行驗證，不保存其內容。

Safari 人工驗收已由使用者確認通過。本次 UI 自動化測試使用 Chrome，另涵蓋 Safari 相容讀取路徑；相容路徑模擬不等於本次 UI 的實際 Safari 操作測試。

## PDF 診斷修正

PDF 錯誤現在區分函式庫載入、本機讀檔、文件載入（含 Worker 初始化）、頁面載入、文字擷取、明顯編碼異常，以及表格辨識。文字擷取成功後的表格錯誤不會再顯示成文字擷取失敗；清理資源的例外亦不會覆蓋原始結果。啟用 `stopAtErrors`，避免 PDF.js 默默略過擷取錯誤。編碼檢查僅偵測替代字元與異常控制碼，不能保證所有文字映射都正確。

新增 `pdfDiagnostics` 僅含階段、頁數、每頁文字項目數、固定錯誤類型與清理狀態；不含檔名、文字、員工資料或底層錯誤訊息，不寫 Console 或自動保存。既有狀態列會顯示這些安全統計。

PDF 表頭支援同欄跨行／分段文字合併。班別依欄界定位，允許欄內靠左文字；間距異常、跨欄文字與造成缺欄的班別碰撞仍會阻擋。孤立頁尾不再當作員工資料。未對應日期的欄位以 `pdfUnresolvedColumns` 保留原始表頭與每位員工的值於記憶體，仍標示問題，不猜測日期。`pdfHeaderMetadata` 保留明確已確認非每日欄位的原始標籤。v0.2A-2 增加安全日期自動修正、未解決問題提示與正式四週期確認；其他未知日期與班別仍需另行處理，不提供任意逐格編輯。

額外合成回歸測試涵蓋各階段例外、錯誤訊息去識別、清理失敗、編碼／座標異常、跨行日期、靠左班別、頁尾與未對應欄位保留。Chrome 整合測試檢查 Worker 與本機 CMap／字型資源，並保留 Excel 回歸測試。實際文件的診斷內容不收錄於本文件或測試資料。

`pdfTableRecognized` 僅表示欄列幾何及員工對應已辨識，不代表資料驗證通過。當表格已辨識，但日期、班別或未對應欄位仍有問題，診斷階段為「PDF 資料驗證」；原有錯誤、警告及搜尋阻擋條件保持不變。新增合成測試驗證這兩種階段不會混淆。

### 本機 Safari 手動診斷

診斷模式預設關閉，僅接受本機 HTTP 網頁。開啟 Safari Web Inspector 的 Console，執行：

```js
await NSSShiftSwapFinder.PdfParser.startDiagnostics()
```

這會生成不含員工資料的單頁 PDF，透過相同版本、Worker、資源設定及 `getTextContent()` 執行自我測試。`probe` 提供此合成 PDF 的完整例外 message 與 stack；`streamAsyncIterator` 顯示瀏覽器是否支援 PDF.js 使用的串流非同步迭代。

接著在原有網頁重新匯入 PDF 並按「開始解析」，於 Console 執行：

```js
JSON.stringify(NSSShiftSwapFinder.PdfParser.getDiagnostics(), null, 2)
```

`lastFailure` 只含階段、數量、錯誤類型及本機程式位置；只有原始訊息與合成 PDF 例外完全一致時，才顯示已比對的訊息。其餘訊息隱藏，真實文件的原始 stack 不保留。`matchesSyntheticProbe` 用於確認兩者是否為相同 API 例外，不能僅因 API 缺少便認定真實文件的失敗原因。沒有自動 Console 輸出、儲存或外傳。關閉診斷或重新整理頁面即可清除：

```js
NSSShiftSwapFinder.PdfParser.stopDiagnostics()
```

Source Map 僅供開發工具映射原始碼，404 與文字擷取例外需分開判讀。

### Safari 串流讀取相容處理

PDF.js 6.4.299 的 `getTextContent()` 使用 `ReadableStream` 非同步迭代。瀏覽器缺少此 API 時，自有解析器改用官方 `streamTextContent()`，透過 `getReader().read()` 依序合併 items、styles 與 lang；讀取失敗會取消串流並釋放鎖，不掩蓋原始錯誤。支援非同步迭代的 Chrome 保留原本流程，純 XFA 文件亦保留 PDF.js 專用流程。不修改 PDF.js／Worker、不更換版本、不新增外部資源。

診斷中的 `textExtractionMethod` 會顯示 `streamTextContent.getReader` 或 `getTextContent`。Safari 手動驗收：重新整理後執行上方診斷，再重新匯入 PDF；合成 probe 應成功，真實文件應完成文字擷取及表格辨識，待確認日期、班別與未對應欄位仍不得放行搜尋。自動化回歸涵蓋缺少非同步迭代 API、多頁合成 PDF 的兩條路徑一致性，以及讀取／清理失敗；模擬測試不等於實際 Safari 驗收。

### 已確認的 PDF 非每日欄位

僅對完整標題 `11月預定夜班`、`12月預定夜班`、`單位` 套用已確認規則。前兩者代表該月份預定的大班（A／E／N），後者代表目前能勝任的職位；皆不對應特定日期。原始標題、分類、每位員工的原始值與來源位置保存在 `pdfNonDailyColumns` 記憶體資料中，不寫入每日 `employees[].shifts`，不供未來搜尋或連續上班天數計算使用，也不再列入 `pdfUnresolvedColumns` 或未知欄位錯誤。

不再以儲存格內容猜測未知前置欄位是否為備註。其他月份、加字或相似標題仍待確認；日期異常、未知每日班別及欄列對應驗證維持原規則。合成測試包含中文 PDF 表頭、原始非每日值追溯、相似／未知標題，以及 Chrome 原流程與 Safari 相容讀取路徑的一致性。

### 已確認的每日班別註記

共用 `normalizeShift()` 根據已確認的片段組合辨識，不逐一列舉完整字串。單一 A／E／N 搭配「休」及／或 `-8`（各最多一次）正規化為該工作班別，註記順序可不同、片段間可有或沒有空白；`O N` 正規化為休假代碼 `ON`。必須完整辨識整個字串，不能跳過未知字元；`A特`、`E病`、「休」單獨出現及重複註記仍為未知。`ON` 與其他既有休假白名單保持原值，不因包含 N 或「休」而誤判。

`employees[].shifts[date]` 儲存正規化後班別，供驗證及未來運算使用；`shiftDetails[date]` 保留該日期每個來源儲存格的 `{raw, normalized, source}`，包含重複頁面與衝突資料，僅存在記憶體。同日註記不同但正規化班別相同，不視為班別衝突；實際班別不同仍阻擋該員工。日期驗證維持原規則；正式四週期未明確確認仍阻擋匯入完成。

## 個人班表（v0.3）

匯入驗證與正式四週期確認通過後，以姓名或員工編號搜尋自己，核對姓名與編號，按「確認這是我」。完整 28 天依實際開始日分成四列、每列七天，顯示日期、星期與原有正規化班別；不包含週期外日期，不提供編輯或換班搜尋。

同名同仁分別顯示員工編號。只有可靠且唯一的編號可記住及重新比對；下次匯入可選「繼續使用上次身分」，仍需明確確認。不依姓名自動配對，找不到或編號重複時須重新選擇。儲存項目僅包含版本與已確認 ID，沒有姓名、每日班別或其他同仁資料，可按「清除記住的身分」移除；瀏覽器拒絕儲存時仍可查看本次班表。

「切換同仁」立即清除個人班表並要求重新確認。更換檔案、重新解析、切換工作表或修改正式四週期，也會使當前身分與個人班表失效。
