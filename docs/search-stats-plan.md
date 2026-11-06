# SSF v1.0.2 換班搜尋統計

狀態：開發分支實作；未合併、未部署。正式 v1.0.1、正式班表 KV 與正式設定不變。

## 計數契約

- 單位班表已登入、確認員工與有效日期條件，完成 `SwapEngine.search` 並成功呈現結果後計一次；零候選人也計。
- 一次點擊即使勾選多個交換日期，也只計一次。相同條件再次搜尋產生新的 UUIDv4，另計一次。
- 未選條件、驗證失敗、搜尋／呈現途中程式錯誤、只選姓名、展開預覽均不計。
- 依被選取員工的 **record ID** 歸屬，不依姓名合併，不宣稱是實際操作者。無員編／同名員工仍分開。
- 事件送到 `POST /api/stats/events`，內容僅 `eventId, employeeId, revision`。最多兩次嘗試，各有五秒逾時；重試沿用相同 ID。不存離線佇列、不用 localStorage 儲存統計。
- 統計失敗、逾時、限流、未設定 binding 都不影響正常搜尋。頁面關閉、離線、班表版本更新造成的 409 或兩次失敗可能漏計；不是稽核或出勤系統。
- 自行上傳維持本機處理、不傳送統計。它沒有可由伺服器驗證的單位員工與版本；不得拿任意本機姓名去污染單位統計。GitHub Pages 不載入統計客戶端。

## 後端與保存

`stats-core.mjs` 驗證真實 ISO 日期、連續 28 天與唯一員工；Worker 從已驗證的 active publication 建立週期與員工資料，拒絕不存在的員工、過期登入及 stale revision，不接受客戶端提供姓名或計數。

`SEARCH_STATS` 是專用 SQLite Durable Object，instance 名稱 `cycle-search-stats-v1`。每個 28 天週期有獨立 cycle key、計數及員工快照，集中於同一物件提供歷史清單及跨請求的原子去重。同週期重新發布不清空計數；新週期不覆蓋舊週期；即使舊員工不在最新班表，舊統計仍可查。

事件唯一鍵與員工增量在同步 SQLite transaction 中一起提交，失敗一起回滾。UUID 大小寫正規化，重送不重複增量。物件沒有公開 HTTP 路由；只接受 Worker 的內部請求，且不提供 reset API。

到期時間採台北時區：四週期最後一天結束的次日 00:00，再加 180 個完整日。例如 2026-12-07～2027-01-03，於 2027-07-03 00:00（Asia/Taipei）到期。平台 alarm 在最早到期點喚醒，刪除該週期、員工姓名／ID／計數及去重事件，並安排下一個 alarm。讀寫也會先清除到期資料，所以即使 alarm 延遲也不回傳到期內容。執行環境故障時 alarm 並非精準秒級保證。

歷史清單包含曾收過事件的週期；目前發布週期即使尚無事件也顯示 0。未曾有事件且已被替換的班表，不額外建立歷史班表副本。資料庫只保存被選取過的員工姓名、ID、次數、週期及隨機事件 ID；不保存交換日期、條件、候選名單、個人修正、操作者、IP 或裝置分析資料。IP 僅用於平台登入限流，未寫入統計資料庫。

應用層到期刪除不等同抹除平台災難復原備份。Cloudflare SQLite PITR 可能保留最近 30 天恢復點；不得在未重新執行到期清除前將恢復的資料對外提供。[官方 SQLite storage 說明](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[alarm 說明](https://developers.cloudflare.com/durable-objects/api/alarms/)。

## 獨立管理頁與安全邊界

- `/stats.html` 是無員工資料的登入外殼；實際資料僅由 `GET /api/stats/summary` 提供。管理班表頁有連結，但班表管理員 cookie、護理端 cookie 都不能讀統計。
- `STATS_ACCESS_CODE` 使用至少 16 字元的獨立高熵密碼，最長 128 字元，不得等於 `ACCESS_CODE` 或 `ADMIN_ACCESS_CODE`。僅保存於部署環境 secret，勿放到前端、repo、聊天或命令紀錄。
- HMAC 簽署的隨機 session cookie，Secure / HttpOnly / SameSite=Strict / `__Host-`，15 分鐘期限，不滑動延長。密碼更換立即使舊簽章失效；登出把 cookie 指紋寫入專用 DO 撤銷表，至 session 到期自動刪除；增減其他角色 cookie 無法繞過撤銷。
- 寫入強制 exact same-origin、JSON、大小限制及護理端有效 session；管理讀取也拒絕跨來源與跨站請求。所有 API no-store，不允許 CORS；HTML 沿用 CSP / 禁止嵌入 / nosniff，表格以 textContent 呈現，無 HTML 插值。
- `STATS_LOGIN_LIMITER` 同時限制 IP 與共用帳號（5/min）；`STATS_EVENT_LIMITER` 分別限制護理 session 與 IP（120/min）。限制由平台提供，不使用 KV 或 isolate-local 計數替代；namespace ID 必須和其他服務隔離。
- 共用護理存取碼只能證明有讀取班表資格，不能證明身分或搜尋真的由人操作。擁有合法 session 的人仍可偽造統計事件；因此數字是使用估計，不是不可偽造的操作稽核。若將來需要此保證，必須改成伺服器執行搜尋／個別身分授權，而非僅加上前端旗標。
- 前端明示記錄範圍、保存期限及授權管理者可見性。管理者需遵守單位告知及資料使用規則，不以此推論個人工作績效。

## 測試與重現

使用 Node 24（含 node:sqlite）、Python 3、Playwright 與本機 Chrome。新增測試不使用真實班表、不連線 Cloudflare 遠端服務。

```sh
node --test prototypes/cloudflare-v08/stats-core.test.mjs prototypes/cloudflare-v08/stats-counter.test.mjs prototypes/cloudflare-v08/stats-api.test.mjs
node --test prototypes/cloudflare-v08/stats-browser.test.mjs
node --test prototypes/cloudflare-v08/stats-runtime.test.mjs
python3 -B scripts/build-pages.py --output dist/pages
node --test tests/*.test.cjs prototypes/cloudflare-v08/*.test.mjs
python3 -B tests/pages.test.py
python3 -B tests/server.test.py
```

瀏覽器測試沿用既有依賴載入方式，需讓 `require('playwright')` 可解析（例如外部測試工具目錄加 `NODE_PATH`）。Chrome 路徑可由 `CHROME_PATH` 指定。runtime 測試需 `require('miniflare')`；已使用 Playwright 1.65.0、Miniflare 4.20260730.0 + workerd 1.20261104.1。本機若 Miniflare 自帶較舊 workerd，將 `MINIFLARE_WORKERD_PATH` 指向相容日期至少 2026-10-20 的 workerd binary。這些是測試工具，均不放入發布包。

覆蓋：有效／零結果／重複點擊、多交換日一次、無效條件／程式錯誤不計、回應遺失後重試同 ID 去重、併發原子性／回滾、相同姓名不同 ID、歷史週期保留／到期刪除、平台 alarm、獨立登入／角色隔離／cookie 篡改／撤銷／跨來源／限流、統計故障隔離、KV 無新增統計寫入及既有發布／搜尋回歸。

## 本次驗證結果（2026-11-06）

完整 Node 回歸：162/162 通過（含既有本機解析、Pages、單位班表、管理發布及新增統計瀏覽器／SQLite／workerd 測試）。Python Pages 安全檢查 9/9、本機 server 安全測試 3/3 通過。最終介面調整另重跑統計瀏覽器測試，涵蓋 320px 不溢出；最後的到期錯誤回應調整另重跑 SQLite 測試。`git diff --check` 通過。這些是本機／合成資料驗證，未執行 Cloudflare 遠端驗收、正式 migration 或任何部署。

## 剩餘部署步驟（需另獲授權）

1. 先審閱本分支；不得直接合併 main 或部署正式 v1.0.1。本分支 push 不會觸發現有僅 main 的 Pages 部署。
2. 用 `node prototypes/cloudflare-v08/build-integrated.mjs` 建立全新本機包。新 Worker 是 ES module，必須攜帶 `worker.mjs`、`stats-core.mjs`、`stats-counter.mjs`、`public/` 及 inventory。舊 production README 只複製 worker 的 v1.0.1 步驟不適用本版本。
3. 經授權後先準備獨立測試 Worker、空測試 KV、全新 SQLite DO namespace 與獨立 limiter IDs；不沿用範例 ID 或正式 KV。生成的設定僅為測試樣板，部署前必須替換並核對。
4. 配置 `SEARCH_STATS` → `SearchStatsCounter` 及 migration `{tag:"v1.0.2-stats",new_sqlite_classes:["SearchStatsCounter"]}`，核對帳號支援與費用；若既有 namespace／migration 存在，先檢查歷史，勿重建或清空。
5. 設定三個獨立 secret 及四個 limiter bindings（原 LOGIN/ADMIN_LOGIN，加 STATS_LOGIN/STATS_EVENT）。核對 ASSETS run_worker_first、HTTPS、CSP、secret 及 Worker 路由，使用合成班表驗收完整流程與 alarm。
6. 正式上線前另行授權並確認告知、可存取人員、真實班表來源、現有 KV binding、migration／回復策略。統計只用專用 DO，不能往正式班表 KV 寫統計或清除班表。現有發布 API 仍保留原有明確發布行為，這次沒有呼叫它。
7. 回復 v1.0.1 僅切回已核對的舊程式與設定；勿刪班表 KV。統計 DO 的清理 alarm 仍需維持至最後週期到期，不因回復而留下無期限個資。
