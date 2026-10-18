# 第二階段驗證 · 2026-10-19（Asia/Taipei）

僅使用已還原的雲端 `/workspace/ken-beyblade-watcher`；目前分支 `cloud/monitoring-only`。`cloud/` 與 package scripts 已存在，不需從別處重建。未切換、提交、推送或合併 main，未連接或修改使用者本機。本節記錄第二階段掃描當時的狀態；當時 cloud 檔案尚未追蹤，由還原套件保存。後續整理提交僅納入 package.json 與 cloud/ 原始碼、測試、範本及文件；執行期狀態和證據不納入 Git。

## 真實公開來源

以 `CLOUD_SCAN_ONCE=1 CLOUD_STATE_FILE=.../data/cloud/phase2-final-real.json npm run start:cloud` 啟動 Node 24.19.0（保留 `--use-env-proxy`、TLS 與平台 proxy），綁定雲端 127.0.0.1:3320。每個來源只作一次 GET、不跟隨轉址、不帶 Cookie 或登入。首輪發現 1999 UTF-8 被固定 Shift-JIS 解碼後修正，另作最終一輪；兩輪證據分開，最終每站計數皆為 1。

最終掃描時間：2026-10-19 03:18:59–03:19:01（Asia/Taipei）。JSON 保留 UTC ISO 時間。

| 來源 | HTTP | 延遲 ms（含解析及狀態寫入） | 解析筆數 | 錯誤 |
|---|---:|---:|---:|---|
| amazon | 503 | 467 | 0 | HTTP 503 |
| eslite | 200 | 631 | 1 | 無 |
| japan | 200 | 632 | 4 | 無 |
| shopping | 301 | 655 | 0 | HTTP 301 |
| funbox | 200 | 2101 | 1 | 無 |

3/5 來源成功；momo 301 未跟隨，日亞 503 未重試或繞過。不能宣稱全部真實來源健康。1999 是沿用「日拍」類別的既有 Hobby Search 1999 公開來源，並非 Yahoo 拍賣。FUNBOX 此次只解析到 APP 交換票券，解析數量不等同可購新品數量、庫存保證或新上架證據。無上架商品不是錯誤：有效解析回傳空陣列時成功並記 `emptyResult:true`；無法僅憑零筆排除未知頁面或解析漂移。

網路設定 revision 2 已列出所需公開網域；environment_status 的 network_policy.state 為 unknown，不能稱為已證實 enforced。實際 HTTP 結果才是本次可達性證據。

## 檢查與視覺證據

- `npm run check:cloud` 通過；記錄 `artifacts/cloud/check-cloud.txt`。
- `npm run test:cloud`：6 pass、0 fail；含 fail-closed、事件識別、HTTP 競速/重載、單 writer、來源隔離、誠品解析、零結果與 UTF-8 回歸。
- 初次受限 shell 無法 listen（EPERM）；改在核准的同一雲端執行權限下重跑通過，未修改網路白名單或本機。
- HTTP smoke：四個 GET 均 200；login/checkout/cart/payment/webhook/purchase 的 POST 均 404。見 `http-smoke.json`。
- Playwright 系統 Chromium 154.0.8037.57：實際渲染 API → 儀表，真實及 fixture 各五張來源卡，兩頁均 0 page errors；人工檢視 PNG 確認日文正常及錯誤清楚顯示。未使用瀏覽器掃描或繞過外站限制。

## 資料分離

- 最終真實狀態：`data/cloud/phase2-final-real.json`；6 個真實解析事件／6 筆檔案 dry-run sink，沒有對外推播。
- 真實畫面：`artifacts/cloud/dashboard.html`、`dashboard.png`；狀態 `live-status.json`。
- 首輪證據：`artifacts/cloud/phase2-first-pass.json`，包含修正前日文解碼問題，不與最終混用。
- Fixture：`data/cloud/phase2-fixture.json` 與 `artifacts/cloud/fixture/dashboard.html`、`dashboard.png`，明確 FIXTURE；一筆唯一事件、一筆 dry-run、local winner。沒有本機接入，此 local 僅測試資料。

## 安全與還原

購買、登入、Cookie、購物車、付款、Webhook、真實通知均無啟用入口；強化環境 guard 拒絕相關非關閉開關。不讀取舊 .env、帳號、Cookie 或 config.json。不提交訂單。未建立公開網站；靜態 HTML、PNG 與還原套件保留於雲端工作區。系統指定的可點開 output 根目錄 /codex 在此環境不存在且不可建立（即使核准執行仍 Permission denied，sudo 亦未安裝），因此無法產出該目錄的下載連結；已直接展示真實 PNG。服務以單輪模式保留在雲端，不排程後續外站請求；工作階段停止可能終止程序，Codex Cloud 並非永久 VPS。

還原套件含僅 cloud/monitoring-only 的 Git bundle（基底歷史）、cloud 程式及 package overlay、version 1 JSON 狀態、分開的 fixture 與真實證據；排除 node_modules、秘密、.env 與 lock。還原方法見 `cloud/RESTORE.md`，供下次雲端任務使用。原本 src、lockfile 與私人設定未修改。
