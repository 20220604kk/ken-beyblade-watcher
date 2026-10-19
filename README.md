# Ken Beyblade Watcher｜戰鬥陀螺監控與自動下單

私人開發交接版本：整合 FUNBOX、誠品、台灣購物網站、日本商品來源、日亞單品任務、Discord／LINE 通知與 Windows 控制程式。沒有新增開源授權，請勿把私人部署資料放入 Git。

**公司 Codex 請先讀 [完整移交文件](docs/HANDOFF_2026-10-19.md)，再讀 [操作安全規則](AGENTS.md)。**

本版本從目前家用正式專案匯整，保留完整程式與去識別化的離線回歸測試；不是包含帳密／Cookie／訂單的整機備份。家裡的執行目錄與運行設定未被這次匯出修改。

## 功能與架構

```text
FUNBOX／誠品／購物網站／日本網站／日亞／Chrome 連接器
                         ↓
                  商品解析與監控基線
                    ↙            ↘
             Discord／LINE      派單總管
                                 ↓
                  黑白名單 → 優先級 → 帳號／配送／限購
                                 ↓
                   帳號獨立佇列 → 結帳 → 查單／帳本
                                 ↓
                  網頁控制台／Windows 桌面小程式
```

| 模組 | 主要內容 |
|---|---|
| FUNBOX | 搜尋、分類、集合三來源；新品／庫存變化；API 帳號派單、單品／合單 |
| 誠品 | 策展優先、搜尋與既有商品基線；帳號購買限制、登入恢復及 API 結帳 |
| 購物網站 | momo、墊腳石及其他既有適配來源；蝦皮／愛電王連接器 |
| 日本網站 | 日本搜尋／商品來源、樂天集合與單品、OCN／Nojima／日本玩具反斗城等 |
| 日亞 | 一般商品監控與 A/B/C 單品下單分離；自營／日圓原價／運費核對、02 快照、未送單有限重試 |
| 本機管理 | `127.0.0.1:3210` 控制台、Windows 啟停／守護／桌面控制器 |

外站 API 是對現行官網契約的適配，不代表平台提供穩定、公開或保證可自動購買的介面；驗證、限流與缺貨不得繞過。

## 乾淨安裝（Windows）

1. 安裝 Node.js（目前驗證版本 24.15.0）與 Google Chrome。程式／測試多處使用 `channel: 'chrome'`，只有 Playwright Chromium 不夠。
2. 複製此私人儲存庫，先不要搬入家用設定或啟用下單。
3. `npm ci`，必要時 `npx playwright install chromium`。雙擊 `install.bat` 亦可建立缺少的範例設定，但採 `npm install`，重現版本優先用 `npm ci`。
4. 從 `.env.example`、`config.example.json` 建立本機 `.env`、`config.json`。範例監控與自動下單預設關閉。
5. 先跑檢查／測試，再雙擊 `01_啟動監控.bat` 或執行 `npm start`。不要在同一台同時使用兩種入口啟動兩份服務。

商品試算表由 `.env` 的 `PRODUCT_CATALOG_SHEET_ID`／`PRODUCT_CATALOG_SHEET_GID` 選配，不內建原作者的社群表格。

## 操作與驗證

| 入口 | 用途 |
|---|---|
| `01_啟動監控.bat` | 啟動監控 |
| `02_重啟監控.bat` | 重啟；先確認沒有送單／未決交易 |
| `03_開啟監控網頁.bat` | 只開網頁；關閉網頁不等於停止監控 |
| `04_強制停止監控.bat` | 緊急停止，平常優先用桌面小程式 |
| `scripts/build-monitor-control.ps1` | 從原始碼建置桌面控制器；exe 本身不是整套可攜軟體 |
| `npm run check` | 所有程式語法、相對匯入與控制台內嵌腳本檢查 |
| `npm run test:offline` | 依序跑回歸測試；不需要真實帳號、Webhook 或訂單 |
| `npm run test:commerce` | FUNBOX／誠品多角度離線驗收 |
| `npm run audit:distribution` | 檢查 Git 待發佈內容不含私密檔案／已知敏感格式 |
| `npm run verify:handoff` | 在隨機本機 port 與臨時目錄驗證乾淨啟動／網頁；不使用正式設定或帳號 |

部分 `scripts/amazon-*.mjs` 是過往實驗工具，可能操作登入容器、購物車或交易；**不是安裝或驗收步驟，不要批次執行。**

## 資料與承接邊界

| 路徑 | 是否入 Git | 說明 |
|---|---|---|
| `src/`、`extensions/`、`test/`、`scripts/`、`docs/` | 是 | 程式、合成測試、工具與文件 |
| `assets/reference/` | 是 | 去除私人路徑的歷史價格參考，非即時報價 |
| `.env`、`config.json` | 否 | 通知密鑰、個人設定 |
| `data/`、`records/`、`logs/`、`artifacts/` | 否 | 帳本、帳密、登入資料、實測證據、建置產物 |
| `node_modules/`、exe／dll | 否 | 由鎖定依賴與建置腳本重建 |

公司與家裡的跨機同步／自動接管 **尚未實作**。目前交易鎖與狀態檔只保護各自的本機程序，不能讓兩台複製後就同時用同一帳號下單。

`cloud/monitoring-only` 是另一路受限的監控實驗分支，不是 Windows 完整版，也不是已完成的 24/7 主機。

## 文件入口

- [完整移交：現況、安裝、架構、資料、安全接手與驗收](docs/HANDOFF_2026-10-19.md)
- [操作安全規則](AGENTS.md)
- [移交驗證結果](docs/HANDOFF_VERIFICATION_2026-10-19.md)
- [平台監控說明](docs/MONITORING.md)／[自動下單說明](docs/AUTO_PURCHASE.md)
- [日亞 HTTP 主線](docs/AMAZON_JP_API_WORKFLOW.md)／[今日 CX-20 失敗調查](docs/AMAZON_CX20_FAILURES_2026-10-19.md)
- [Windows 控制台](docs/監控控制台使用說明.md)／[日誌保留規則](docs/日誌保留規則.md)

有日期的實測文件是當時證據，不等於目前外站或帳號狀態；衝突時先讀本次移交文件，再查看當前程式與實際狀態。
