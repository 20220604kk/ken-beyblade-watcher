// One file belongs to one group so report totals never double-count tests.
export const acceptanceGroups = [
  { id: 'monitor', name: '01 監控與訊號交接', files: [
    'funbox.test.js', 'funbox-dual-source.test.js', 'funbox-immediate-purchase.test.js', 'funbox-sandbox.test.js',
    'shopping-sites.test.js', 'shopping-sites-immediate-purchase.test.js', 'shopping-notification-style.test.js', 'scheduling.test.js'
  ] },
  { id: 'dispatch', name: '02 名單、派單、佇列與額度', files: [
    'auto-purchase.test.js', 'funbox-account-queues.test.js', 'eslite-account-queues.test.js',
    'eslite-continuous-tasks.test.js', 'purchase-dispatcher.test.js', 'purchase-rules-retirement.test.js',
    'commerce-restock-replay.test.js', 'product-sheet-catalog.test.js'
  ] },
  { id: 'identity', name: '03 登入、帳號身分與結帳資料', files: [
    'eslite-api-only.test.js', 'eslite-account-setup.test.js', 'eslite-login-and-accounts.test.js',
    'eslite-recovery-diagnostics.test.js', 'eslite-atm-fallback.test.js', 'pickup-setup.test.js', 'credential-store.test.js', 'purchase-readiness.test.js'
  ] },
  { id: 'checkout', name: '04 正式 API 執行器的隔離測試', files: [
    'funbox-cart.test.js', 'funbox-checkout.test.js', 'funbox-api-checkout.test.js', 'funbox-api-adapter.test.js',
    'funbox-api-pickup.test.js', 'funbox-batch-api.test.js', 'purchase-numbered-steps.test.js', 'eslite-payment-probe.test.js', 'eslite-linepay-contract.test.js'
  ] },
  { id: 'recovery', name: '05 逾時、壅塞、對帳與重啟保護', files: [
    'eslite-overhaul.test.js', 'purchase-recovery-optimization.test.js', 'purchase-order-status.test.js', 'state-form.test.js', 'checkout-resilience.test.js'
  ] },
  { id: 'presentation', name: '06 控制台、TXT、通知與隱私', files: [
    'eslite-purchase-ui.test.js', 'eslite-credential-view.test.js', 'purchase-log-export.test.js',
    'file-log-router.test.js', 'performance-regression.test.js', 'facebook-retirement.test.js',
    'commerce-acceptance-safety.test.js', 'notifier.test.js', 'purchase-list-sort.test.js'
  ] }
];

export const manualGates = [
  { id: 'UI', required: true, status: 'not_run', name: '實際瀏覽器：表格、設定儲存重載、TXT 下載、取消篩選、console', evidence: '離線 VM/DOM 測試不取代實際瀏覽器；請依測驗手冊在隔離控制台操作。' },
  { id: 'LIVE', required: true, status: 'not_run', name: '官網唯讀：逐帳號 API 身分、付款配送選項與正式明細契約', evidence: '不得把本地登入標籤、範本或歷史回應當成現在 API 可用。' },
  { id: 'ORDER', required: true, status: 'not_authorized', name: '真實 ATM/COD 建單：預算、單號、商品、付款資訊與門市', evidence: '需另行明確授權；此套件沒有真實送單入口。' },
  { id: 'BURST', required: true, status: 'not_observed', name: '下一次真實補貨：偵測落差、官方成立、對帳與帳號成功數', evidence: '合成壅塞／庫存只能驗證行為，不代表真實成交機率。' },
  { id: 'LINEPAY', required: false, status: 'gap', name: '誠品合單 LINE Pay 最終備援完整契約', evidence: '2026-10-12 已觀測官方 pay_line=19、20分鐘付款提示與公開frontend cardholder.prime契約；payload與mock runner已測。正式prime來源未接通、真實建單未授權，不得算完整通過。' }
];
