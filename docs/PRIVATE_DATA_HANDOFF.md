# 第二階段：私人資料移交（先驗收程式，再解密）

## 使用者本次授權與範圍

2026-10-19 使用者要求完整移植，包含自動下單帳密、Webhook、Cookie，但公司端必須完成第一階段後才調用私人資料。此文件是操作流程，**不包含秘密本身**。

程式／工具／本文件放私人 GitHub；真實資料只放獨立 AES-256-GCM 加密包與分開保存的隨機 256-bit 鑰匙，兩者都不進 GitHub、Issue、聊天訊息或程式碼。不得把加密包與鑰匙一起放同一公開／共用位置。

授權不是公司立即接管購買：家用機目前仍可能運作，公司匯入後不啟用監控或下單，不送真實測試通知，不清車、不買商品。正式切換帳號歸屬需要使用者另外指定時機。

## 三個階段

| 階段 | 可做 | 不可做 |
|---|---|---|
| 1：公司驗收 | 下載私人 main、安裝 Node／Chrome、程式／離線測試／隔離控制台驗證 | 打開、解密或匯入私人包；登入購物帳號；啟用下單 |
| 2：私人匯入 | 檢查本機第一階段收據後，解密到新目錄、還原帳密／Webhook／狀態／可移機 Cookie | 啟動服務、發送通知、啟用下單、覆蓋現有私人資料 |
| 3：正式接手 | 使用者指定帳號、家用停單／未決核對、必要的官方重新登入與唯讀驗證 | 直接讓兩台使用同一帳號並行購買；把快照當即時共享帳本 |

## 私人包包含什麼

- `.env`：Discord 公開／私人 Webhook、Bot／LINE 等目前實際設定。
- `config.json`：所有目前來源、任務、名單、優先級、付款／配送與開關設定。原始快照保留；公司實際設定另強制停單。
- `data/private-purchase/.credential-key` 與 `credentials.enc.json` 成對保留，不重新輸入或把密文當無敏感資料。
- `data/auto-purchase/` 的已保存 session、帳號結帳／配對資料，以及專案專用 Chrome profiles 的必要資料。
- `data/state.json` 與其餘必要資料、`records/`：商品基線、帳本、既購／限購、未決交易與訂單紀錄。保留未知狀態，不重建為空。
- 額外從專案專用 Chrome 讀取可解密 Cookie／storage state，放在包內，不生成散落的明文 Cookie 匯出檔。

不包含一般工作用 Chrome profile；也不搬瀏覽歷史、快取、診斷截圖／evidence、程序 PID、鎖檔、停止旗標、模型快取、例行 LOG 或程式依賴。原始家用資料未因排除而刪除。

這是可恢復購買環境的快照，不是逐位元整機映像。已有私人資料仍需安全備份；憑證有效期與官方驗證不會因搬機延長。

## 第一階段：公司 Codex 的確切入口

先取得此私人 GitHub 權限，在**全新目錄**執行，先不要 `install.bat`、不要複製家用 `.env`／`config.json`、不要啟動服務：

```powershell
git clone --branch main https://github.com/20220604kk/ken-beyblade-watcher.git
cd ken-beyblade-watcher
npm ci
npx playwright install chromium
npm run handoff:phase1
```

另需安裝 Google Chrome（`channel: 'chrome'`）。第一階段本身在臨時目錄建立範例設定，不要求根目錄先有 `.env`／`config.json`。

四項全部成功才產生 `artifacts/handoff/phase1.json`：

1. 所有程式語法／相對匯入／控制台腳本。
2. 依序完整離線回歸測試。
3. 隔離目錄、隨機 port 的乾淨啟動／網頁與停單驗證。
4. Git 待發佈內容的私人路徑／憑證格式掃描。

收據綁定**產生它的這台電腦、目前 commit、目前程式內容**，有效 7 天。不能拿家用收據直接在公司通過；改程式或更新版本後要重跑。某項失敗時不留下舊成功收據。

這是正常工具流程的操作門檻，不是防止有鑰匙的人自行解密的 DRM。公司 Codex 不得偽造收據或繞過匯入器。

## 家用機：如何製作私人包

只由家用使用者授權的操作人執行。先核對沒有進行中送單、帳號操作或互動登入，暫停前保存／確認原本啟用狀態。

正式工具只允許來源控制台處於 `systemPause.active=true` 且無進行中任務。建議使用原有「全部暫停／遊戲模式」的 `POST /system/pause`，待瀏覽器正常關閉，再匯出；不殺交易、不清購物車。

```powershell
node scripts/private-migration.mjs export `
  --source "D:\codex\beyblade-watcher" `
  --output "<私人交付位置>\ken-private-20261019-bundle\snapshot.kenvault" `
  --key "<另一個私人位置>\ken-private-20261019-key\snapshot.key"
```

兩個路徑都必須在任何 Git／來源專案之外，而且鑰匙與包不在同一資料夾。各自的直接父目錄必須是尚不存在、以 `ken-private-` 開頭的專用目錄；工具檢查實際路徑，僅限制這兩個新目錄的 Windows 權限到目前使用者與 SYSTEM，不修改 Downloads 等既有大目錄的權限，不覆蓋既有包／鑰匙。

匯出會逐一打開**專案專用** headless Chrome，讀取保存的 Cookie，採離線頁面讀取主要站點 localStorage；不按購買、不送帳密、不清車。取得每個 profile 的 Cookie 後正常關閉，才讀取穩定資料。最後確認來源仍暫停且設定／狀態未改變，驗證加密包可認證還原，再寫檔。

完成或失敗都必須由操作者檢查來源狀態；若原本不是暫停模式，使用 `POST /system/resume` 恢復原本設定。不要照文件的歷史 A/B/C 狀態硬設目前帳號，必須沿用暫停前的實際設定。

私人快照與金鑰的檔名、雜湊、時間、檔數及操作結果可記錄；**不要輸出其中的密碼、Webhook、Cookie 或會員資料**。

## 第二階段：公司 Codex 匯入

使用者將 `.kenvault` 與 `.key` 透過 USB／受控私人管道分開交付。公司 Codex 只有在第一階段成功後才處理它們；先確認下載包的 SHA-256 與家用端紀錄相同。

使用第一階段的**同一份新 clone**，不能已有 `.env`、`config.json`、`data/` 或同名私人紀錄。如果先前已建立環境，改開新的 clone，不要刪掉舊環境來規避保護。目標本機服務亦必須停止。

```powershell
node scripts/private-migration.mjs import `
  --package "<公司收到的路徑>\ken-private.kenvault" `
  --key "<分開交付的路徑>\ken-private.key" `
  --acknowledge-private-import
```

工具會先檢查第一階段收據，**通過前不打開包或鑰匙**。之後驗證 AES-GCM、每個檔案的雜湊、相對路徑、大小、設定格式、內層帳密金鑰是否能解密與目標衝突。任何驗證或 Cookie 還原失敗，不把半份私人設定安裝到目標。

成功後：

- 帳密金鑰／密文、Webhook、必要 session／基線／帳本完整還原；不用將密碼貼給 AI。
- 所有監控、FUNBOX／誠品購買、日亞 A/B/C 及購買恢復設定關閉；不啟動服務。`systemPause.active=true` 保持官方全部暫停狀態，因此日後手動啟動也不會自動排程 Discord 狀態／提醒；不可直接按恢復或重新啟用。
- 原始設定保存在 `data/private-import/original-config.json`，僅供使用者確認後的切換規劃，不可整份覆蓋回去自動啟用。
- 寫入禁止排程自啟的旗標。之後手動啟動可能解除一般停止標記，但實際購買開關仍為 false；先不要改它們。
- `data/private-import/report.json` 記錄匯入時間、來源快照時間、檔數、可移機 profile／Cookie 數。它不包含密碼，不宣稱已通過官方登入。

## Cookie：已還原與仍需核對的界線

舊 Chrome Cookie DB 可能綁來源 Windows／使用者，不能直接在公司覆蓋使用。因此：

1. 原始 profiles 存到 `data/private-import/raw-profiles/`，作為 OS 綁定的備份，不啟用。
2. 公司用自己的 Chrome 建立同名專用 profile，把包內可讀取的 Cookie 寫入，由新 Windows 重新加密保存。
3. localStorage 以離線回應頁面還原，避免為匯入去操作真實結帳。包內的 IndexedDB／其他原始 profile 資料保留備份，但**本工具尚未自動重建 IndexedDB、sessionStorage、擴充功能或已存密碼的瀏覽器內部格式**。
4. 專案原本另外保存的 session JSON／加密帳密仍還原，可以支援官方重新登入；過期 Cookie、IP／裝置風控、人工驗證、跨機的 passkey／綁定付款依然可能要求重新登入。

所以「檔案與 Cookie 匯入完成」不等於「每個帳號已登入成功」，更不等於「可馬上買」。下一步是逐帳號官方唯讀身分／配送／付款核對，不清空已存在的未知訂單或限購歷史。

## 第三階段：正式切換前清單

- 來源快照之後家裡可能繼續產生新訂單。最終接管前再停來源指定帳號、查未決交易、同步／核對新帳本；舊快照不能當即時共享狀態。
- 使用者明確指定公司接手哪個平台／帳號與時間；同一帳號不可讓兩台同時購買。
- 公司檢查實際官方登入／Cookie 到期、配送門市／地址、付款與含運上限，勿輸出敏感值到終端或 GitHub。
- 私人／公開通知分流重新核對，不自行發測試訊息；真實送單另需商品、數量、金額與帳號授權。
- 公司權限、休眠與安全連線依公司規則；本機控制台不直接公開到網際網路。
- 匯入後的 `.env`、`config.json`、`data/` 仍不入 Git。依組織安全規範保管／移除已使用的交付副本，不自行刪除唯一備份或鑰匙。

## 已驗證與未驗證

專項測試包含錯鑰匙／竄改拒絕、路徑安全、未完成／跨機／過期收據拒絕、程式改變收據失效、舊資料保護、匯入故障回滾、加密帳密可由既有儲存器解開、未決帳本保留、原始 profile 隔離，以及合成 Cookie／localStorage 在新專用 Chrome 的保存。

實際私人包是否已生成、實際 Cookie 數與檔案雜湊請看本機交付紀錄；本文件不冒稱公司已完成匯入或官網驗證。完整回歸與版本驗證見 `HANDOFF_VERIFICATION_2026-10-19.md`。
