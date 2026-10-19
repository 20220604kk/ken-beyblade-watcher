# 墊腳石官網監控

「購物網站」新增支援新官網 `www.tcsb.com.tw/search`，不同於舊 `shop.tcsb.com.tw` 和 momo 墊腳石賣場。

- 使用官網搜尋頁實際呼叫的公開 GET `/api/products`，保留網址的 `query`、`place_of_origin` 等搜尋條件。
- 依 `meta.last_page` 讀完整分頁，每次最多 2 個並行、全輪 15 秒、最多 10 頁；不接受截斷／不一致的分頁。
- 解析名稱、商品 ID、官方商品網址、圖片、售價與 `is_saleable`。只有明確布林值才代表可購／不可購；沒有庫存數字就不虛構數量。
- 排除沒有正式 BX／UX／CX／BXG 型號的書籍、搜尋建議等雜項；配件和戰鬥盤保留，由既有購物網站排除名單決定是否通知。
- 首輪只建立基線，之後沿用新品可購／恢復可購的通知去重規則。超時、限流、格式錯誤保留舊基線。
- 沿用購物網站共用時段、掃描間隔、熱點排程及 Discord 通知；**不支援自動下單**。

使用者提供的網址有「產地＝其他」篩選，僅監控該篩選結果，不偷偷擴大為全站搜尋。

主要程式：`src/tcsb-monitor.js`；整合：`src/shopping-sites.js`、`src/index.js`；測試：`test/tcsb-monitor.test.js`。
