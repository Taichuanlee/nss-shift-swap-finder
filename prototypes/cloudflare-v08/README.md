# Cloudflare V0.8 獨立技術原型

**Phase 3 已提供獨立的完整 SSF＋中央班表資源包；部署方式與本頁 Phase 2 單檔不同，請看 [PHASE3.md](PHASE3.md)。** 本頁 `build.mjs` 仍保留原診斷原型與既有測試。

僅限 `nss-ssf-v08-test` + `nss-ssf-v08-test-kv`，不整合正式 SSF，不修改根目錄首頁、演算法、GitHub Pages workflow 或 `main`。沒有 CI 自動部署，也沒有呼叫 Cloudflare 管理 API。**本機完成不代表已部署或已通過真實 Cloudflare 環境驗證。**

## 架構與資料

- `/`、`/app.js` 與 `/api/*` 由同一個 Worker 提供；不開放 CORS。
- `SCHEDULE_KV` 的固定 key `schedule:active` 保存一份 V0.8 v1 JSON。
- `build.mjs` 以作用域中的 `window` 適配器打包既有 `schedule-model`、`schedule-validator`、`import-confirmation`、`schedule-publication`；不改動共用程式，不使用 eval、框架或執行期套件。
- 每次授權下載後，使用既有 `SchedulePublication.load()` 重驗班表，再回傳 `{revision, observedAt, colo, expiresAt, payload}`。`revision` 為 KV 原始 UTF-8 字串 SHA-256，連空白變動也會產生新值；`payload` 保持既有 v1 格式。
- A／B 合成資料均有 2 位虛構員工、40 個連續日期、正式中間 28 天與前後日期。B 修改一格班別及匯出時間，供更新觀測。原型另要求 `SYNTHETIC` 數字編號與「合成」姓名前綴，拒絕一般身分；這是防誤用標記，不是匿名化或真實資料偵測器。
- 本原型沒有發布／上傳 API。只有你透過 Cloudflare Dashboard 改寫測試 KV；一般使用者僅能讀取。對不存在的資料／路徑不暴露 namespace 或檔案。

## 登入與安全邊界

1. 以 HTTPS JSON POST 傳送隨機測試共用碼；Worker 以 SHA-256 比對 Secret `ACCESS_CODE_SHA256`。**必須使用本機產生的高熵 32 字元碼，不得改用短 PIN 或一般人類密碼。**單次雜湊不適合保護低熵密碼。
2. 正確後產生 256-bit 隨機 token，只放在 `__Host-nss-ssf-test` Cookie：`Secure; HttpOnly; SameSite=Strict; Path=/`，無 Domain。
3. KV 只保存 `session:<token 的 SHA-256>`，內容為 `{version, createdAt, expiresAt}`，並設 expirationTtl。沒有簽章金鑰，也不在前端保存共用碼／token。
4. 每次 API 檢查 session 的明確到期時間；即使 KV 暫時仍回傳過期項目也不能授權。讀取不延長期限、不寫 KV。預設 3600 秒；可設定 `SESSION_TTL_SECONDS` 為 1–604800 秒。KV expirationTtl 至少 60 秒，短期限測試仍由 Worker 與 Cookie 依實際期限執行。
5. 登出刪除 KV session 並清 Cookie。受保護讀取、登入回應及靜態頁面使用 `Cache-Control: no-store`；所有回應無敏感日誌。POST 要求同源 Origin；頁面 CSP 禁止外部資源與嵌入。原型不使用 localStorage／IndexedDB。

**KV 最終一致性也影響 session：**新登入切換網路節點時可能暫時查不到；登出／刪除 session 也可能延遲撤權。登入失敗時不得繞過驗證或讀公開備份。清除本機 Cookie 不能撤回另一份被盜 Cookie，直到伺服器刪除傳播或明確到期。只換共用碼也不會撤銷既有 session；調小 TTL 不會縮短已發出的 session。此原型沒有全體撤權世代、管理者帳號、稽核與正式防濫用策略。

登入有每 IP 每分鐘 5 次限制：若綁定 `LOGIN_LIMITER` 使用平台 Rate Limiting binding；否則只用每 isolate 的記憶體限制（Map 上限 1024）。**後者可用於高熵碼的隔離測試，不能作正式分散式防暴力破解保證。**平台限速也不是全球精確計數；醫院共用 IP 可能一起被限速。正式接入前應確定平台 binding 與門檻，不使用 KV 非原子計數。提供的 `wrangler.jsonc.example` 已示範可選 binding，但本次沒有執行 Wrangler 或驗證該 binding。

## 本機建置與測試

需要 Node.js（支援全域 Web Crypto、Fetch；本次使用桌面內建 Node）、OpenSSL；瀏覽器測試另需要既有 Playwright 與 Chrome。無需 npm install，無任何網路操作。

從專案根目錄：

```sh
node prototypes/cloudflare-v08/build.mjs --setup-local
node --test prototypes/cloudflare-v08/worker.test.mjs
node --test prototypes/cloudflare-v08/browser.test.mjs
node prototypes/cloudflare-v08/serve-local.mjs
```

若 `node` 不在 PATH，可用 Codex 內建 Node 的絕對路徑。若 Playwright 不在預設路徑，以 `NODE_PATH` 指向既有安裝；Chrome 路徑可用 `CHROME_PATH` 指定。本機服務只綁 `127.0.0.1` 隨機埠，終端顯示 `https://localhost:<port>`。

`build.mjs` 產生以下 **Git 忽略** 的檔案：

| 檔案（本目錄 dist/ 下） | 用途 |
| --- | --- |
| `worker.mjs` | 可貼進 Dashboard 的單檔 ES Module，含頁面與驗證器，無班表／密碼／金鑰 |
| `synthetic-a.json`、`synthetic-b.json` | 唯一測試班表，全為合成身分 |
| `synthetic-manifest.json` | A／B 原始字串 SHA-256，用於 KV 觀測 |
| `local-secrets.json` | `--setup-local` 才建立；隨機碼及其 SHA-256，權限 0600，既有檔案不覆寫，不印出內容 |

請只在本機檢視 `local-secrets.json`，不要截圖、提交或貼到聊天。它不會被打包。`.dev.vars*`、`.wrangler/` 與 `dist/` 均在本目錄的 `.gitignore` 內。請勿對這些檔案使用 `git add -f`。

`local-harness.mjs` 使用 Node HTTPS＋記憶體 KV，**不是 workerd／Wrangler，也不連真實 KV**。本機自簽憑證私鑰及 Chrome profile 放在系統暫存目錄。自動測試只在該測試 browser context 忽略自簽憑證錯誤，不改系統信任設定。手動開啟時只對 localhost 測試頁接受例外，結束以 Ctrl+C 停止。記憶體 KV 重啟會清空，重啟後需重新登入。

目前測試包括：

- 10 項 API／KV 邊界測試：匿名禁止、錯誤碼、Cookie 屬性與不透明 token、到期、篡改 Cookie、登出、Origin、HTTPS、大小限制、錯誤 schema／一般身分拒絕、設定與 KV 故障、限速與受控舊版本。
- 1 項真實 Chrome HTTPS 整合：登入、HttpOnly 無法由 document.cookie 讀取、持久 Cookie 關閉並重開瀏覽器仍可用、頁面自動載入、伺服器到期拒絕並清畫面、登出、只發同源請求、A→B 觀測流程。
- 到期測試刻意讓 KV 仍保留已過期 session，驗證 Worker 本身的時間檢查；不宣稱已測試真實 KV TTL。

## 你在 Cloudflare 最少需要做的事（本次尚未執行）

**不需要把帳號、密碼、Global API Key 或 token 給 Codex。**最小操作路徑是你登入現有 Dashboard，只操作既有測試 Worker／KV；本次不要求任何 API 授權，也不需要信用卡、付費訂閱、自訂網域或 GitHub 連線。

待你確認可以部署時：

1. 選定 **`nss-ssf-v08-test`**，確認現有 binding `SCHEDULE_KV` 指向 **`nss-ssf-v08-test-kv`**，不是其他 namespace。
2. 在該 Worker Settings 的 Variables and Secrets 新增 **Secret** `ACCESS_CODE_SHA256`，值取自本機 `dist/local-secrets.json` 同名欄位。共用碼本身不要貼入程式碼。可加一般變數 `SESSION_TTL_SECONDS=3600`；不設也預設一小時。依 Dashboard 提示儲存／套用。
3. 在該測試 KV 建立 **`schedule:active`**，value 貼入本機 `dist/synthetic-a.json` 的**完整原始文字**，不是 JSON 檔名或包在字串裡的 JSON。不要上傳 `local-secrets.json`。以文字方式建立／更新即可。
4. Edit Code：以 `dist/worker.mjs` **完整替換**測試 Worker 的 Hello World；使用 ES Module 的 `export default`，不要加 service-worker `addEventListener` 包裝。僅當你確認後按 Dashboard Deploy。本工具沒有自動做此步。
5. 直接開啟 `https://nss-ssf-v08-test.taichuan09930001.workers.dev/`，先確認未登入讀 `/api/schedule` 是 401，再以本機 `accessCode` 登入；確認到期時間、重開瀏覽器、自動載入與登出。iPhone Safari 也需測試。密碼欄是測試碼，不是 Cloudflare 登入密碼。

若之後改用 CLI，`wrangler.jsonc.example` 只是一份待填的範例，不會自動讀取或部署；應在你本機完成授權，不分享 token。需要的權限限於指定帳號的 Worker 腳本及測試 KV 管理；不要使用 Global API Key。Cloudflare 權限是否可再縮小到個別資源須依實際授權介面確認，不假設 token 能精確限縮到單一 Worker。

### 真實到期與更新觀測

- 到期：將測試 Worker 的 `SESSION_TTL_SECONDS` 暫設 `60` 並套用；先登出再登入，等畫面到期時間之後按重新載入，應回登入畫面、API 401。再設回 `3600`，先登出再登入。不要假設改變 TTL 會改寫舊 session。
- 更新：先讓手機／桌面各讀 A，預熱各自節點。將觀測輸入填入 manifest 中 **B** 的 `sha256` 並開始；在 Dashboard 將 `schedule:active` **覆寫為 synthetic-b.json 完整文字**，記錄按下儲存的 UTC 時間。不要改 key 名稱。
- 頁面每 10 秒授權讀取一次，最多 121 次，列出觀察時間、按開始後經過秒數、Cloudflare `colo` 與 revision。首次看見 B 後停止；可手動停止。若觀測期間 session 到期，就停止並要求登入。
- 以「首次 B 的 observedAt 減 Dashboard 寫入時間」作延遲估計；按開始後秒數不是寫入延遲。10 秒取樣有取樣誤差，Dashboard 人工記時也有誤差。同一人可能只碰到同一個節點，建議 Wi-Fi／行動網路或不同地點測試，不宣稱單一結果代表全球。
- Worker 讀班表用 `cacheTtl:30`（目前 KV 最小值）；session 不指定，依 KV 預設行為。`no-store` 不會清 KV 內部快取，強制重新整理頁面或加 query 也不會強迫讀到最新值。Cloudflare 說明可能延遲 60 秒以上，不能保證上限。記錄結果後可覆寫回 A 測回滾，不必做多 key 指標切換。

## 免費方案與尚待實測

- 只需 Workers Free＋KV。沒有 R2、資料庫、付費 Access、自動 GitHub build 或其他付費服務。
- 每次登入約 1 KV write；session 查詢約 1 read；班表讀取約 2 reads；登出至多 1 read＋1 delete。原型不滑動續期。每日 1000 KV writes 也限制當日可建立 session 的量，不適合高頻重登入壓測。
- 最長一次觀測約 121 Worker requests、242 KV reads，不計登入及頁面。公開頁面和 app.js 也由 Worker 程式提供，會計入動態請求額度。
- 本次產物約 44 KB，A／B 各約 3.3 KB；應用自行限班表為 256 KiB，遠低於 KV 25 MiB 限制。免費 KV 1 GB 足夠本原型。
- Node 通過不代表 Workers 每次 10 ms CPU 限制已通過。必須在測試 Worker 驗證 Web Crypto、KV binding、Cookie、secret、CPU metrics、真實更新與刪除延遲；未實測前不能承諾所有環境通過。
- 只在測試 namespace 使用合成資料；本原型不是正式發布／權限服務，仍需評估院方資料保管政策、正式限速、撤權與管理流程。

官方依據（2026-10-20 查核）：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[KV 價格](https://developers.cloudflare.com/kv/platform/pricing/)、[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)、[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
