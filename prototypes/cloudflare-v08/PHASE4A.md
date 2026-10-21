# V0.8 Phase 4A：獨立管理者匯入與預覽

此文件記錄 Phase 4A；目前發布與基本安全防護已於 [Phase 4B](PHASE4B.md) 增量實作，現行行為請參考該文件。

本階段僅為 `dev/v0.8` 本機開發，沒有部署、Commit 或 Push。根目錄 GitHub Pages 首頁、護理師流程、解析器、驗證器與換班演算法均不變。

## 操作與資料邊界

1. 由同源 `/admin` 進入，後端先驗證管理者 Session；未登入轉至 `/admin/login`。管理頁的 `/admin/`、`/admin.html` 別名也受相同驗證。登入頁可公開，JS/CSS 不含私人資料。
2. 使用獨立管理者存取碼登入後，在瀏覽器選 PDF／XLSX／XLS；多工作表時選擇其中一張。原始檔、解析資料與日期修正只保留在頁面記憶體，不 POST 至 Worker、不寫 localStorage 或 KV。
3. 沿用 `PdfParser`、`ExcelParser`、`Model`、`Validator` 與 `ImportConfirmation`。管理頁以 `autoCorrect:false` 初始化，不能自動接受日期誤植。接受一個建議後，沿用既有轉接層修正所有對應頁面欄位，保留原始日期、班別、來源與修正紀錄，不改 PDF。
4. 優先辨識標題中唯一、完整且相差 27 天的 `YYYY-MM-DD ~ YYYY-MM-DD`（亦接受 ～／至／—／–／to）；無法唯一辨識時，提供最後 28 天作建議，明示需要核對。可調起始日，結束日固定 +27 天。**建議不等於確認**，管理者必須按「確認四週期」。
5. 確認區只有四項：週期起訖、未解決關鍵錯誤、完整唯讀班表、停用的確認發布。錯誤依代碼集中呈現，可展開定位來源；不另顯示警告／解析報告。未知班別、衝突、日期缺漏、未確認日期建議等均阻擋確認通過，不會因未顯示警告而略過驗證。
6. 預覽包含全部已辨識日期及全部已解析人員。藍色為正式四週期，灰色為週期外日期；不裁切週期外計算資料。儲存格懸停可檢視原文／來源，衝突顯示各來源值。PDF 未映射欄位另標為未辨識；不能可靠對應的值不猜測，錯誤仍阻擋。沒有逐格或逐人班別編輯。這是解析結果預覽，不是 PDF 版面複製；既有解析器不支援的格式仍須修正來源檔。
7. 換檔／換工作表清除舊預覽；過時的非同步解析結果不可回填。登出、Session 到期、頁面轉背景或 BFCache 恢復均清除本機檔案參照與預覽，回前景重新驗證後才允許匯入。背景清除是刻意的資料保護措施，返回後需重新選檔。
8. 「確認發布」無條件停用；沒有發布事件或發布 API，所有未知 `/api/admin/*` 回 404。只有登入／登出會寫入或刪除 **Session**，不寫 `schedule:active`。4B 才能加入後端管理者授權、重新驗證與成功儲存後的單一有效班表切換，不信任前端確認旗標。

## 管理者驗證與防暴力猜測

- `ADMIN_ACCESS_CODE_SHA256`：獨立 Cloudflare Secret，格式為管理者隨機存取碼的 SHA-256 十六進位雜湊。不得與護理師 `ACCESS_CODE_SHA256` 相同；不能放在前端、設定檔或 Repository。
- 管理者憑證須用密碼學亂數產生（至少 24 bytes，轉 base64url 為 32 字元；建議 32 bytes），交由管理者安全保管。**不可使用短碼或人類自訂弱密碼**；SHA-256 不適合作為一般弱密碼的密碼雜湊。此階段沒有註冊、忘記密碼或多帳號系統。
- 管理 Cookie `__Host-nss-ssf-admin`：256-bit 隨機 token，HttpOnly、Secure、SameSite=Strict、Path=/，與護理師 Cookie 分離。KV 僅存 token 雜湊索引 `admin-session:*` 和 role/admin、建立與到期時間。預設一小時，`ADMIN_SESSION_TTL_SECONDS` 可設 1～3600 秒；伺服器每次讀取會驗證 role 與絕對期限。重新登入輪替舊 Session，登出刪除 Session；不能使用護理師 Cookie 通過管理驗證，反之亦然。
- 管理登入必須有 `ADMIN_LOGIN_LIMITER` 平台 Rate Limiting binding；缺少 binding、設定錯誤或限速服務拋錯均拒絕服務，不使用 KV 計數，也沒有本機 Map fallback。每次登入依 IP 及單一管理者帳號 key 各檢查一次，涵蓋正確與錯誤憑證，超限回 429／Retry-After:60。
- 產物範例每個 key 每 60 秒最多 5 次，namespace `8809` 僅是 rate limiter 的整數識別碼，不是 KV ID；實際使用前須確認該帳號未被其他 binding 占用。共用 IP／惡意流量可能造成管理者暫時被限速。
- 精確 Origin、HTTP method、JSON 類型與串流大小上限檢查保留；CSP、禁止 framing、no-store 及安全文字渲染套用到管理頁。管理檔案匯入不呼叫班表 API。

**正式啟用前的阻擋事項：防暴力猜測尚未完成實際平台驗證。** Cloudflare 的 Rate Limiting binding 為各機房獨立、近似且最終一致，不能宣稱全域精確次數或保證第六次必定阻擋。本機測試只驗證呼叫與 fail-closed 路徑。必須先在授權的測試環境確認 binding、429／錯誤時拒絕登入、實際 IP、分散來源及暴力登入風險；若要求跨機房嚴格封鎖，須加強一致性限流（例如 Durable Object）或受管管理者身分驗證，再正式開放，不能改用 KV 精確計數補洞。本階段不新增付費服務或這些額外服務。

另外，KV Session 建立／刪除可能有跨機房可見延遲；到期仍有後端絕對時間檢查，但不能承諾登出即刻在全球撤銷。管理 Secret 輪替目前不自動撤銷所有既有 Session，須等期限或另行撤銷。若 4B 需要立即全域撤銷，必須先換用合適的強一致驗證／撤銷機制。未部署前仍需實際驗證安全 Cookie、資源路由與 Session 行為。現有公開班表 API 的 synthetic-only 限制仍保留，不可視為已允許真實資料上線。

參考：[平台 Rate Limiting 的 locality 與 accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[Static Assets HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)。本次僅依文件設計，未操作帳號。

## 建置與測試

```sh
node prototypes/cloudflare-v08/build-integrated.mjs
node --test prototypes/cloudflare-v08/admin.test.mjs
```

未來建置／測試此平台 binding 需 Wrangler 4.36.0 以上；仍須在現有 Free 帳號確認可用性與額度，未啟用任何付費服務。

新建置包在受忽略的 `dist/ssf-<隨機>/`，只加入公開管理頁 HTML／JS／CSS。保留原 Worker 名稱 `nss-ssf-v08-test`、`SCHEDULE_KV` 與 `keep_vars:true`；Namespace ID 維持待填，不複製本機舊產物或任何 Secret。既有已部署網站不因本機建置改變。

`run_worker_first:true` 確保靜態頁不能繞過驗證；`html_handling:'none'` 停用平台自動 HTML 改址，由 Worker 明確映射 `/` → `/index.html`、`/admin` → `/admin.html` 及登入別名。不可在實際部署時移除此設定或改為讓資源優先回應。

新增測試使用測試時產生的隨機憑證、MemoryKV／ASSETS／limiter doubles、合成 PDF（含三頁日期誤植）、Excel 與本機 HTTPS Chrome，涵蓋未授權存取、獨立角色、錯誤密碼、Origin、限速／設定失敗、Session 輪替／到期／登出、四個確認項目、多工作表、全部日期與週期區分、唯讀／XSS、錯誤阻擋、明確日期修正、非同步競態、Session 失效清除、無發布 API、無檔案 POST、無班表 KV 寫入。完整回歸需執行既有 `tests/*.test.cjs`、Cloudflare 原型測試及 Python Pages／server 測試；瀏覽器測試需 Playwright、Chrome、OpenSSL 和允許 localhost 監聽的環境。

本次本機驗證：Node 完整回歸 116／116 通過（含新增管理者測試 3 項），Python Pages 9／9、server 3／3 通過。補強管理頁網路失敗與登出情境後，管理者 3 項再次全部通過。`git diff --check` 通過。所有測試僅使用合成資料；實際 Cloudflare 防暴力登入／跨機房與原生 ASSETS 行為仍未驗證。
