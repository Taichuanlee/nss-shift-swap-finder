# V0.8 Phase 3：同源中央班表整合 SSF

## Phase 3.1 介面更新

Cloudflare SSF 的使用者介面統一使用「單位班表」與「自行上傳」。預設單位班表，登入與背景格式／四週期驗證通過後直接顯示姓名選擇；整個匯入確認、日期／週期確認、解析摘要與錯誤警告區均不顯示。背景驗證失敗仍在單位班表區顯示明確錯誤，不允許搜尋。

來源選擇切到自行上傳後，才顯示 PDF／Excel 選檔與原匯入流程。僅切換來源、還沒選檔，也會清除身分、個人修正與搜尋結果；切回單位班表沿用既有 Session 檢查與載入流程。登入、Cookie、Session 時間、Worker API 與換班演算法均未更動；未開始管理者後台。

根目錄首頁仍不載入此入口。部署前需重新執行 `build-integrated.mjs`：舊部署包不會隨原始碼自動更新；先前已填 ID 的 `ssf-iK4MpG/wrangler.jsonc` 保留不動，新產物仍需另行填妥部署 ID。下方 Phase 3 的詳細流程保留作架構紀錄，介面呈現以本節為準。

僅在 `dev/v0.8` 開發，使用合成班表，尚未部署。目標仍是既有測試 Worker `nss-ssf-v08-test`。正式 GitHub Pages 首頁不加入中央入口，也不改部署 workflow；換班演算法、交換規則、解析器與 Phase 1 adapter 均未改動。

## 最小接點與操作流程

`js/app.js` 只新增可選的匯入控制器介面 `ImportController`，中央來源與本機檔案共用原有結果顯示、身分確認、個人修正及換班 UI。中央 API 模組與入口 HTML 只加入 Cloudflare 建置產物，不加到根目錄 `index.html`。

1. 開啟 Cloudflare 的完整 SSF 首頁。已有有效 HttpOnly Cookie 時，自動檢查 session 並取得目前已發布班表；否則顯示登入表單。
2. 輸入共用碼，載入 Worker `/api/schedule` 的 envelope，將 `payload` 交給既有 `SchedulePublication.load()` 還原並重新驗證，不相信外部 validation 旗標。
3. 中央正式四週期已由發布者確認，直接顯示起訖並鎖為唯讀；使用者仍須選擇自己並確認身分。之後沿用個人班表、暫時修正及原有換班搜尋。
4. 「載入／更新中央班表」會清除原資料與搜尋，再載入目前 API 可見版本。重新整理頁面也會重載。版本更新後重新確認身分，不保留舊修正。
5. 備援直接選下方 PDF／Excel：中央請求被取消，本機原匯入、工作表選擇、日期與四週期確認流程保持原狀。備援檔案不 POST 到 Worker。
6. 「目前來源」明確顯示中央＋完整 revision＋發布時間，或手動 PDF／Excel。載入中的來源沒有可搜尋資料；不是合併模型。
7. 登出／已知到期／中央載入失敗會清除中央的身分、個人修正與搜尋。若使用者已切到手動來源，中央登出／到期不刪除本機班表。未獲伺服器確認的登出會提示重試。

錯誤提示區分：錯誤存取碼、尚未登入／401、期限到達、網路失敗、15 秒逾時、限速、沒有發布班表、格式錯誤／驗證失敗與服務故障。失敗時不保留舊中央搜尋，也不偷偷切換另一份班表。

用既有 generation 與中央 AbortController／操作序號防止競態。選檔先取消中央請求；中央載入先取消本機解析結果的生效權。即使網路取消太晚，也不能將已過時回應寫回目前來源。

## 本機建置與驗證

```sh
node prototypes/cloudflare-v08/build-integrated.mjs
node --test prototypes/cloudflare-v08/worker.test.mjs
node --test prototypes/cloudflare-v08/integrated.test.mjs
```

Chrome 整合測試需既有 Playwright（必要時指定 `NODE_PATH`）、Chrome 與 OpenSSL，會只綁 localhost HTTPS，使用記憶體 KV／ASSETS 適配器，不連 Cloudflare。原有 Phase 2 `browser.test.mjs` 與既有 `tests/` 全部保留。

每次建置會建立新的、Git 忽略的 `dist/ssf-<隨機字尾>/`，終端印出確切路徑，避免把舊檔案或私人檔案殘留帶入新版：

| 內容 | 用途 |
| --- | --- |
| `worker.mjs` | API 與靜態資源路由，包含未修改的共用發布驗證 runtime |
| `public/` | 精確白名單的 SSF HTML、CSS、JS、PDF.js／SheetJS、CMap／字型與中央入口，共 205 個公開資源 |
| `wrangler.jsonc` | 既有測試 Worker 名稱、ASSETS binding、SCHEDULE_KV binding 待填 ID |
| `asset-inventory.json` | 公開資源清單，位於 public 外，不公開提供 |

不掃描 `test-data`、來源班表、秘密檔或整個 repository；來源資源須為非連結的普通檔案，vendor 僅允許既有程式、字型／CMap 與授權檔類型。產物 public 不含合成班表、管理檔、Worker 原始碼、Secret 或 local-secrets.json。原型測試碼的生成及忽略方式沿用 [Phase 2 文件](README.md)。

中央整合測試涵蓋：同源登入、既有 adapter、完整 40 天、唯讀正式 28 天、身分確認、實際換班結果、個人修正不寫 KV、A→B 切換重設、重新整理自動載入、中央回應與手動 Excel 的競態、手動來源登出保留、伺服器／客戶端格式錯誤、網路失敗、401 與本機已知到期清除、真實 PDF.js 備援、320／1280px 無水平溢出與零跨站請求。

## 部署差異：不能只貼 Phase 2 的單檔

**根目錄 `dist/worker.mjs` 仍是 Phase 2 小型診斷頁，不是 Phase 3。**完整 SSF 有約 6.7 MB 函式庫與字型，採真正的 Worker Static Assets：`public/` 與此建置目錄下的 `worker.mjs` 必須一起部署。

只有在你確認部署後才操作；本次沒有部署、安裝 Wrangler、登入 Cloudflare 或讀取遠端帳號：

1. 保留現有測試 Worker 的 `ACCESS_CODE_SHA256` Secret 與測試 KV，不新增付費服務，不操作 Pages。
2. 在產生的 `wrangler.jsonc`，把 `REPLACE_WITH_EXISTING_TEST_NAMESPACE_ID` 換成 **現有測試 namespace 的 ID**（不是名稱）。`keep_vars: true` 保留 Dashboard 的一般變數，Secret 不應寫進設定。
3. 建議在你本機使用 Wrangler 將這份設定、Worker 與 `public/` 一次部署到既有測試 Worker。這比在 Dashboard 分別貼程式／上傳資料夾更能確保 API、ASSETS 與版本一起更新。後續需你授權工具安裝／帳號登入；不需要把 API token 給 Codex。

   ```sh
   # 尚未執行；確認部署後，使用實際產物目錄取代下面路徑
   npx wrangler login
   npx wrangler deploy --config prototypes/cloudflare-v08/dist/ssf-XXXXXX/wrangler.jsonc
   ```

4. 若已有平台 `LOGIN_LIMITER` binding，部署前也須將它加入此設定（可參考 `wrangler.jsonc.example`）；不要假設未列出的 bindings 一定被保留。否則沿用原型 per-isolate 限速，仍未達正式分散式防濫用要求。
5. 開既有測試 Worker URL，完成登入／中央搜尋／Excel 與 PDF 備援／到期／登出驗收。若 Dashboard 支援你帳號的完整程式＋資源上傳，可用相同產物，但不能把靜態網站上傳當成已有 API 或只貼 worker.mjs 當成已上傳 public。

Cloudflare 官方推薦 Wrangler 一併上傳靜態資源：[Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[設定與 ASSETS binding](https://developers.cloudflare.com/workers/static-assets/binding/)、[直接上傳 API](https://developers.cloudflare.com/workers/static-assets/direct-upload/)。本次只查文件及本機驗證，未確認帳號 Dashboard 的實際上傳介面。

## 尚未解決的邊界

- Worker 仍保留 Phase 2 的合成身分限制，拒絕普通員工身分。這是合成資料整合版本，不是已核准處理真實班表的服務。
- 真實 `ASSETS` binding、Workers 免費 CPU／資源額度、Safari 與正式網路需重新實測。為一致套用路由與安全標頭，`run_worker_first: true` 會讓公開資源也經 Worker，增加動態請求；沒有新付費服務，仍須看帳號總量。
- KV 更新／撤權延遲沿用既有限制。頁面開啟、重新整理或按更新會讀取目前可見版本；不背景持續輪詢，不宣稱開著頁面會即時收到推播。
- 已知 session 到期會清除中央資料。管理者提前刪除 session 在既有畫面不會自動推播撤權；下一次 API 呼叫才知道，且仍受 KV 傳播延遲影響。已下載到裝置的資料不能遠端收回。
- 此階段沒有新增管理者發布 UI、全體撤權世代、個人帳號或 NSS 共用權限服務；共用碼仍不能證明員工個別身分。
