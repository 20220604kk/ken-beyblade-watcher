# 10/21 日亞改採 AOD 自營報價

10/23 更新：自營 AOD 判斷仍適用；本文件舊的賣家搜尋與低頻背景輪替已由 [持續擴庫與全庫輪查](AMAZON_INVENTORY_2026-10-23.md) 取代。通知亦省略價格依據、販售者及交叉驗證三行。

使用者明確取消 TT 官網定價對照。這項政策取代過往移交文件中的 TT 定價門檻；「Amazon.co.jp 自營」是新的採購條件，通知不再宣稱已驗證官方定價。

| 項目 | 新規則 |
|---|---|
| 新 ASIN | 保留賣家搜尋作發現入口；AOD 必須先知道 ASIN，不能單靠 AOD 發現未知商品 |
| 一般可購判斷 | AOD HTTP 的全新 Amazon.co.jp 自營報價、有效 JPY 價格、對應 ASIN 與有效加車表單 |
| TT／手動 MSRP | 不抓取、不比較、不作通知或下單門檻；即使空表、維護或未收錄型號也可正常核對 |
| 已知品 | 維持優先項目與輪替批次；不一次刷新全庫，也不重複查活躍單品任務已分擔的 ASIN |
| 搜尋中未變報價 | 僅可短暫沿用 30 秒內已核對的同價格 AOD；不因搜尋成功刷新其 AOD 查核時間 |
| 不完整 AOD | 保留既有庫存，不虛構售罄；明確無自營／無全新品／無報價才判不可購 |
| 單品 API／瀏覽器／插件 | 移除 TT 門檻，保留原直購與一次送單授權；結帳金額核對本輪商品報價及原運費上限 |
| 真實限流／驗證／未知送單 | 原保護全部保留，不換路繞過或重送 |

一般搜尋仍採原 15～20 秒排程；AOD 是網站使用的 HTTP，不是 Amazon 官方商品 API。A／B／C 快速單品保留既有 1 秒目標的直購商品頁讀取，避免在每輪額外增加 AOD 再讀商品的延遲。這些單品已同時解除 TT／手動 MSRP 的價格門檻。

`refreshCatalog` 與定期品牌頁刷新已退出執行路徑。舊定價、品牌 ASIN、手動參考價、訂單及成功計數完整保留；既有品牌／商品 ASIN 仍可輪替 AOD。舊 `dedicatedUntilCatalog` 項目改作優先 AOD 核對，不再等 TT 收錄。沒有設定重置，也沒有重新建立空白帳本。

## 程式入口

- `src/amazon-jp-monitor.js`：`loadAodOffer` 使用原監控 BrowserContext 的 HTTP Cookie、JPY／日本配送環境與共同讀取排程。只 GET AOD，不加車；未知／缺欄位回應保留原狀態。監控仍立即交付已驗證的補貨訊號，與通知／下單互不阻塞。
- `src/amazon-jp-product-order.js`：商品與訊號不再讀 TT；送單前依 `quotePriceYen` 核對本輪報價。歷史函式的 `msrpYen` 參數名只留相容舊工具，不代表新流程查 TT。
- `src/amazon-race-bridge.js`：插件商品確認不再等 TT，交易保存自己的商品報價；送單授權及未知交易持有規則不變。
- `src/dashboard.js`／`src/index.js`：改稱「自營 AOD 監控」，移除「已核對官方定價／只通知官方定價以下」等保證。內部仍接受舊來源識別字，避免舊訊號或資料失效。
- `status.pricingPolicy=amazon_retail_aod`、`ttCatalogEnabled=false`、`archivedCatalogCount` 可確認新政策與歷史保存；舊 `catalogCount` 僅作相容歷史數量。

## 驗收與交接

主要新測試 `test/amazon-retail-policy.test.js`：TT 故障／空表／未收錄／高於舊定價都不阻塞、第三方 FBA 與中古排除、AOD 缺欄位不製造庫存變化、真正 429／503 遵守 Retry-After、新 ASIN 搜尋→AOD、訊號去重與結帳報價核對。既有 API、瀏覽器與 MV3 插件的單次送單、運費、幣別、混車及未知訂單回歸繼續執行。

先 `npm ci`、`npm run check`，最終 commit 執行 `npm run handoff:phase1`；通過後在交易／人工登入空檔保存設定、暫停、重載、恢復。保留原帳號開關、購買目標、成功數與歷史，不能為驗收新建真實訂單或另送 Discord 測試。

本機正式收據、部署、唯讀實站觀察存 `artifacts/handoff/amazon-retail-*`（不推 Git）；收據及部署紀錄含實際 commit。不要把離線合成訂單說成實際購買成功。另一台機器仍須遵守原有帳號交接規則。
