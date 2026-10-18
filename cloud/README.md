# Linux / Codex Cloud monitoring-only

獨立分支 `cloud/monitoring-only`。原本 `src/index.js`、購買模組與 UI 原始碼未修改。不要用 `npm start` 啟動雲端版。

需要 Node.js 24（使用 `--use-env-proxy` 遵循雲端 HTTPS proxy）及 `npm ci`。瀏覽器僅供畫面驗證，使用已安裝且驗證過的 `/usr/bin/chromium`；監控本身只有無憑證的公開 GET，不啟動 Chrome、不使用登入、Cookie、購物車、付款、送單或 Webhook。Chrome 來源不可用時降級為 HTTP-only，不嘗試繞過驗證頁。系統瀏覽器缺失不影響監控服務。

```sh
cd /workspace/ken-beyblade-watcher
npm ci --cache /workspace/.npm
npm run check:cloud
npm run test:cloud
npm run start:cloud
```

預設雲端專用埠 3320，僅綁定雲端 loopback；禁止使用 3210。`cloud/env.example` 列出可設定變數，使用 shell export 注入；不載入舊 `.env`、`config.json`、登入檔或私人成交資料。無購買 API，任何未知路徑回應 404，購買設定/開關有 fail-closed 檢查。原本採購程式只被保留，不由雲端入口載入。公開解析模組可能匯入通用通知函式，但入口從未呼叫它們；只有檔案 dry-run sink。

每站獨立執行，請求 12 秒 timeout，完成後等 60 秒再掃描。五個預設來源：FUNBOX 分類 JSON、誠品 Holmes 搜尋、momo HTML、1999 HTML、日亞官方賣家搜尋 HTML。沿用原解析函式；不是原監控器的完整瀏覽器、策展、多頁、MSRP 或商品規格深查流程。有效解析的零筆商品是成功結果；驗證頁、HTTP 非 2xx 與解析例外分別記錄降級。零筆仍不能排除未知頁面或解析漂移。站點各自記錄最後掃描、延遲、成功/失敗、最新商品與錯誤。`/health` 表示服務存活，`sourcesHealthy` 才是當前成功站數，並不代表全部來源健康。

## HTTP / 檔案契約

- GET `/health`、`/api/cloud/status`、`/api/cloud/events`、`/`。
- POST `/api/cloud/events`：JSON 物件，必填 `source` (`cloud`/`local`)、`site`、`productId`、`stockSignature` 字串、`price` 字串或數字、ISO `observedAt`；選填 `title`。16 KB 上限。只接受事件，不接受遠端網址或購買指令。
- 檔案輸入：`CLOUD_PORT=3320 npm run import:cloud -- path/to/events.json`，單事件或事件陣列，透過同一 HTTP 接收器，不競爭寫 state。連接器只連此雲端專用埠，拒絕 3210。
- 原子狀態：`data/cloud/state.json`，含事件、站點與 dry-run sink。單程序序列化交易、temp file + fsync + rename；同狀態檔第二個程序因 lock 拒絕啟動。損壞 JSON fail-closed，不自動清空。
- 若程序遭強制終止，lock 可能殘留；先確認 lock 內 PID 已不存在且不是其他服務，再手動移除該 lock，勿刪 state。不可對同 state 以多個主機/檔案同步工具同時寫入。

`eventId = SHA256(JSON.stringify([lowercase(trim(site)), NFKC(trim(productId)), stockSignature, trim(String(price)), floor(observedAtMs/60000)]))`。雙端必須採同商品 ID、庫存簽章與價格格式；來源不在雜湊中。首次接受才記一筆 dry-run sink，重複事件只補各端最早時間。winner 為已知最早 `observedAt`，同毫秒以來源字母順序打破平手，可能隨較早事件晚到而更新。依賴校時與可信發送端；跨分鐘邊界會產生不同事件，不是滑動窗。完整 eventId 保留供核對。這是單一接收器的 dedup，沒有聲稱兩台互不連線的主機也能 exactly-once 真實推播。

本機尚未接入；不會主動連線本機 APP。本機未接入時可獨立展示：

```sh
CLOUD_PORT=3321 CLOUD_FIXTURE=1 CLOUD_STATE_FILE="$PWD/data/cloud/demo.json" npm run start:cloud
# 另一個雲端 terminal:
CLOUD_PORT=3321 npm run import:cloud -- cloud/race.fixture.json
node cloud/visual-smoke.mjs # 同時需要 3320 真實服務；fixture 自用 ephemeral port
```

展示使用不同 state，標示 FIXTURE；同事件 cloud 先送達、local 時間早 100ms，合併為一筆，dry-run 一次、local winner。`artifacts/cloud/dashboard.html` 是無 JavaScript 的可攜式靜態畫面，PNG 是 Chromium 實際截圖；都不是公開網站或 24/7 服務。

## 範圍與部署限制

服務只綁定雲端 loopback，無對外認證或 TLS，因此不要直接暴露事件接收器到公網。未提供本機連線、公開反向代理、真實通知、購買、Webhook、Cookie 或登入。若未來需要外部雙端接入，需另建有驗證的 HTTPS 通道與時鐘同步。

Codex Cloud 並非永久 VPS；工作階段、機器、程序或網路可能終止，不能保證全天候、即時或 24/7。snapshot 保留依平台機制，最新 state 不等同外部備份。事件與 sink 目前完整保留，未做分頁/輪替，長期運行須另加保留政策。UI 顯示最近 200 筆。fixture 不是即時庫存證據。
