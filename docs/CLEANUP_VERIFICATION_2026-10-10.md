# 整理驗收

- 主程式新根目錄 `D:\codex\beyblade-watcher`，舊實體根目錄已移走。
- FB 專用模組／profile／表單資料已封存，正式 FB／表單 API 由 retirement 防線回傳 HTTP 410。
- UI 五個分頁：總覽、FUNBOX 官網、購物網站、日本拍賣、系統設定；FB panel／tab／通知設定不存在。
- npm check、check:edion 通過；完整回歸 652 項通過，0 失敗。含新增 4 項 FB retirement 行為測試。
- 服務重啟前 commerce 原文與原始快照一致。改名前後 .env／現行加密帳密與金鑰／FUNBOX、誠品 session 共 12 份 SHA-256 指紋一致。
- 停用標記存在時執行 start-monitor -Scheduled 不啟動、不移除標記；之後以手動入口正常啟動。
- Node 正式入口位於新根目錄；Startup 捷徑補 -Scheduled，健康排程 action 指向新根目錄並恢復 Ready。
- 實際 Chrome 開啟總覽、FUNBOX、購物網站、系統設定；讀取通知狀態正常，前端錯誤日誌為空。
- fb-monitor-archive Skill 使用官方 quick_validate 檢查通過。PyYAML 驗證依賴只裝在外部整理封存，不改正式依賴。

封存兩張 manifest 共 129 項搬移、24,471 個檔案、約 3.54 GiB，所有封存目標確認存在；原始 source/config/state 快照額外保留。未永久刪除、不執行真實購買測試。
重啟後 118 筆既有訂單 ID 全數保留，沒有新增訂單。既有唯讀訂單同步更新了 4 筆的狀態／檢查時間／查詢錯誤欄位，因此重啟後 records 不會整份逐位元相同；此項與搬移前完整性驗證分開判讀。
上述驗收是專案整理／移除／啟動與資料完整性，不代表外站當下登入永不過期或保證搶購。愛電王既有人工驗證仍保留。
Chrome 未封裝擴充套件若仍記住舊根路徑，之後重新載入需指定新 extensions 位置；此次未重新安裝。
