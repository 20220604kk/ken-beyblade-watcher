# Beyblade Watcher｜戰鬥陀螺監控儀表

專案：`D:\codex\beyblade-watcher`。控制台：<http://127.0.0.1:3210/>。

## GitHub 安裝與資料保護

儲存庫只保存程式、連接器、測試及必要文件，不保存真實帳密、登入狀態、收件人、結帳範本、訂單、日誌或實測截圖。

Windows 需先安裝 Node.js 20 以上，下載專案後執行 `install.bat`。安裝會在檔案不存在時，從 `.env.example` 與 `config.example.json` 建立本機設定；不覆蓋原有設定。範例預設關閉監控及自動購買，須自行設定帳號、通知、收件資料與白名單。

GitHub 版本不是完整搬機備份。私人資料請另行保存在安全位置，勿加入版本控制。LINE Pay 備援仍須完成官方付款憑證串接與實單驗收，不能把模擬測試通過視為已可正式付款。

## 日常操作

- `01_啟動監控.bat`：手動啟動，解除強制停止標記。
- `02_重啟監控.bat`：重啟本專案。
- `03_開啟監控網頁.bat`：只開控制台。
- `04_強制停止監控.bat`：停止並保留停用標記。
- `install.bat`：首次安裝／依賴遺失時使用。

關閉網頁不等於停止服務。開機捷徑與「戰鬥陀螺監控自動復原」排程使用 `-Scheduled`，尊重 `data/monitor-disabled.flag`；不自動解除強制停止。

## 資料夾用途

| 位置 | 用途 |
|---|---|
| `src/` | 正式程式、控制台、API 與平台模組 |
| `scripts/` | 啟停、健康排程、目錄／日誌維護、手動助手 |
| `test/` | 現行回歸測試，不送真實訂單 |
| `extensions/` | 蝦皮／愛電王連接器 |
| `docs/` | 規則、整理交接、補貨模擬範本 |
| `data/` | 帳號、登入、商品基線、結帳範本、訂單、定價 |
| `records/` | 舊日亞永久訂單紀錄 |
| `logs/` | 網站與系統日誌 |
| `node_modules/` | 執行依賴，目前仍需要 |
| `.env`、`config.json` | 私密設定，不可公開 |

目前控制台：總覽、FUNBOX、購物網站、日本拍賣、系統設定。購物網站名稱不改。

## 封存與恢復

- FB／熱點／Google 表單：`D:\codex\beyblade-watcher-archive\1010FB暫存`。
- 舊驗證、實測腳本、備份、報告、截圖與退役購買器：`D:\codex\beyblade-watcher-archive\2026-10-10-專案整理`。
- 後者的 `manifest.json`、`manifest-additional.json` 列每筆移動來源／目標／檔數／大小。沒有永久刪除。
- FB 恢復 Skill：`C:\Users\kenis\.codex\skills\fb-monitor-archive\SKILL.md`。

FB UI 已移除，舊 API 回傳 HTTP 410；正式服務不讀封存、不開 FB／Google 表單瀏覽器，舊恢復設定不能啟動 FB。共用工具仍有少量相容函式，不代表 FB 正在執行。
封存含私人歷史／登入資料，不可直接分享。`docs/restock-reference-for-ai/` 兩份整理範本才是可分享的模擬素材。

## 維護

`npm run check`、`npm test`；愛電王另有 `npm run check:edion`。
FUNBOX／誠品專用多角度驗收：雙擊 `購物網站多角度驗收.cmd` 或 `npm run test:commerce`，不建立真實訂單。測驗手冊見 `docs/COMMERCE_ACCEPTANCE_2026-10-11.md`；報告輸出到 `artifacts/commerce-acceptance/`，測試報告不需納入未來 exe。
搬機先停服務，完整備份 `data/`、`records/`、`.env`、`config.json`；不要只搬 token。
封存實測腳本須重新檢查當前路徑、API、授權與金額限制，不能直接執行。

此次未製作 exe。未來桌面版方向見 `docs/PROJECT_LAYOUT_2026-10-10.md`。

若 Chrome 曾以舊路徑載入未封裝連接器，重新載入後可能需要在擴充功能頁重新指定本專案新的 `extensions/` 路徑。此次保留連接器與配對資料，不重新安裝擴充功能；目前愛電王仍回報人工驗證，並非已解除外站阻擋。
