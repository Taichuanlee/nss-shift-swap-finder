# V0.8 Phase 4B：單一有效班表發布

採用既有 Worker + 私人 Workers KV，不新增 Durable Object、D1、R2、發布佇列、鎖定服務或歷史版本。僅 `dev/v0.8` 本機實作；沒有 Commit、Push 或部署。Phase 4A 文件保留為前一階段紀錄，發布行為以本文件為準。

## 管理者與護理師流程

管理者仍由 `/admin` 使用獨立管理者存取碼登入，在瀏覽器選 PDF／Excel，沿用日期修正、正式四週期確認與完整唯讀預覽。原始文件不會上傳；「確認發布」只在既有驗證通過後啟用，將 Phase 1 publication v1 JSON 傳至 Worker。正式四週期前後的全部已解析日期均保留。

送出時停用發布、換檔、工作表、日期修正及週期操作。成功後按鈕保持「已發布」，不允許再次點擊送出同一份資料；重新匯入或調整週期會重新要求確認。只有同一頁的防重複機制，沒有跨分頁／跨機房互斥鎖。

護理師保留既有登入、單位班表載入、PDF／Excel 備用及換班搜尋。開啟網站、登入或按載入更新時，仍透過 `/api/schedule` 取得同樣的 envelope 與 v1 payload。已載入的頁面不會被強制更新，換班演算法與交換規則不變。

## API 與單次更新

- `POST /api/admin/publish`：獨立管理者 Cookie、Session、Secret 設定與 Origin 驗證通過後才處理本文。護理師憑證不能發布。
- `GET /api/admin/publication`：也需要管理者權限，只回目前內容指紋與發布時間，供不確定時查詢；不回傳班表或新增管理畫面。
- `/api/schedule`：仍要求護理師 Session，所有回應 no-store。沒有公開班表檔、任意 key 查詢或發布別名。

後端以串流檢查 JSON 上限 256 KiB，再呼叫既有 `SchedulePublication.load()` 及 Validator 重新驗證；拒絕額外旗標、未知版本、錯誤日期、非完整 28 天週期、重複身分、缺班與未知代碼。另限制最多 366 個日期、1,000 位人員，姓名／編號最多 128 字元，超限拒絕而不截斷。這些是資源上限，不代表 256 KiB 能容納所有最大值的組合。

驗證後由既有 `SchedulePublication.create()` 重建標準化物件，發布時間以伺服器為準。序列化及內容指紋計算完成，再重查管理者 Session（避免讀取本文時已到期），最後只執行：

```js
await env.SCHEDULE_KV.put('schedule:active', completeValidatedJson);
```

不先刪除、不寫候選 key、不寫有效指標、不設定班表 expirationTtl、不在失敗時回寫舊版本。正常成功回應表示此 put 已獲確認，**不代表所有機房都已看到新資料**。

## 失敗、回應遺失與同步延遲

解析、授權、格式與大小檢查失敗時，尚未呼叫班表 put，舊資料不受影響。登入與登出本身仍會寫入／刪除 Session key，這不屬於班表發布寫入。

進入 KV.put 後若發生錯誤，只回 `publication_unconfirmed`，不能從例外推定「一定沒寫入」。例如 KV 已接受資料，但回應傳輸失敗，儲存內容可能已是新版。**單次 put 不等於所有故障情況都能回復舊資料；本階段不提供回復保證，也沒有備份／回復功能。**

管理頁收到逾時、網路中斷、無法解析的回應或不確定伺服器錯誤，會自動查詢一次目前內容：

- 內容與本次相同：顯示「已確認目前單位班表與本次發布內容相同」。
- 不同、暫時不存在或查詢失敗：顯示尚未確認；原發布按鈕改成「重新確認發布結果」。再點擊只會 GET，不會自動重送 POST。
- 比較忽略發布時間，只確認目前資料內容一致；不是證明某一次請求一定成功。同一內容曾發布過，也可能相同。

KV 舊快照／未存在快取可能讓查詢暫時不一致，不能據此判定失敗或再次覆寫。登出、到期、切至背景或離開頁面不會取消伺服器已收到的寫入；本機仍清除資料，並提示已送出操作可能尚未確認。

不做多分頁並行保證，應一次只開一個管理分頁發布；同時發布可能最後寫入者取代前者。同 key 每秒寫入限制也可能造成短時間重複發布失敗。跨機房更新可能需 60 秒以上，設定 `cacheTtl:30` 或 HTTP no-store 不會保證 30 秒完成同步。

## 基本安全防護

- 管理者、護理師 Cookie 與 Session key 前綴獨立，保留 HttpOnly、Secure、SameSite=Strict 與精確 Origin 檢查。
- 管理者 Session 加上與當前管理 Secret 綁定的 `credentialTag`；Secret 新設定生效後，舊 tag 無法通過。部署此版後，原 Phase 4A Session 也需重新登入。沒有世代平台、帳號管理或額外管理步驟；舊部署尚未換新設定時不能保證立即全球撤銷。
- 保留原到期時間：管理者預設一小時且最多一小時；護理師 TTL 規則不變。KV 撤銷有傳播延遲，但後端每次檢查絕對到期時間。
- 管理者登入使用 `ADMIN_LOGIN_LIMITER` 的 IP／帳號 key，發布另用 `admin-publish` key；護理師登入要求 `LOGIN_LIMITER`。缺 binding 或限速服務失敗均拒絕，移除 Worker 記憶體 fallback。平台限速仍是近似、依機房計數的基本防護，不是精確全域封鎖；可能暫時阻擋正常登入。
- 管理者存取碼須密碼學隨機產生，至少 24 bytes（本機工具使用 32 bytes），交由密碼管理器保存；不得將一般弱密碼直接套用目前 SHA-256 Secret 格式。護理師共用碼外流者可依該碼登入，已下載資料也無法遠端收回。
- Worker 不使用 console 記錄本文、密碼、Cookie、檔名、班表、內部例外或 Secret；錯誤回應不夾帶私人內容。勿另外啟用收集請求本文的除錯工具。測試程式的隨機憑證只存在執行期間，產生的本機資料均在 Git 忽略的 dist。
- 後端能確認 JSON 的結構與計算規則，不能憑 JSON 證明每個班別與原始 PDF 完全一致，也不能證明管理者實際閱讀過預覽。沿用既有解析器，不接受前端「已驗證」旗標作為證明。

測試包預設 `SYNTHETIC_ONLY='true'`，發布及讀取均只接受 `SYNTHETIC` 數字編號及「合成」開頭姓名。缺少該設定仍預設限制；**目前未使用真實資料，也未在雲端啟用私人班表**。未來通過雲端合成資料驗收並另行確認後，才由維護者把該伺服器設定明確改為字串 `'false'`；此開關不略過登入或資料驗證。不需每四週改設定或部署。

新增設定仍在既有測試 Worker，沒有開啟付費方案。建置模板保留 `nss-ssf-v08-test`、`SCHEDULE_KV`、`keep_vars:true`、Worker 優先路由與精確資源白名單；登入 limiter 各 5 次／60 秒，namespace 8808／8809 使用前應確認沒有與其他服務共用。KV 免費額度仍包含護理師 Session 操作，不能只計算每四週一次班表寫入。

參考：[KV 寫入及同 key 限制](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、[KV 最終一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[平台限速](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## Mac 本機驗收

需要 Node.js 22 以上及 macOS OpenSSL，不需 Cloudflare 登入或安裝新的服務。在專案根目錄執行：

```sh
node prototypes/cloudflare-v08/serve-integrated-local.mjs
```

終端會列出 `/admin/login`、護理師首頁、兩個私人憑證檔位置，以及本次產生的合成 PDF／Excel 路徑。密碼本身不印到終端。

1. 開啟終端顯示的管理者網址。自簽憑證只供 localhost；若瀏覽器提示，確認為本機網址後繼續。
2. 本機檢視 `dist/local-admin-secrets.json` 的 `code` 欄位登入，勿截圖、分享或提交該檔。
3. 選擇終端列出目錄內的 `synthetic-import.pdf` 或 `synthetic-import.xlsx`，確認週期與唯讀預覽，按確認發布。原始文件仍不傳送，只傳標準化 JSON。
4. 到護理師首頁，以 `dist/local-secrets.json` 的 `code` 登入，確認載入班表及換班搜尋；保留自行上傳備用。
5. 回管理頁重新匯入合成資料發布，再到護理師端按載入更新，驗證更新；按 Control+C 停止。

本機服務使用 MemoryKV／MemoryLimiter doubles，只綁 localhost，啟動時載入合成 A；發布後只存在記憶體，重啟即重設。它不證明原生限速、實際 KV 儲存或跨機房行為。每次啟動建立新的忽略目錄，私人憑證在 dist 根目錄、合成文件在產物根目錄；都不在 public 白名單，無法從網站下載。

## 自動化與後續雲端驗收

新增 `publication.test.mjs` 驗證授權隔離、伺服器重新驗證、大小上限、單次 put／不 delete、伺服器發布時間、完整 40 天、限速與 Secret 輪替、讀取本文期間 Session 失效、寫入前故障與寫後回應遺失、舊快照下不誤回復。

管理頁瀏覽器測試涵蓋完整 PDF／Excel 流程、發布前禁用、連點僅一次 POST、發布後護理師登入載入、回應遺失與 stale KV 時只讀查詢、不盲目重送、儲存失敗保留原內容。保留所有既有換班、解析與護理師整合測試。

```sh
node --test prototypes/cloudflare-v08/publication.test.mjs
node --test prototypes/cloudflare-v08/admin.test.mjs
```

瀏覽器測試需現有 Playwright／Chrome。完整回歸為既有 `tests/*.test.cjs` 與 `prototypes/cloudflare-v08/*.test.mjs`，以及 Python Pages／server 測試；Pages browser 測試需先建立 Pages artifact 並指定 PAGES_ARTIFACT_DIR。

本機通過後再另行授權部署至既有測試 Worker，以合成 A／B 驗證原生 bindings、安全 Cookie、舊 Session 失效、未授權讀寫被拒絕、限速、重新載入取得更新及實際同步延遲。測試須容許舊快照，不能把「每次重整一定立即 B」作為驗收條件。新建置包仍須重新檢查設定與 dry-run；本次未部署。

本次驗證結果：Node 完整回歸 124／124、Python Pages 9／9、server 3／3 通過。另實際啟動本機驗收入口，確認登入頁 200、管理頁未登入轉向 303、未授權班表 API 401、私人憑證與合成文件 URL 404；驗證後已停止服務。
