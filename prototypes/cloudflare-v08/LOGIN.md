# 登入密碼設定（Phase 4B 部署前調整）

此文件取代 PHASE4B/PHASE4A/PHASE3/README 中舊的長隨機碼及 SHA256 Secret 操作要求。現有登入、Session、權限隔離、限速與發布流程保留。

## 現行設定

- 護理師 Secret：`ACCESS_CODE`；管理者 Secret：`ADMIN_ACCESS_CODE`。
- Value 直接填入管理者自行決定的密碼，不需要計算雜湊。兩組應不同；相同時管理端拒絕服務。
- 兩端接受 5–128 字元，包含 5/6 位數字與英數混合；精確比對，不去空白、不轉數字，保留開頭的 0。Secret 必須使用 Cloudflare 的 Secret 類型，不放一般 vars、Git 或前端。
- Worker 僅在後端將輸入與 Secret 作 SHA-256 固定長度摘要比對；這不是以 SHA-256 儲存弱密碼的資料庫，也不是密碼強度保證。真實密碼只由 Cloudflare Secret 傳入，程式不記錄、不回傳。
- 登入提示在 `integration/central-panel.html` 的 `central-code-hint`。提示僅供閱讀，沒有額外身分驗證。修改 GitHub 的文字不會自動更新這個獨立 Worker，仍需重新建置及授權部署。
- `SYNTHETIC_ONLY` 維持字串 `true`。兩個 limiter 缺少或故障均拒絕服務；不使用 KV 計數或記憶體 fallback。

## 首次銜接

目前 Dashboard 人工回報只有舊 `ACCESS_CODE_SHA256`。新版不讀取 `ACCESS_CODE_SHA256` / `ADMIN_ACCESS_CODE_SHA256`，也不以舊雜湊 fallback。新 Secret 缺少時拒絕服務，不能直接把明文填入舊 SHA256 名稱。

部署新版前，在同一測試 Worker 加入兩個新 Secret，保留舊 Secret 供舊程式運作與必要時程式回滾。新增 Secret 的 Dashboard Deploy 會套用當下程式的設定，並不代表已部署這份本機新程式。確認兩個 limiter、KV 及新 Secret 就緒後，另經授權部署新版整合包；預期兩端既有 Session 均需重新登入。新版本驗收前不刪舊 Secret。未來若清理舊 Secret，須另行授權；回滾舊程式需舊 Secret，不能假設新明文密碼也適用。

## 未來修改密碼

1. Cloudflare Dashboard → Workers & Pages → `nss-ssf-v08-test` → Settings → Variables and Secrets。
2. 編輯 `ACCESS_CODE` 或 `ADMIN_ACCESS_CODE`，類型選 Secret，直接填新密碼，兩組維持不同。
3. 按 Dashboard 的 Deploy 套用設定，確認該版本成為目前服務版本。只 Save version 或未部署的設定不等於生效。
4. 用新密碼重新登入。無需修改程式、計算雜湊、重新建置或執行 CLI 程式碼部署；仍有 Cloudflare 設定版本的部署動作。

依據：https://developers.cloudflare.com/workers/configuration/secrets/

## Session 生效邊界

兩種 Session 均綁定目前角色密碼的 credentialTag。改護理師密碼只撤銷護理師舊 Session；改管理密碼只撤銷管理舊 Session。已部署新設定處的下一次 API 請求會拒絕舊 Session；舊程式建立且沒有新 tag 的護理師 Session、舊格式管理 Session 也不相容。

不承諾設定全球瞬時生效：舊版本仍服務、逐步部署或已開始的請求可能仍使用舊設定。已下載班表不會遠端抹除，前端也沒有新增輪詢撤權。到期仍依原絕對期限檢查。credentialTag 綁定密碼本身，若改回之前使用的密碼，尚未到期且未刪除的相符 Session 可能再次有效；若要求不可復活，須額外 session 世代設定，這次未新增。改密碼請使用不同的新值。

短數字密碼與電話提示容易被推測，平台限速是各機房近似限制，不能保證全球精確阻擋。依使用者決定接受此取捨，保留既有防護，不增加帳號或額外服務。

## 部署設定

本機建置模板已填入使用者提供的現有測試 namespace ID `745fd00938e14081823e0b5a9239ffcd`；尚未從 Cloudflare 帳號驗證。
保留 `keep_vars:true`、`ASSETS`、`run_worker_first:true`、`html_handling:none`、`LOGIN_LIMITER` 8808、`ADMIN_LOGIN_LIMITER` 8809（各 key 5/60 秒）及 synthetic-only。管理發布沿用 `admin-publish` key。部署前仍須核對帳號、ID、namespace 衝突、免費額度及全部既有 bindings。

舊部署包不包含本次變更，必須重新產生；此調整不會自行部署或修改線上設定。
