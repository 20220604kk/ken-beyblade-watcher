# 給接手 AI：方爸APP兌換

目標：將附帶 JS 移植到你現有的 FUNBOX 監控，作為可停用／移除的一次性任務。沿用既有控制台及帳號，不另建 App。這是來源碼及協定說明，不含帳密、Cookie、門市、序號或真實訂單；不能拿來直接登入或自動啟用。10/21 開賣後必讀 [失敗原因與新版修復](FUNBOX_APP_REDEMPTION_REPAIR_2026-10-21.md)，不要移植舊版固定 60 秒的普通錯誤退避。

## 先讀這四點

- `src/optional-tasks/funbox-app-redemption.js` 是完整任務流程；同目錄 `funbox-app-redemption-ui.js` 是現有頁面的介面。原檔依賴本專案的結帳／帳本模組，**不能把一支 JS 丟進別的監控便直接執行**。分享包的其餘 `src/` 保留所需來源依賴，`test/` 是合成測試，供 AI 對照移植；不是另一套長駐監控。
- 本次排程是台灣時間 **2026-10-21 10:00:05**、帳號 **C**；新版新批次預設持續重試，不設 30 分鐘截止。朋友的 AI 必須先和主人確認活動日期、專用帳號、門市及真實訂單授權，再改設定；不可沿用過期排程自動購買。
- 已查證網站前端協定並完成合成測試；10/21 自動任務 0／4，使用者另手動完成四單。**不能將手動四單當成程式成單證據**。正式商品尚未上架時，不可把 404 當作售罄。
- 同帳號所有一般下單、登入視窗、清車工具與特別任務必須共用互斥鎖。原實作僅本機鎖，不支援兩台同帳號併行。

## 固定規則

| 項目 | 規則 |
| --- | --- |
| 產品 | 黃蜂要塞 `bbpr07730`；海怪扭擺 `bbpr07733`；雄鹿戰角 `bbpr07736` |
| 任務 | 產品下拉＋各自序號，可排序；一列一件一車一單，完全依序 |
| 例子 | 黃蜂序號甲 → 黃蜂序號乙 → 海怪序號丙，三張單 |
| 去重 | 每列 UUID；同產品不同序號可重複；同序號不區分大小寫，不可重複 |
| 付款 | 僅 `seven_cod`：7-11 取貨付款；沒有 ATM 或其他備援 |
| 金額 | **只認最終含運／手續費總額恰好 NT$555**；不限制單品價或運費拆分 |
| 紅利 | 消耗及折抵均為 0，不使用最大紅利 |
| 序號 | 必須由官網重新讀取的資料確認同一張券已套用且折抵 > 0；不能只相信本地金額 |
| 帳號 | 專用帳號不再接一般任務；其他帳號維持一般商品流程並排除 APP 兌換商品 |
| UI | 原帳號列「特別」→ 排序與序號；明碼顯示並回填核對，磁碟加密；啟用後紅框紅字，任務及訂單標示「特別任務」 |

## 最短完整流程

1. 儲存產品／序號／排序／時間，格式驗證及序號去重。啟用若有草稿先儲存，失敗顯示錯誤。顯示張數、開始時間、NT$555 及付款規則，主人最後按確認才啟用。
2. 持久保存專用帳號保留標記，排除一般派單與帳號操作。開始前 60 秒唯讀預熱登入與門市；預熱失敗在開賣前隔 2 秒重試，剩不到 14 秒不再插入會員頁。主線不再每輪讀會員頁。只有官方明確導向登入才用正常登入程序，不繞過人工驗證。
3. 到時間讀 `/products/<id>.json`；驗證是指定 APP 兌換品、唯一規格及庫存。尚未上架或暫時錯誤至少隔 1 秒重讀，勿平行加車。
4. 先讀該帳號購物車，必須為空才加指定規格 ×1（POST `/cart/add`）。`/cart` 不自動跟隨導向；僅同工作階段、同帳號且 120 秒內有登入證據時，接受官方 `/account/index` 空車導向；其餘仍需讀取驗證。已加車優先讀原車，不能因公開庫存變 0 就放棄結帳；加車回應不明先補查，不盲目重加。
5. 若出現多車選擇頁，依商品識別選唯一匹配的官方 `checkout_no_conflict` 表單／React 資料，進指定車；一般商品車不動。
6. 用下表查詢／套用序號，再讀官方結帳頁核對券、折抵與紅利。選當車的 `seven_cod`，驗證門市，紅利歸零再重讀。
7. 核對指定單品 ×1、唯一指定券已折抵、紅利 0、正式付款選項及門市、總額 555。讀官方訂單列表建立送單前基準；先落盤送單意圖及預留額度，再發最終 POST，`maxAttempts: 1`。
8. 讀官方訂單明細，核對正式單號、商品、件數、門市、付款及總額。成功才記為 `ordered` 並進下一列。整批完成仍保留專用帳號，主人停用才釋放。

## 官網 HTTP 協定（網站使用的請求，不需官方商品 API 權限）

以同一帳號 Cookie、官方 CSRF、Origin／Referer 呼叫；不編造 token 或直接猜別人的購物車。結帳資料來自 `#checkout-v3[data-react-props]`，商品列另需核對網站原始資料。

| 操作 | 請求／關鍵內容 |
| --- | --- |
| 序號查詢 | POST `<cart>/coupons` JSON `{code: 序號小寫}`，回覆必須對應原序號；明確 `err_msg` 為無效 |
| 套用 | POST `<cart>/apply_coupon` JSON：`codes:[指定序號]`、`manually:true`、`coupon_free_shipping:"false"`、`apply_maximun_bonus:false`、`bonus_used:0`、`shipping_fee:0`、`shipping:{}`、`cart_type:"order"` |
| 核對 | GET 指定車；`coupons` 恰好只有原券，`coupon_discount>0`、`bonus_consumed=0`、`bonus_discount=0` |
| 付款 | GET 當車 `shipping_rates_and_payment_method_items`；從最新回覆選 `seven_cod`，不硬編付款 ID |
| 門市 | 已核對的官方門市可沿用；否則走官方電子地圖，核對 6 碼店號、店名、本島地址及服務狀態 |
| 紅利 | POST `<cart>/apply_bonus` 歸零，再讀正式結帳合約；依官網最新配送費、手續費算總額 |
| 送單 | `buildFunboxCodPayload` 產生正式表單，POST `/carts/<token>/`；不是以自行宣稱的 555 取代伺服器資料 |
| 查單 | GET `/account/orders`，比對送單前基準後的新單，再 GET `/account/orders/<token>` 核對明細 |

協定依 2026-10-20 官網結帳前端 `https://cdn-general.cybassets.com/frontend/checkout/main.efb4f8e384292641cad5.js` 查證，網站可能更新；資料不符時停止。`bbpr08914` 水藍龍神僅為研究參考，不在本活動允許清單，也沒有可用序號。

## 慢站／失敗／復原：必須保留

| 狀況 | 行為 |
| --- | --- |
| 429／503／Retry-After | 至少冷卻 60 秒，尊重更長 Retry-After，不換帳號繞過 |
| 普通錯誤／未上架 | 普通錯誤 1 秒、接續最多 2 秒退避；未上架固定 1 秒。外層錯誤也適用，不能固定停 60 秒 |
| 端點持續慢 | GET 從 5 秒放寬至 8／11／12 秒，成功重設；最終送單仍只一次，不套用讀取重試 |
| 加車或套券回應不明 | 只讀指定車判斷是否生效，持續自動接續；原券已折抵就不再查券／套券。不盲重加；三次確認空車後才重查庫存決定是否再加 |
| 序號暫時不可用／資料不符 | 不送單、不自動清車；短退避後重讀核對。缺庫存欄位及 null 不算 0 |
| 明確售罄 | 僅未加車或已連續確認空車時略過；已存在原車仍嘗試完成原單 |
| 最終 POST 逾時／錯誤／沒有單號 | `unknown`，停止後續列，只查官方單；**不重送、不清車、不釋放帳號** |
| 查到一張唯一新單 | 還要核對明細，符合才成立；零張／多張／查不到皆保持未知 |
| 手動停用 | 停派新列，等目前請求與查單結束；沒有未決交易才釋放帳號 |
| 程式重啟 | 持續模式下加車／套券階段先核對原車再接續；已寫送單意圖只查單；已停用的舊批次維持停用 |
| 移除外掛 | 先安全停用；保留加密序號、訂單及未決帳本；模組缺少也不能讓有保留標記的帳號回一般派單 |

狀態：`queued → adding → coupon_applying → submitting → ordered`；明確售罄為 `skipped`；送單前待核對為 `cart_review`，持續模式自動接續；送單意圖後不明為 `unknown`，只查單。每一列保存步驟、端點、時間、耗時、錯誤分類、下次重試時間與單號，紀錄不可包含序號／Cookie／私人 token。工作階段跨預熱與重試沿用，session 檔變動才替換；每份回應及關機資源必須釋放。

## 移植串接契約

任務建構子：`new FunboxAppRedemption({dataDir,state,credentials,multi,coordinator,applyRuntimeConfig,apiFactory,now,log}).init()`。

| 介面 | 你現有監控需要提供／改寫的內容 |
| --- | --- |
| `state` | `data.commerce.autoPurchase`：訂單紀錄、最近結果、`externalAccountReservations`；`writeSnapshot()` 必須可等待且持久保存 |
| `credentials` | `getFunboxAccount('C')`、`getPickupProfile()`、`getPickupSetup('funbox','C')`；真實資料由朋友本機設定 |
| `multi` | `adapters.C` 的未決保護、互動視窗、購物車不明狀態；`accountIdentity('C')`；`accountPurchaseTails` 必須與一般下單共用 |
| `apiFactory` | Playwright APIRequestContext 或相容介面：`get/post`；回覆 `status/headers/url/ok/text/json/dispose`。原範例讀本機專用 session JSON，需改接朋友的 session |
| `coordinator._ledger()` | 原帳本 `reserve(taskId,platform,identity,items,startedAt)`、`settle(taskId,record)`，見來源呼叫及合成測試；不可移除送單前預留或未知交易保護 |
| `applyRuntimeConfig` | 重新套用帳號派單資格：專用及持久保留標記都要排除；不得覆寫其他帳號設定 |
| 主程序 | 可選載入 `.js`；`disabled.flag` 不載入；HTTP 轉交 `task.handle`；關機 `await task.close()` |
| 原頁面 | `funbox-sheet-account-C`、`funbox-sheet-actions-C` 等 DOM 與 `renderFunboxTables` 是本專案名稱；改接你原介面，不能照搬後看不到按鈕 |
| 結帳輔助 | `parseFunboxProductData`、`parseFunboxCartHtml`、`parseFunboxCheckoutContract`、`buildFunboxCodPayload`、`submitFunboxAtmCheckout`、`readFunboxAtmOrder`、`validateFunboxStore`、`selectFunboxSevenStore`，均有完整來源參考。名稱含 Atm 的通用送單／讀單函式已使用 `seven_cod` 參數，不能因此改成 ATM |

HTTP 路由前綴 `/optional-tasks/funbox-app-redemption`：GET `status/client.js`；POST `edit/save/arm/stop/preflight/reconcile/discard-cart/remove-feature`。僅綁 127.0.0.1，POST 必須同源 Origin／Host＋本次 CSRF；`edit` 才回明碼序號，普通 `status` 不含序號。啟用需要 `{confirmRealOrders:true}`，不能因載入來源碼就啟用。

## 接手驗收

先在隔離環境用假帳號／假序號跑附帶測試；禁止拿使用者車／序號做離線測試。驗證順序三單、555 總額、紅利 0、重複序號拒絕、慢回應及未知不重送、限流、重啟保護、明碼回填、未儲存修改先保存、取消確認不啟用。完成後再由朋友授權官方唯讀驗證；有效序號折價與真實下單另由他確認。
