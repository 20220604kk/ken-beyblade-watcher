# 10/23 日亞全庫輪查與持續擴庫

使用者要求修正一般日亞漏報、持續新增商品庫。修改基底 `beab1ac46bd54824ef8729d12f71ac0d6c3ac17a`；最終 commit 由同次 Git 記錄及本機 `artifacts/handoff/amazon-inventory-deployment.json`、`phase1.json` 記載。後兩者是本機驗證資料，不推 Git。

## 漏報原因與新規則

10/23 09:07～09:14 的原監控沒有遇到 429／503，卻完成 27 次搜尋、型號候選為 0。搜尋加上自營賣家篩選後常回傳 Burst 服飾；它不是完整陀螺清單。原一般 ASIN 背景一次一件，15～20 秒排程再加 30 秒輪替門檻，實際約 40 秒一件。45 件約半小時，短暫回流容易整段錯過。這不是 Discord 全部斷線，也不能由別人通知倒推當時本站一定可購。

| 項目 | 現行正式入口 |
|---|---|
| 已知商品 | `continuousInventory:true`；每輪逐筆公平 AOD HTTP GET，取消 30 秒輪替門檻 |
| 速度 | 正常以 1 秒起始間隔為目標；慢請求完成後至少隔 100ms，單次只有一筆背景工作，不疊加追趕 |
| 公平性 | 每輪每個可輪查 ASIN 一次，先查最久未嘗試者；手動追蹤不重複占用批次 |
| 持續擴庫 | 原品牌／商品／手動庫、設定追蹤與使用者提供 12 個 ASIN 合併；以 ASIN 去重，保留同型號不同 ASIN |
| 新品搜尋 | 仍為 15～20 秒，移除 `rh` 賣家篩選；每輪第一頁，每第三輪另補一頁，循環第 2～6 頁 |
| 無價格新品 | 有有效 ASIN、BX／BXG／CX／UX 型號與名稱就可入庫；無價格或第三方搜尋價皆不能當可購證據 |
| 新候選 | 搜尋每輪最多優先驗證兩筆，其餘排入全庫；已驗證者優先順序受查核時間限制 |
| 真實可購 | 全新、Amazon.co.jp 賣家 ID、有效 JPY 與對應 ASIN 的有效可購表單；仍不對照 TT |
| 普通讀取失敗 | 保留上次庫存觀測，該 ASIN 30 秒後再試；明確 404 五分鐘後再試，其他商品繼續 |
| 真實限流 | 停止當次，至少 60 秒並遵守較長 Retry-After；原工作階段讀取協調仍生效 |
| 活躍單品分擔 | 沿用原健康且新鮮的單品分擔契約；單品停止或失效就回到一般輪查 |
| 資料保存 | `productRegistry` 累積不因搜尋消失而刪除，黑名單仍生效；不改私人設定、歷史或採購開關 |
| 通知 | 商品、價格與連結；省略價格依據／販售者／交叉驗證三行。慢 Discord 不阻塞 AOD，新通知加入後持續排出；失敗至少隔 15 秒再試 |

搜尋前六頁的持續收錄不是「Amazon 所有商品已齊全」的保證。商品庫增加時全輪時間也會增加；一秒活動不等於每個 ASIN 每秒查，也不能保證捕捉所有零星回流。

## 程式與狀態

- `src/amazon-inventory.js`：公開 ASIN 初始資料、公平選取、個別重試間隔及背景排程間隔。
- `src/amazon-jp-monitor.js`：`scanDiscovery`、`scanInventory`、即時觀測與持久商品庫；HTTP 失敗不寫成缺貨。停止／重載後的過期回應不得交付購買訊號。
- `src/index.js`：正式 monitor 啟用新模式，背景一筆完成後再排下一筆；搜尋維持獨立排程。舊 `watchBatchSize/backgroundBatchSize` 設定保留，正式新模式不再按舊批次重查手動清單。
- `src/dashboard.js`：原日亞頁的「自動商品庫」，顯示 ASIN、最近 AOD 報價／驗證時間、讀取失敗與重試時間；失敗時標明保留前值。摘要顯示商品數、全輪實測、未驗證／失敗／暫緩數。
- `state.commerce.amazonJp.productRegistry` 僅存名稱、型號、圖片、來源與發現時間，不存可購判斷；`products` 保留已驗證的報價觀測，`inventoryAttempts` 保留逐 ASIN 嘗試／重試時間。
- 公開狀態：`continuousInventory:true`、`inventory.version:1`、`inventory.trackedCount/currentCycle/lastCycle/failedCount/deferredCount/neverVerified/oldestOfferAgeSeconds`。`lastCycle.successful` 表示有效讀取，並不表示都有貨；`checked` 與 `failed/deferred/delegated` 必須一起看。
- `notificationSentCount` 是升級後實際成功送出的累計，不能當歷史總通知數；送出後回應未知仍可能重複通知，不能宣稱 Discord exactly-once。

## 驗證與部署

`test/amazon-inventory.test.js` 覆蓋公平全輪、無價格／第三方搜尋擴庫、跨重啟保存、分頁、局部失敗、真實 AOD 自營／中古／第三方排除、429／503、慢通知不阻塞與停止後不交付過期訊號；既有單品／結帳保護回歸照跑。

驗收命令：`npm run check`、針對 Amazon 測試、`npm run test:offline`、最終提交後 `npm run handoff:phase1`。正式部署須等交易及人工登入空檔，備份原設定／狀態，使用正式暫停再重載並恢復；確認 A/B/C 的原開關、成功數與歷史定價庫完整保留。不能透過真實測試訂單、測試 Discord 或啟用已停止帳號驗收。

部署後讀取本地 `/api/status?view=japan&logs=0`，至少觀察一個完整全庫週期；記錄實際耗時、實查／成功／失敗／暫緩數、新收錄數及 UI 唯讀驗證。收據與實測放本機 `artifacts/handoff/amazon-inventory-*`；有失敗就據實交接，不把排程秒數當成效果。
