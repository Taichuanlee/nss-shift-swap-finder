# SSF v1.0.0 正式環境設定準備

基準：`release/v1.0` / `082cbb5a71da1e252d207560aac2928677b90bea`。
本目錄只提供正式部署設定與操作說明，不會自動建立資源或部署。產品程式沿用此基準。
正式 Worker 名稱為 `nss-ssf`；帳號子網域依使用者確認為 `becklee.workers.dev`。正式 KV 名稱仍為 `nss-ssf-prod-kv`，不因 Worker 改名而沿用或搬移測試資源。

## 尚未啟用的設定

`wrangler.production.jsonc.example` 是有意保留占位符的範本，不能直接部署。
以下資訊必須在後續獲准建立／核對正式資源後填入，不能用測試值補齊：

| 設定 | 正式值／要求 |
| --- | --- |
| Worker | `nss-ssf` |
| 帳號 | `account_id` 填入操作者核對過的 Cloudflare 帳號 ID |
| KV | 全新 `nss-ssf-prod-kv` 的 namespace ID，初始無任何 key |
| 護理師 limiter | `LOGIN_LIMITER`，50 次／60 秒，填帳號內確認未使用的正整數字串 ID |
| 管理者 limiter | `ADMIN_LOGIN_LIMITER`，5 次／60 秒，另用未使用的正整數字串 ID |
| Secrets | `ACCESS_CODE`、`ADMIN_ACCESS_CODE`；由操作者新設，彼此不同，且均不同於測試密碼 |
| 一般變數 | `SYNTHETIC_ONLY=false`，兩種 Session TTL 均 3600 秒 |
| 靜態資源 | `ASSETS` → 同一正式包的 `./public`，`run_worker_first=true`、`html_handling=none` |
| 網址 | 預期 `https://nss-ssf.becklee.workers.dev/`；建立後確認，不硬編碼進前端 |

`preview_urls=false`；不設定自訂網域、routes、遠端測試 binding 或環境繼承。
`keep_vars=false` 讓此獨立設定明確管理一般變數；不要用 Dashboard 隱藏值覆蓋這份設定的期望。
Secrets 欄只列名稱，不存密碼；它不會自動產生或設定 Secrets。

## 防止誤部署至測試環境

原本 `prototypes/cloudflare-v08/build-integrated.mjs` **仍產生測試用 wrangler.jsonc**，本次不修改它。
正式包只複製 `worker.mjs`、`public/`、`asset-inventory.json`，不複製原產物的設定、KV、Session、班表、Secrets、`.dev.vars*`、`.env*` 或 `.wrangler/`。
禁止直接在既有測試產物目錄執行裸的 `wrangler deploy`，也不要把整個來源目錄／dist 當正式包。

之後獲准準備可部署包時，從 repository 根目錄執行以下**僅本機**步驟：

```sh
node prototypes/cloudflare-v08/build-integrated.mjs
# 將上一行回報的全新產物目錄填入；不要填歷史部署包。
SSF_RELEASE_SOURCE='/absolute/path/to/new/ssf-build'
SSF_PRODUCTION_PACKAGE="$(mktemp -d /private/tmp/ssf-prod-XXXXXX)"
cp "$SSF_RELEASE_SOURCE/worker.mjs" "$SSF_PRODUCTION_PACKAGE/worker.mjs"
cp -R "$SSF_RELEASE_SOURCE/public" "$SSF_PRODUCTION_PACKAGE/public"
cp "$SSF_RELEASE_SOURCE/asset-inventory.json" "$SSF_PRODUCTION_PACKAGE/asset-inventory.json"
cp deployments/production/wrangler.production.jsonc.example "$SSF_PRODUCTION_PACKAGE/wrangler.production.jsonc"
```

只在新正式包內補齊 account、全新 KV 與兩個 limiter ID。範本與測試設定都不改成實際正式憑證。
完成後先執行以下獨立設定檢查；任何一項失敗即停止，不執行部署。
先在本機設定環境變數 `SSF_TEST_KV_ID` 為目前測試 KV 的 ID，供禁止誤綁比對；不要將實際值寫入設定、文件或提交 Git。未提供時檢查會拒絕繼續。

```sh
python3 - "$SSF_PRODUCTION_PACKAGE/wrangler.production.jsonc" <<'PY_CHECK'
import json, os, re, sys
from pathlib import Path
p = Path(sys.argv[1]).resolve()
c = json.loads(p.read_text())
def require(ok, message):
    if not ok:
        raise SystemExit(message)
require('REPLACE_WITH_' not in json.dumps(c), '尚有未填設定，停止。')
require(c.get('name') == 'nss-ssf', 'Worker 目標不是正式環境，停止。')
require(re.fullmatch(r'[0-9a-f]{32}', c.get('account_id', '')), '帳號 ID 格式無效。')
require(not any(k in c for k in ['env', 'route', 'routes', 'services', 'dispatch_namespaces', 'unsafe', 'build']), '有額外環境或執行目標設定，停止。')
kv = c.get('kv_namespaces', [])
require(len(kv) == 1 and kv[0].get('binding') == 'SCHEDULE_KV', 'KV 綁定不符。')
require(re.fullmatch(r'[0-9a-f]{32}', kv[0].get('id', '')), 'KV ID 格式無效。')
test_kv_id = os.environ.get('SSF_TEST_KV_ID', '')
require(re.fullmatch(r'[0-9a-f]{32}', test_kv_id), '請先在本機提供 SSF_TEST_KV_ID；不要寫進設定或文件。')
require(kv[0]['id'] != test_kv_id, '禁止使用測試 KV。')
rates = c.get('ratelimits', [])
require(len(rates) == 2 and {r.get('name') for r in rates} == {'LOGIN_LIMITER', 'ADMIN_LOGIN_LIMITER'}, '限速綁定不符。')
ids = [r.get('namespace_id', '') for r in rates]
require(all(isinstance(i, str) and re.fullmatch(r'[1-9][0-9]*', i) for i in ids), '限速 ID 須為正整數字串。')
require(len(set(ids)) == 2 and not set(ids) & {'8808', '8809'}, '限速 ID 重複或沿用測試 ID。')
require(all(r.get('simple') == {'limit': 50 if r['name'] == 'LOGIN_LIMITER' else 5, 'period': 60} for r in rates), '限速額度不符。')
require(c.get('vars') == {'SYNTHETIC_ONLY': 'false', 'SESSION_TTL_SECONDS': '3600', 'ADMIN_SESSION_TTL_SECONDS': '3600'}, '正式變數不符；不得加入密碼。')
require(c.get('secrets') == {'required': ['ACCESS_CODE', 'ADMIN_ACCESS_CODE']}, 'Secret 名稱不符。')
require(c.get('main') == 'worker.mjs' and (p.parent / 'worker.mjs').is_file(), '正式 Worker 檔案缺漏。')
require(c.get('assets') == {'directory': './public', 'binding': 'ASSETS', 'run_worker_first': True, 'html_handling': 'none'}, 'ASSETS 設定不符。')
require(c.get('workers_dev') is True and c.get('preview_urls') is False and c.get('keep_vars') is False, '正式部署選項不符。')
require([x.name for x in p.parent.glob('wrangler*')] == ['wrangler.production.jsonc'], '正式包有其他 Wrangler 設定，停止。')
expected = set(json.loads((p.parent / 'asset-inventory.json').read_text()))
actual = {x.relative_to(p.parent / 'public').as_posix() for x in (p.parent / 'public').rglob('*') if x.is_file()}
require(actual == expected, '公開資源清單不符，停止。')
print('本機設定檢查通過；資源存在、ID 未占用及 Secrets 仍須由 Cloudflare 操作者核對。')
PY_CHECK
```

獨立檢查通過後才做 `wrangler deploy --dry-run --config "$SSF_PRODUCTION_PACKAGE/wrangler.production.jsonc"`。
Wrangler dry-run **可能接受占位符或不存在的資源 ID**，因此不能省略上面的檢查。
兩種檢查都不代表資源存在、ID 未被占用、Secrets 已設定或正式部署已完成。
任何占位符尚存、Worker 名稱不是 `nss-ssf`、KV 指向測試 namespace、兩個 limiter 相同或仍是 `8808`／`8809`，都不得部署。
只指定正式設定檔，不用 `--name`、`--env`、`--var` 或 `--assets` 另行覆蓋目標。
新正式包不得包含其他 `wrangler.json*`，避免自動選到測試設定。實際部署命令留到另次授權才執行。

## Cloudflare 手動操作（下一階段，尚未執行）

1. 登入並核對帳號。確認 `nss-ssf` 尚不存在；若已存在，先確認用途，不覆寫、不改綁現有服務。
2. 建立**全新** KV namespace `nss-ssf-prod-kv`，記錄其 ID，確認 key 清單為空。相同名稱若已存在不等於全新；不要直接接上舊 namespace。
3. 核對帳號內所有 Workers 的 limiter bindings，包含其他環境及可能再啟用的舊部署設定；選兩個未使用且彼此不同的 ID，記錄用途。`8808`／`8809` 保留給測試。檢查不完整時不宣稱 ID 可用；部署前再次核對，這些 ID 並未因寫入範本而被保留。
4. 建立獨立 Worker `nss-ssf`（與正式程式部署是不同步驟）。只在它的 Settings → Variables and Secrets 新設兩個 Secret：`ACCESS_CODE`、`ADMIN_ACCESS_CODE`。不要從測試 Worker 複製、匯出或讀出舊值；操作者自行輸入新的不同密碼。不要加入舊的 `ACCESS_CODE_SHA256`。設定 Secrets 可能產生設定部署，留待此階段另次授權。
5. 依範本補齊、核對正式包；之後另次授權，才將 Worker 程式與 ASSETS 一起部署。兩個 limiter bindings 透過正式設定套用；不是複製測試 binding。
6. 核對正式版本的 Worker 名稱、account、KV、limiter ID／額度、Secret **名稱與類型**、一般變數、ASSETS 和實際 workers.dev 網址。不要把 Secret 值貼進文件、指令紀錄或聊天。
7. 首次驗收：未登入班表 API 應 401；正式 KV 仍無班表時，登入後應顯示尚無班表，不回退到測試資料。測試 Cookie／Session 不應在正式環境有效；護理師憑證不能發布。確認後才由正式管理端重新審核、發布一份班表，不搬移測試 `schedule:active`。

不變更測試 Worker、測試 KV、測試密碼、測試 limiter 或 GitHub Pages。正式與測試共用 Cloudflare 帳號額度，須另核對實際用量。

## 已檢查的環境相依項目與限制

- 護理端及管理端都以 `/api/...` 和 same-origin credentials 呼叫，沒有硬編碼測試 workers.dev 網址；ASSETS／API 由正式 Worker 同源提供。
- Worker 護理師 Cookie 名稱仍是 `__Host-nss-ssf-test`。這是內部名稱，不代表請求送到測試環境；沒有 Domain 屬性，瀏覽器限定目前主機。正式與測試使用不同主機、空白獨立 KV、新密碼，因此不搬移也不共用 Session。本次不改 Cookie 或驗證程式。
- 依使用者決定，登入提示「請輸入內科電話號碼」與 numeric inputmode 維持原樣；正式 Secrets 仍須獨立新設，**不得沿用測試密碼**。本次不改產品 UI。
- `SYNTHETIC_ONLY=false` 只關閉合成資料限制，並不匯入任何資料、不跳過班表驗證。已知 PDF 解析限制保留至下一版；發布前仍需核對可靠來源。
- 程式回滾不會回復 KV 班表。未來備份只保存必要的正式班表於受控位置，不備份／搬移 Session 或測試資料。

## 官方設定依據

- Wrangler 設定：https://developers.cloudflare.com/workers/wrangler/configuration/
- 同源 Static Assets：https://developers.cloudflare.com/workers/static-assets/binding/
- Rate Limiting：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ （同帳號相同 namespace ID 可能共用計數）
- Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
