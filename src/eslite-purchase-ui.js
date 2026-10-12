// Presentation only. These tables never fetch, log in, mutate carts or submit orders.
export const esliteTableCss = `
.eslite-sheet{margin:14px 0 0;min-width:0}.eslite-sheet-heading{display:flex;align-items:center;gap:10px;margin:14px 0 8px;font-size:13px}.eslite-sheet-heading small{font-size:12px;color:#8fa0bd;font-weight:400}.eslite-sheet-scroll{overflow:auto;border:1px solid #2c3948;max-height:430px;background:#121920}.eslite-sheet table{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:12px;line-height:1.45;font-variant-numeric:tabular-nums}.eslite-sheet th,.eslite-sheet td{padding:8px 9px;border-right:1px solid #2c3948;border-bottom:1px solid #2c3948;text-align:left;vertical-align:middle;overflow-wrap:anywhere}.eslite-sheet th:last-child,.eslite-sheet td:last-child{border-right:0}.eslite-sheet tbody tr:last-child td{border-bottom:0}.eslite-sheet th{position:sticky;top:0;z-index:1;background:#202a33;color:#45d9c6;font-weight:600;white-space:nowrap}.eslite-sheet tbody tr:nth-child(even){background:#161f27}.eslite-sheet tbody tr:hover{background:#1c303b}.eslite-sheet .eslite-num{text-align:center}.eslite-sheet .eslite-nowrap{white-space:nowrap}.eslite-sheet .eslite-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.eslite-sheet small{display:block;color:#8fa0bd;font-size:11px;margin-top:2px}.eslite-sheet a{color:#ffd166;text-decoration:none}.eslite-sheet a:hover{text-decoration:underline}.eslite-sheet .eslite-order-product{color:#e7eef8}.eslite-sheet .eslite-warning{color:#ffd166}.eslite-sheet .eslite-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.eslite-sheet button{border:1px solid #35485a;background:#1b2835;border-radius:5px;padding:4px 7px;font-size:11px;white-space:nowrap;font-weight:500}.eslite-sheet button:hover{background:#30465c}.eslite-sheet button[aria-expanded=true]{border-color:#6ba5fc;color:#98c4ff}.eslite-sheet .eslite-empty{text-align:center;padding:18px;color:#8fa0bd}.eslite-sheet .eslite-account-table{min-width:1020px}.eslite-sheet .eslite-queue-table{min-width:720px}.eslite-sheet .eslite-order-table{min-width:1040px}.eslite-sheet-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.eslite-sheet-filters label{font-size:12px;color:#9eabc3;display:flex;align-items:center;gap:6px}.eslite-sheet-filters input,.eslite-sheet-filters select{padding:7px 9px;border-radius:5px;font-size:12px;min-width:0}.eslite-sheet-filters input{width:260px;max-width:100%}.eslite-sheet-filters span{font-size:12px;color:#8fa0bd;margin-left:auto}.eslite-sheet .eslite-step-row td{padding:0;background:#0d1520}.eslite-step-log{max-height:220px;overflow:auto;padding:9px 12px;font-size:12px}.eslite-step-line{display:grid;grid-template-columns:90px 70px minmax(150px,1fr) 90px;gap:10px;padding:4px 0;border-bottom:1px solid #253342}.eslite-step-line:last-child{border:0}.eslite-step-line small{grid-column:3/-1;white-space:pre-wrap}.eslite-step-error{white-space:pre-wrap;color:#ff9898;margin:4px 0 8px}.purchase-hub #eslite-account-list{border:0;background:none;margin:8px 0}.purchase-hub #eslite-account-list .eslite-account-card.compact{display:none}.purchase-hub #eslite-account-list .eslite-account-head-actions{display:none}.purchase-hub #eslite-account-list .funbox-account-head{padding:9px 12px}.purchase-hub .eslite-account-toolbar{border:0;padding:0;background:none;border-radius:0}.purchase-hub .eslite-account-toolbar small{display:none}.purchase-hub .eslite-account-toolbar button{font-size:12px;padding:6px 10px;border-radius:5px}.purchase-hub .eslite-system-details{margin-top:12px;font-size:12px;color:#9eabc3}.purchase-hub .eslite-system-details>summary{cursor:pointer;padding:6px 0}.purchase-hub .eslite-system-details .field{margin-top:8px}.purchase-hub .eslite-system-details button{padding:7px 10px;font-size:12px}.purchase-hub .notice:empty{display:none}.purchase-hub .purchase-rules-fold{margin-top:10px}.purchase-hub .card-heading h2{font-size:14px}.purchase-hub .card{box-shadow:none}.eslite-purchase-controls{font-size:12px}.eslite-purchase-controls button{padding:7px 11px;border-radius:5px;font-size:12px}.eslite-purchase-controls input[type=number]{width:65px;padding:6px 8px}@media(max-width:620px){.eslite-sheet-filters label:first-child{width:100%}.eslite-sheet-filters input{flex:1;width:auto}.eslite-sheet-filters span{margin-left:0}.eslite-step-line{grid-template-columns:75px 60px 1fr 65px;gap:5px}}
.eslite-sheet-heading{flex-wrap:wrap}.eslite-priority-controls{gap:8px;margin-top:8px;font-size:12px}.eslite-priority-controls input{flex:1;min-width:180px;padding:7px 10px;border-radius:5px;font-size:12px}
.eslite-step-log{max-height:420px}
`;

export function esliteAccountRowHtml(slot) {
  return `<tr id="eslite-sheet-account-${slot}">
<td id="eslite-sheet-identity-${slot}">${slot}</td><td id="eslite-sheet-login-${slot}">—</td><td id="eslite-sheet-api-${slot}">—</td><td id="eslite-sheet-payment-${slot}">—</td><td id="eslite-sheet-pending-${slot}" class="eslite-num">0</td><td id="eslite-sheet-purchased-${slot}" class="eslite-num">—</td><td id="eslite-sheet-heartbeat-${slot}">—</td>
<td><div class="eslite-actions" id="eslite-sheet-actions-${slot}"><button type="button" onclick="testAutoPurchaseLogin('eslite','${slot}')">登入</button><button type="button" onclick="testAutoPurchaseLogin('eslite','${slot}',true)">手動登入</button><button type="button" onclick="completeAutoPurchaseLogin('eslite','${slot}')">檢查</button><button id="eslite-sheet-settings-${slot}" type="button" aria-expanded="false" aria-controls="eslite-account-${slot}-card" onclick="toggleEsliteAccountCard('${slot}')">帳密設定</button></div></td></tr>`;
}

export const esliteAccountTableHtml = `
<div class="eslite-sheet"><div class="eslite-sheet-scroll"><table class="eslite-account-table" aria-label="誠品帳號狀態">
<colgroup><col style="width:130px"><col style="width:95px"><col style="width:145px"><col style="width:105px"><col style="width:55px"><col style="width:60px"><col style="width:115px"><col style="width:270px"></colgroup>
<thead><tr><th>帳號</th><th>登入</th><th>下單狀態</th><th>付款</th><th class="eslite-num">待購</th><th class="eslite-num">已購款</th><th>心跳</th><th>操作</th></tr></thead>
<tbody>${['A', 'B', 'C'].map(esliteAccountRowHtml).join('')}</tbody></table></div></div>`;

export const esliteOrderTablesHtml = `
<section class="eslite-sheet" aria-label="誠品搶購佇列"><h3 class="eslite-sheet-heading">搶購佇列 <small id="eslite-sheet-queue-count">0 件</small><small id="eslite-sheet-event-state">等待補貨訊號</small></h3>
<div class="eslite-sheet-scroll"><table class="eslite-queue-table"><colgroup><col style="width:65px"><col style="width:60px"><col><col style="width:160px"><col style="width:100px"></colgroup><thead><tr><th>帳號</th><th class="eslite-num">順序</th><th>商品</th><th>進度</th><th>剩餘時間</th></tr></thead><tbody id="eslite-sheet-queue"><tr><td colspan="5" class="eslite-empty">目前沒有待購商品</td></tr></tbody></table></div></section>
<section class="eslite-sheet" aria-label="誠品訂單紀錄"><h3 class="eslite-sheet-heading">訂單紀錄 <small>本機最近紀錄</small></h3>
<div class="eslite-sheet-filters"><label>搜尋 <input id="eslite-sheet-search" type="search" placeholder="商品／訂單編號" oninput="renderEsliteTables(currentStatus?.autoPurchase)"></label>
<label>帳號 <select id="eslite-sheet-account-filter" onchange="renderEsliteTables(currentStatus?.autoPurchase)"><option value="">全部</option><option>A</option><option>B</option><option>C</option></select></label>
<label>結果 <select id="eslite-sheet-status-filter" onchange="renderEsliteTables(currentStatus?.autoPurchase)"><option value="">全部</option><option value="ordered">訂單成立</option><option value="canceled">訂單取消</option><option value="unknown">待核對</option><option value="failed">未成立</option><option value="processing">處理中</option></select></label><button type="button" onclick="refreshPurchaseOrderStatuses('eslite',true)" title="開啟此頁時每 10 分鐘最多補查 2 筆；手動最多 6 筆。搶購時延後，不登入、不清車。">更新訂單狀態</button><button type="button" onclick="exportPurchaseLog('eslite')">匯出篩選結果 TXT</button><span id="eslite-sheet-order-count">0 筆</span></div>
<div class="eslite-sheet-scroll"><table class="eslite-order-table" aria-label="誠品訂單明細"><colgroup><col style="width:120px"><col style="width:55px"><col><col style="width:50px"><col style="width:125px"><col style="width:170px"><col style="width:100px"><col style="width:65px"><col style="width:105px"></colgroup><thead><tr><th>時間</th><th>帳號</th><th>商品</th><th class="eslite-num">數量</th><th>訂單編號</th><th>付款／ATM 資訊</th><th>結果</th><th>耗時</th><th>操作</th></tr></thead><tbody id="eslite-sheet-orders"><tr><td colspan="9" class="eslite-empty">尚無下單紀錄</td></tr></tbody></table></div></section>`;

export function esliteSheetEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function esliteSheetTime(value, clockOnly = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false,
    ...(clockOnly ? {} : { month: '2-digit', day: '2-digit' }), hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

export function esliteSheetOutcome(item) {
  if ((item.orderStatus || item.status) === 'order_failed') return { group: 'failed', text: '訂單失敗', tone: 'bad' };
  if (['canceled', 'cancelled'].includes(item.orderStatus || item.status)) return { group: 'canceled', text: '訂單取消', tone: 'bad' };
  if (['shipped', 'completed'].includes(item.orderStatus || item.status) && (item.orderId || item.orderNumber)) return {
    group: 'ordered', text: (item.orderStatus || item.status) === 'completed' ? '訂單完成' : '已出貨', tone: 'ok' };
  if (item.status === 'submitted_unconfirmed') return { group: 'unknown', text: '待核對', tone: 'eslite-warning' };
  const order = Boolean(item.orderId || item.orderNumber);
  if (order && ['ordered', 'success', 'payment_failed', '3ds_pending'].includes(item.status)) {
    return { group: 'ordered', text: item.paymentStatus === 'payment_paid' ? '已付款' : item.payment==='line_pay_home'?'成立／LINE Pay 待付款':item.status === 'payment_failed' ? '成立／付款失敗' : item.status === '3ds_pending' ? '成立／待驗證' : '訂單成立', tone: 'ok' };
  }
  if (item.status === 'processing') return { group: 'processing', text: '處理中', tone: 'eslite-warning' };
  // Never turn an unverified old success label into a confirmed order.
  if (['ordered', 'success'].includes(item.status)) return { group: 'unknown', text: '待核對', tone: 'eslite-warning' };
  const labels = { failed: '未成立', stock_out: '售罄', checkout_limited: '限購', carted: '停在購物車', cart: '停在購物車', cancelled: '已取消', canceled: '已取消' };
  return { group: 'failed', text: labels[item.status] || item.status || '未確認', tone: 'bad' };
}

export function esliteSheetRecords(autoPurchase = {}, filters = {}) {
  const seen = new Set();
  const rows = [];
  for (const item of [...(autoPurchase.inProgress || []), ...(autoPurchase.recent || []), ...(autoPurchase.esliteOrders || [])]) {
    if (item.platform !== 'eslite') continue;
    const key = item.taskId || [item.accountSlot, item.orderId || item.orderNumber || '', item.startedAt || '', item.product?.id || item.product?.title || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ item, key });
  }
  rows.sort((a, b) => (Date.parse(b.item.completedAt || b.item.startedAt) || 0) - (Date.parse(a.item.completedAt || a.item.startedAt) || 0));
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
  return { total: rows.length, rows: rows.filter(({ item }) => (!filters.account || item.accountSlot === filters.account)
    && (!filters.status || esliteSheetOutcome(item).group === filters.status)
    && (!keyword || [item.product?.title, item.product?.id, ...(item.products || []).map(p => p.title || p.id), item.orderId, item.orderNumber].join(' ').toLocaleLowerCase().includes(keyword))) };
}

export function esliteSheetStepsHtml(item) {
  const e = esliteSheetEscape;
  const states = { start: item.status === 'processing' ? '進行中' : '開始', success: '完成', retry: '重試', failed: '停止', unknown: '待核對', info: '紀錄' };
  // Explain old action labels, but never invent their missing verification results.
  const legacy = {
    'API 取消紅利折抵': ['取消購物車紅利折抵', '要求官網把使用紅利設定為 0 點'],
    'API 核對宅配 ATM 與金額': ['核對 ATM 宅配方案及訂單金額', '讀取官網可用配送／付款方式，核對應付金額'],
    'API 送出 ATM 訂單': ['向官網送出 ATM 訂單', '提交商品、收件及 ATM 付款資料；送出不等於成立'],
    'API 送單回應': ['接收官網送單回覆', '接收送單結果；HTTP 200 本身不代表取得正式單號'],
    '官方訂單編號與商品確認': ['讀取正式訂單並核對商品', '查詢本帳號訂單，核對單號、品項、數量與金額'],
    '原訂單唯讀核對 ATM 銀行、帳號與期限': ['補查原訂單的 ATM 轉帳資料', '只查既有訂單的銀行、轉帳帳號及期限，不建立新單']
  };
  const steps = item.steps?.length ? item.steps : item.timings?.steps || [];
  return '<div class="eslite-step-log">' + (steps.some(step=>!step.reason) ? '<div class="muted">舊步驟缺少確認細節；以下僅補充動作說明，不能只憑回應碼判定成功。</div>' : '')
    + '<div class="eslite-step-line"><span>時間</span><span>累計耗時</span><span>執行動作與確認結果</span><span>狀態</span></div>' + (item.error ? '<div class="eslite-step-error">' + e(item.error) + '</div>' : '')
    + (steps.length ? steps.map((step,index) => '<div class="eslite-step-line"><span class="muted">' + e(esliteSheetTime(step.at, true))
      + '</span><span class="muted">' + ((step.at || Number(step.elapsedMs)>0) && step.elapsedMs != null && Number.isFinite(Number(step.elapsedMs)) ? '+' + (Number(step.elapsedMs) / 1000).toFixed(2) + 's' : '—') + '</span><span>' + (step.displayLabel ? e(step.displayLabel) : String(index+1).padStart(2,'0') + '｜' + e(legacy[step.label]?.[0] || step.label))
      + '</span><span class="' + (step.state === 'success' ? 'ok' : step.state === 'failed' ? 'bad' : 'muted') + '">' + e(states[step.state] || step.state || '')
      + '</span><small>' + e([step.reason ? (step.state==='start'?'執行內容：':'結果／處理方式：')+step.reason : legacy[step.label] ? '步驟說明：'+legacy[step.label][1] : '確認細節未記錄',step.attempt ? '嘗試第 ' + step.attempt + ' 次' : '',step.httpStatus ? '網站回應碼 HTTP ' + step.httpStatus : ''].filter(Boolean).join(' · ')) + '</small></div>').join('') : '<span class="muted">此筆舊紀錄沒有逐步日誌</span>') + '</div>';
}

export function esliteSheetOrderRowsHtml(records, expanded = new Set()) {
  const e = esliteSheetEscape;
  return records.map(({ item, key }) => {
    const outcome = esliteSheetOutcome(item);
    const orderId = item.orderId || item.orderNumber || '—';
    const href = /^https:\/\//i.test(item.resultUrl || '') ? item.resultUrl : '';
    const paymentHref = /^https:\/\//i.test(item.paymentUrl || '') ? item.paymentUrl : '';
    const payment = { virtual_atm_home: '宅配 ATM', seven_cod: '7-11 貨到付款',line_pay_home:'宅配 LINE Pay（待付款）' }[item.payment || item.paymentType] || '未記錄';
    const amount = item.amount != null && Number.isFinite(Number(item.amount)) ? 'NT$' + Number(item.amount).toLocaleString('zh-TW') : '';
    const paymentNote = item.paymentStatus === 'payment_paid' ? '已付款' : item.paymentDeadline ? '期限 ' + esliteSheetTime(item.paymentDeadline) : item.payment === 'virtual_atm_home' && orderId !== '—' ? paymentHref ? '轉帳資料見付款頁' : '轉帳資訊未記錄' : '';
    const open = expanded.has(key);
    const quantity = item.quantity ?? item.product?.quantity;
    const product = item.mode === 'batch' && item.products?.length ? item.products.map(p => `${p.title || p.id} ×${p.quantity}`).join(' ＋ ') : item.product?.title || '未命名商品';
    return '<tr><td class="eslite-nowrap">' + e(esliteSheetTime(item.completedAt || item.startedAt)) + '</td><td class="eslite-num">' + e(item.accountSlot || '—')
      + '</td><td class="eslite-truncate eslite-order-product" title="' + e(product) + '">' + e(product) + '</td><td class="eslite-num">' + e(quantity ?? '—')
      + '</td><td>' + (href ? '<a target="_blank" rel="noopener noreferrer" href="' + e(href) + '">' + e(orderId) + '</a>' : e(orderId))
      + '</td><td>' + e(payment) + (amount || paymentNote ? '<small>' + e([amount, paymentNote].filter(Boolean).join(' · ')) + '</small>' : '')
      + (paymentHref ? '<small><a target="_blank" rel="noopener noreferrer" href="' + e(paymentHref) + '">付款資訊</a></small>' : '')
      + (item.bankCode && item.bankAccount ? '<small>' + e(item.bankCode + ' · ' + item.bankAccount) + '</small>' : '')
      + '</td><td class="' + outcome.tone + '" title="' + e(item.orderStatusError ? '補查暫時失敗：' + item.orderStatusError + '；保留上次結果' : item.orderStatusCheckedAt ? '官方查單：' + esliteSheetTime(item.orderStatusCheckedAt) : '尚未更新官方後續狀態') + '">' + e(outcome.text) + '</td><td class="eslite-nowrap">' + (Number.isFinite(item.durationMs) ? (item.durationMs / 1000).toFixed(2) + 's' : '—')
      + '</td><td><button type="button" data-eslite-step="' + e(key) + '" aria-expanded="' + open + '" aria-label="' + e((open ? '收合' : '查看') + '帳號 ' + (item.accountSlot || '') + ' ' + product + ' 步驟') + '">' + (open ? '收合' : '步驟') + '</button> <button type="button" data-eslite-export="' + e(key) + '" aria-label="匯出此筆完整步驟 TXT">TXT</button></td></tr>'
      + (open ? '<tr class="eslite-step-row"><td colspan="9">' + esliteSheetStepsHtml(item) + '</td></tr>' : '');
  }).join('') || '<tr><td colspan="9" class="eslite-empty">沒有符合條件的紀錄</td></tr>';
}

export function esliteAccountReadiness(autoPurchase, account, runtime) {
  if (!account.ready) return { text: '未設定', tone: 'muted' };
  if (runtime.purchaseHold) return { text: '訂單待核對', tone: 'eslite-warning' };
  if (runtime.busy) return { text: '正在下單', tone: 'ok' };
  if (account.enabled === false) return { text: '已停用', tone: 'muted' };
  const setup = runtime.accountPreparationState;
  if (setup === 'queued' || setup === 'running') return { text: '自動辨識中', tone: 'eslite-warning' };
  if (runtime.manualLoginRequired || setup === 'human_required') return { text: '需人工驗證', tone: 'eslite-warning' };
  if (runtime.sessionRecoveryState === 'retry_pending') return { text: '登入冷卻／待重試', tone: 'eslite-warning' };
  if (runtime.loginState === 'needs_login') return { text: '待登入', tone: 'eslite-warning' };
  if (setup === 'incomplete') return { text: '資料待補', tone: 'eslite-warning' };
  if (setup === 'retry_pending') return { text: '檢查待重試', tone: 'eslite-warning' };
  if (setup === 'cart_not_empty') return { text: '購物車待整理', tone: 'eslite-warning' };
  if (runtime.pickupSetupRequired) return { text: '貨到門市待設定', tone: 'eslite-warning' };
  if (runtime.checkoutTemplateReady === false) return { text: '待準備結帳資料', tone: 'eslite-warning' };
  if (runtime.paymentFallbackReady) return { text: 'ATM 備援' + (runtime.apiReady && runtime.heartbeatEnabled ? '就緒' : '已備妥'), tone: 'eslite-warning' };
  if (!runtime.heartbeatEnabled) return { text: setup === 'ready' ? '休眠／資料已備妥' : '休眠／待檢查', tone: 'muted' };
  if (runtime.apiReady) return { text: 'API 就緒', tone: 'ok' };
  return { text: runtime.loginState === 'verifying' ? '檢查中' : '待 API 檢查', tone: 'muted' };
}

export function renderEsliteAccountSheet(autoPurchase, slot, account, runtime, visible) {
  const e = esliteSheetEscape;
  const row = document.getElementById('eslite-sheet-account-' + slot);
  if (!row) return;
  row.hidden = !visible;
  const put = (name, text, tone = '') => { const el = document.getElementById('eslite-sheet-' + name + '-' + slot); el.textContent = text; el.className = tone; return el; };
  document.getElementById('eslite-sheet-identity-' + slot).innerHTML = '<strong>' + e(slot + ' · ' + (account.account || account.displayAccount || '未設定')) + '</strong><small>' + e(autoPurchase.esliteMemberNames?.[slot] || (account.ready ? '姓名待辨識' : '—')) + '</small>';
  const labels = { ready: '已登入', needs_login: '需登入', error: '檢查異常', idle: '待檢查', verifying: '檢查中', logging_in: '登入中' };
  put('login', !account.ready ? '未設定' : account.enabled === false ? '已停用' : labels[runtime.loginState || account.loginState] || '待檢查', runtime.loginState === 'ready' ? 'ok' : '');
  const readiness = esliteAccountReadiness(autoPurchase, account, runtime);
  const apiCell = put('api', readiness.text + (autoPurchase.eslite?.accountModes?.[slot] === 'batch' ? ' · 合單' : ' · 單品'), readiness.tone);
  apiCell.title = runtime.accountPreparationError || runtime.lastVerifyError || runtime.lastHeartbeatResult || '';
  const payment = autoPurchase.eslite?.accountPayments?.[slot] || (['A', 'B', 'C'].includes(slot) ? autoPurchase.eslite?.payment : 'virtual_atm_home');
  put('payment', runtime.paymentFallbackReady ? '取貨付款 → ATM 備援' : payment === 'virtual_atm_home' ? '宅配 ATM' : '7-11 貨到付款');
  put('pending', String((autoPurchase.queue || []).filter(item => item.platform === 'eslite' && item.accountSlot === slot).length), 'eslite-num');
  const purchased = put('purchased', String(runtime.purchasedProductCount ?? '—'), 'eslite-num');
  purchased.title = !runtime.purchaseHistorySyncedAt ? '尚未同步官方已購紀錄' : runtime.purchaseHistoryComplete ? '官方已購紀錄已同步' : '官方已購紀錄部分同步';
  const heartbeat = put('heartbeat', runtime.heartbeatEnabled ? runtime.heartbeatMode === 'accelerated' ? '90 秒' : '10 分鐘' : '休眠', 'muted');
  heartbeat.title = '上次 ' + esliteSheetTime(runtime.lastVerifiedAt) + ' · 下次 ' + esliteSheetTime(runtime.nextVerifyAt);
  const actions = document.getElementById('eslite-sheet-actions-' + slot);
  // Existing official-query and release controls retain their handlers and IDs.
  const query = document.getElementById('eslite-query-orders-' + slot);
  if (query) { query.textContent = '查單'; query.title = '官方查單／同步已購'; actions.append(query); }
  const release = document.getElementById('eslite-release-hold-' + slot);
  if (release) { release.textContent = '解除保護'; release.title = '僅限已核對官方訂單未成立'; actions.append(release); }
}

export function renderEsliteTables(autoPurchase = {}) {
  const root = document.getElementById('eslite-sheet-orders');
  if (!root) return;
  const e = esliteSheetEscape;
  const active = (autoPurchase.inProgress || []).filter(item => item.platform === 'eslite');
  const pending = (autoPurchase.queue || []).filter(item => item.platform === 'eslite');
  const deferred = autoPurchase.esliteWaitingTasks || [];
  const queueRows = [];
  const slots = [...new Set(['A', 'B', 'C', ...[...active, ...pending, ...deferred].map(item => item.accountSlot)])];
  for (const slot of slots) {
    const working = active.filter(item => item.accountSlot === slot);
    const waiting = pending.filter(item => item.accountSlot === slot);
    for (const [index, item] of [...working, ...waiting].entries()) {
      const running = index < working.length;
      const steps = item.steps?.length ? item.steps : item.timings?.steps || [];
      const remaining = item.expiresAt ? Math.max(0, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 1000)) : null;
      const title = item.title || item.product?.title || item.productId || '未命名商品';
      queueRows.push('<tr><td class="eslite-num">' + slot + '</td><td class="eslite-num">' + (running ? '執行中' : index - working.length + 1)
        + '</td><td class="eslite-truncate" title="' + e(title) + '">' + e(title) + '</td><td class="' + (running ? 'ok' : item.blockedReason ? 'eslite-warning' : 'muted')
        + '">' + e(running ? steps.at(-1)?.label || '處理中' : (item.priorityKeyword ? '優先：' + item.priorityKeyword + ' · ' : '') + (item.blockedReason || '等待前一單')) + '</td><td>' + (remaining !== null && Number.isFinite(remaining) ? remaining + ' 秒' : '—') + '</td></tr>');
    }
    for (const item of deferred.filter(item => item.accountSlot === slot)) {
      const retry = item.retryAt ? Math.max(0, Math.ceil((Date.parse(item.retryAt) - Date.now()) / 1000)) : 0;
      queueRows.push('<tr><td class="eslite-num">' + slot + '</td><td class="eslite-num">—</td><td class="eslite-truncate" title="' + e(item.title)
        + '">' + e(item.title) + '</td><td class="eslite-warning">' + e(item.blockedReason) + '</td><td>' + (item.blockedReason === '重試冷卻中' && retry > 0 ? retry + ' 秒' : '—') + '</td></tr>');
    }
  }
  document.getElementById('eslite-sheet-queue').innerHTML = queueRows.join('') || '<tr><td colspan="5" class="eslite-empty">目前沒有待購商品</td></tr>';
  document.getElementById('eslite-sheet-queue-count').textContent = '執行 ' + active.length + ' · 排隊 ' + pending.length + ' · 待觀測／重試 ' + deferred.length;
  const eventState = document.getElementById('eslite-sheet-event-state');
  if (eventState) eventState.textContent = autoPurchase.esliteRestockEvent?.active
    ? '持續補任務 · ' + autoPurchase.esliteRestockEvent.productCount + ' 款' : '等待補貨訊號';
  const selected = esliteSheetRecords(autoPurchase, { keyword: document.getElementById('eslite-sheet-search').value, account: document.getElementById('eslite-sheet-account-filter').value, status: document.getElementById('eslite-sheet-status-filter').value });
  const accountFilter = document.getElementById('eslite-sheet-account-filter');
  if (accountFilter?.options) {
    for (const slot of [...new Set([...(autoPurchase.credentials?.eslite?.accounts || []).map(item => item.slot), ...esliteSheetRecords(autoPurchase).rows.map(({ item }) => item.accountSlot)])]) {
      if (slot && ![...accountFilter.options].some(option => option.value === slot)) {
        const option = document.createElement('option'); option.value = slot; option.textContent = slot; accountFilter.append(option);
      }
    }
  }
  const expanded = root._expandedSteps || (root._expandedSteps = new Set());
  root.innerHTML = esliteSheetOrderRowsHtml(selected.rows, expanded);
  document.getElementById('eslite-sheet-order-count').textContent = selected.rows.length + '／' + selected.total + ' 筆';
  root.onclick = event => {
    const exportButton = event.target.closest('button[data-eslite-export]');
    if (exportButton) { exportPurchaseLog('eslite', exportButton.dataset.esliteExport); return; }
    const button = event.target.closest('button[data-eslite-step]');
    if (!button) return;
    const key = button.dataset.esliteStep;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderEsliteTables(autoPurchase);
    Array.from(root.querySelectorAll('button[data-eslite-step]')).find(item => item.dataset.esliteStep === key)?.focus({ preventScroll: true });
  };
}

export const esliteTableClient = [esliteAccountRowHtml, esliteSheetEscape, esliteSheetTime, esliteSheetOutcome, esliteSheetRecords,
  esliteSheetStepsHtml, esliteSheetOrderRowsHtml, esliteAccountReadiness, renderEsliteAccountSheet, renderEsliteTables].map(fn => fn.toString()).join('\n');
