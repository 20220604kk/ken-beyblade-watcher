# 2026-10-10 整理交接

主程式改名 `beyblade-watcher`，FB 能力封存為 **1010FB暫存**。購物網站名稱不改；本次不新增真實訂單、推播或 exe。

## 保留與移出

保留現行帳密／金鑰、登入、已購紀錄、結帳範本、commerce 商品／通知基線、定價、永久訂單。
原始 src/test/scripts/config.json/state.json/套件/README 完整快照在 FB 封存 `original-project`。
正式 state 清除 FB 專用 seen/forms/initializedPages/lastScan/lastHotspotScan/facebookAccess，不覆蓋 commerce。
正式設定移除 FB 詞庫、粉專與熱點，monitoringEnabled 強制為 false。

FB facebook/watcher/form-autofill/form-ai 模組及相關測試、FB／Google profile 移出。
facebook-retired.js 為停用／HTTP 410 相容防線，不具掃描或填表能力；index 保留少量不可達接口，共用工具保留歷史純函式，避免大改購物流程，之後再拆包。
正式程式及測試不依賴外部封存。混合購買器測試移除兩個依賴退役 momo／墊腳石的案例，原文留在完整 test 快照；現行案例保留。

外部整理封存收納 artifacts、舊報告／截圖／意外產物、備份、state tmp、UI 證據、探測與實測腳本、既有退役 archive。
`manifest.json` 與 `manifest-additional.json` 列每筆來源、目的、檔數與大小。沒有永久刪除；恢復請合併能力，不能整份蓋回新資料。
Windows Startup 捷徑與健康排程更新到新根目錄；Startup 補 -Scheduled，不解除強制停止標記。

## 桌面版下一階段（未實作）

先分離程式資源與 LocalAppData 持久資料，再評估桌面殼、托盤、單一實例、背景啟停、更新與安裝器。保留 API 核心，不將私人資料和封存一起打包。
目前專案文件／檔名搜尋未找到「準星人」的可核對記錄；之後提供檔案或畫面再比較，不憑印象推斷。
