# 10/22 日亞單品插件流程移植

使用者要求參考自己的家用 Chrome 插件，移植到公司監控 APP。基底為監控 APP `d61087c`；本次最終 commit 以 Git 記錄及本機驗收收據為準。

## 來源與證據

- 參考庫：[ken-amazon-single-extension](https://github.com/20220604kk/ken-amazon-single-extension)，固定 `284b5229eeae0947a8d867bce48ca288eaf3792d`，v2.0.6／`2.0.6-optimized-r1`。
- 已讀 README、架構與驗證說明，以及 `policy.js`、`http-dom.js`、`runner-api.js`、`runner.js`、transport、background 的相關實作。
- 參考庫 54 項單元測試實際重跑通過。庫內 API／前端 evidence 明確標記 syntheticOnly；私人實單 LOG 不在 Git，不能把這批合成結果宣稱為本次實單成功證據。
- 完整參考庫只留在監控專案外的本機目錄，沒有複製私人證據或整套插件到監控 APP Git，也不重建已移除的 AI 分享包。

## 前後對照

| 項目 | 原 APP | 本次移植 |
| --- | --- | --- |
| 單品主路徑 | 商品頁直購 | 保留，一輪正常仍只讀一次商品頁，重用本輪表單 |
| 主區沒有直購／主區非自營 | 等下一輪或拒絕 | 另讀一次 AOD，選全新 Amazon.co.jp 自營；非自營不購買 |
| 預購 | 只辨識 Buy Now | 支援兩種預購名稱，使用實際按鈕的 formaction／formmethod／name |
| 新版價格區 | 部分 a-price | 支援 APEX，排除劃線／隱藏價格；多個不同現價不猜價格 |
| AOD 快線 | 舊加車路徑先查購物車及訂單歷史 | 本輪新報價直接加車；明確 Smart Wagon 成功、同 ASIN、全車數量 1、唯一官方入口才略過完整購物車 |
| 不完整加車確認 | 查完整購物車 | 保留，須唯一同 ASIN／數量 1／同 offering／自營；混車不刪除、不自動修改 |
| Prime 中間頁 | 契約未辨識 | 只執行明確拒絕試用的官方 GET／具 CSRF 的 decline POST，不接受試用 |
| itemselect | 缺少明確續行 | 唯一同商品／自營／數量 1，且同 flow 的實際 Continue 表單才續行；數量 0 不按 |
| 結帳頁框／轉址 | 常回到下一輪入口 | 從返回的官方表單、連結、meta 或結構化 JSON 取得唯一 SPC 位置；不執行 script、不猜 flow、不 GET 最終送單網址 |
| 紅字頁 | 1,000ms 起始間隔 | 正式快線 250ms 起始間隔，單一請求循序重查；回應較慢不再額外等 250ms |
| 紅字頁被導回商品 | 可能保留舊位置 | 明確商品頁或空車就結束舊準備，回商品監控取得新報價 |

250ms 是本機排程間隔，不是保證 Amazon 每秒回應四次。若單次網路需要 1.8 秒，實際頻率仍受該回應時間限制。主區不能直購時補查 AOD 也會增加一次讀取，換取隱藏自營報價的涵蓋率。

## 執行與恢復契約

1. `AmazonJpProductOrderMonitor.httpClient()` 開啟 `retailFallbackEnabled`；普通商品輪詢仍為一秒，沒有搬入參考庫 2／5／30 秒普通退避。
2. `readRetailOffer()` 優先 `readDirectOffer()`。只有主區無可用直購／明確賣家不合才補 AOD；商品讀取逾時、驗證、429／503、ASIN／數量／CSRF 契約錯誤不換路掩蓋。顯示幣別模糊時已查的 AOD 不重複讀第二次。
3. AOD 報價必須是同一 client、本輪的原 snapshot 物件，且五秒內有效。加車前持久化 `route: aod_fast, phase: adding`；加車只發一次，逾時保留鎖、不重送。
4. 返回已完整結帳頁可直接驗證；Smart Wagon 走唯一官方 cart entry；其他情況核對完整車。Prime／itemselect／SPC 續行最多六步，重複契約停止並保留待核對。
5. 紅字狀態保存原 tx／snapshot／實際收到的安全網址。優先使用官方返回的 canonical SPC；只有唯讀 GET 可恢復，不重加車、不送數量零。AOD 的自動恢復要求同次 `startedAt`、同 ASIN、已持久保存的 `buy_now` 紅字位置；單純加車未知不解除。
6. 最終共用 `checkoutDirect()`，核對唯一 ASIN／數量一／自營、本輪日圓商品報價、運費與總額、地址及零點數；保留既有運費設定與 API／前端競速的唯一送單許可。
7. 最終送出前持久化 submitted，只發一次。回應不明維持未決，不以舊同品項訂單冒認成功；AOD 快線沒有事前歷史基準時亦不推論為空歷史。只接受本次正式完成頁訂單號或可唯一歸屬的查單。
8. 真正 429／503／Retry-After 保留降速；登入與人工驗證仍走官方流程。保留獨立商品／結帳／背景歷史登入狀態。

## 檔案與驗證

- `src/amazon-checkout-flow.js`：現價／購買按鈕、Smart Wagon、Prime、itemselect 與官方續行契約。
- `src/amazon-jp-http.js`：本輪報價與 AOD 快線、共用最終送單、紅字位置恢復。
- `src/amazon-jp-product-order.js`、`amazon-pre-submit-retry.js`：正式接線、僅可恢復的送單前階段。
- 背景瀏覽器入口、頁面就緒與既有前端橋同步支援預購；前端橋也使用 APEX 價格判斷。這不是以家用插件取代既有前端橋或搬移帳號。
- `test/amazon-extension-port.test.js`：31 項合成測試，包含直購／預購、第三方主區的自營 AOD 補查、Smart Wagon／完整車、過期報價、Prime 三語與登入範圍、itemselect、防未知重送、SPC 頁框及純 JSON 續行、紅字回流及重啟恢復、官方限流與回商品。
- 原登入範圍測試補上「沒有 AOD 報價」的合成回應，避免新增補查被測試誤認為未知網路請求；保留原登入隔離斷言。

驗收入口：`npm run handoff:phase1`（語法、完整離線測試、隔離控制台、發佈內容稽核）。另執行 `node scripts/audit-distribution.mjs --private-root .`。收據 `artifacts/handoff/phase1.json` 綁定本機與最終 commit；部署／現場唯讀結果在忽略的 `artifacts/handoff/amazon-extension-*.json`。

正式重載需等交易／互動視窗空檔，先保存原設定與狀態，官方暫停後再重啟，恢復原本開關；不得重設成功數、移除未決或清除原紅字位置。部署前觀測到 A 啟用、B/C 停用及舊紅字位置，僅是當下快照，下一位 AI 必須重查實際狀態。

保留紅字位置遇到結帳登入待核對或任務已停用時，狀態標記 `suspended`，UI 顯示「保留紅字頁」；不得把保存位置冒充為仍在 250ms 刷新。A 在本次部署前另有舊結帳登入待核對，商品監控仍運作，不能藉移植程式直接清除這項驗證狀態。

本次不建立真實測試訂單、不發測試通知、不刪真實購物車。尚未以真實新品競購驗證新路徑的成功率或 250ms 實際吞吐；合成測試與網站即時可用性必須分開解讀。
