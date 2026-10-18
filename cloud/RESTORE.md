# 下一次雲端還原

只在雲端目錄操作；不要切換或修改 main，不要連接使用者本機。

1. 優先從 GitHub 還原：`git clone --single-branch -b cloud/monitoring-only https://github.com/20220604kk/ken-beyblade-watcher.git /workspace/ken-beyblade-watcher-restored`。只有雲端還原套件可用時，解開 cloud-phase2-recovery.tar.gz 到暫存目錄，使用 `git clone -b cloud/monitoring-only monitoring-only.bundle /workspace/ken-beyblade-watcher-restored` 建立獨立雲端 repo，再把 overlay/ 內容複製到該 repo。
2. 確認分支為 cloud/monitoring-only。GitHub 提交只包含程式、測試與文件，不含狀態或證據。舊還原套件的 bundle 是基底提交，overlay 是當時尚未提交的完整 cloud 變更；採套件還原時兩者都必須保留。
3. Node 24+；執行 npm ci，保留平台 proxy/CA，重新檢查環境網路白名單。不要載入舊 .env 或 config.json。
4. JSON 狀態格式 version=1：events 陣列、stations 物件、sink 陣列。站點擴充 httpStatus、parsedCount、charset、dataKind、lastScan、latencyMs；sink 只有 dry-run。使用最終 real 狀態可持續去重；fixture 只能另檔使用。
5. `CLOUD_SCAN_ONCE=1 CLOUD_STATE_FILE="$PWD/data/cloud/phase2-final-real.json" npm run start:cloud`；只用雲端 3320。預設不設 CLOUD_SCAN_ONCE 時每站完成後 60 秒重掃。禁止 3210。
6. npm run test:cloud；npm run check:cloud。visual-smoke 需要真實 3320 服務及 /usr/bin/chromium；fixture 使用獨立檔與 ephemeral port。
7. 套件排除所有 .lock。若現有工作區有殘留鎖，先查 PID 及程序身份；確認無 writer 才刪該鎖，勿刪 JSON。JSON 損壞應 fail-closed。

回復時需維持購買、登入、Cookie、購物車、付款、Webhook 及真實推播關閉。雲端 snapshot 與此套件不代表永久監控或外部自動備份。
