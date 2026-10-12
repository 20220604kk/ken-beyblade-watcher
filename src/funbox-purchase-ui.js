import { esliteOrderTablesHtml, esliteSheetOutcome } from './eslite-purchase-ui.js';

// Presentation only: rendering never requests a storefront or changes a cart.
export function funboxAccountRowHtml(slot) {
  return `<tr id="funbox-sheet-account-${slot}"><td id="funbox-sheet-identity-${slot}">${slot}</td><td id="funbox-sheet-login-${slot}">—</td><td id="funbox-sheet-api-${slot}">—</td><td id="funbox-sheet-payment-${slot}">—</td><td id="funbox-sheet-pending-${slot}" class="eslite-num">0</td><td id="funbox-sheet-purchased-${slot}" class="eslite-num">0</td><td id="funbox-sheet-heartbeat-${slot}">—</td><td><div class="eslite-actions"><button type="button" onclick="testAutoPurchaseLogin('funbox','${slot}')">登入</button><button type="button" onclick="completeAutoPurchaseLogin('funbox','${slot}')">檢查</button><button id="funbox-sheet-settings-${slot}" type="button" aria-expanded="false" onclick="toggleFunboxAccountCard('${slot}')">帳密設定</button><button id="funbox-sheet-hold-${slot}" type="button" hidden onclick="resolveFunboxHold('${slot}')">核對未成立</button></div></td></tr>`;
}

export const funboxAccountTableHtml = `<div class="eslite-sheet"><div class="eslite-sheet-scroll"><table class="eslite-account-table funbox-account-table" aria-label="FUNBOX 帳號狀態"><colgroup><col style="width:140px"><col style="width:90px"><col style="width:130px"><col style="width:110px"><col style="width:55px"><col style="width:60px"><col style="width:120px"><col style="width:250px"></colgroup><thead><tr><th>帳號</th><th>登入</th><th>下單狀態</th><th>付款</th><th>待購</th><th>已購款</th><th>心跳</th><th>操作</th></tr></thead><tbody>${['A', 'B', 'C'].map(funboxAccountRowHtml).join('')}</tbody></table></div></div>`;
export const funboxOrderTablesHtml = esliteOrderTablesHtml.replaceAll('eslite-sheet-', 'funbox-sheet-').replaceAll('renderEsliteTables', 'renderFunboxTables').replaceAll("exportPurchaseLog('eslite')", "exportPurchaseLog('funbox')").replaceAll("refreshPurchaseOrderStatuses('eslite',true)", "refreshPurchaseOrderStatuses('funbox',true)").replaceAll('誠品', 'FUNBOX');
export const funboxTableCss = `.funbox-purchase-panel .funbox-account.compact{display:none}.funbox-purchase-panel .eslite-account-head-actions{display:none}.funbox-purchase-panel .funbox-account-list{margin:8px 0}.funbox-purchase-panel .compact-copy{font-size:12px}.funbox-purchase-panel .field button{font-size:12px;padding:7px 10px}`;

export function funboxSheetRecords(autoPurchase = {}, filters = {}) {
  const seen = new Set(), rows = [];
  const add = item => {
    const key = item.orderNumber ? [item.accountSlot, item.orderNumber].join('|')
      : item.taskId || [item.accountSlot, item.startedAt || item.completedAt, item.product?.id, item.status].join('|');
    if (seen.has(key)) return;
    seen.add(key); rows.push({ item, key });
  };
  for (const record of [...(autoPurchase.inProgress || []), ...(autoPurchase.recent || []), ...(autoPurchase.funboxOrders || [])]) {
    if (record.platform !== 'funbox') continue;
    if (record.accountResults?.length) {
      for (const account of record.accountResults) {
        const waves = account.waves?.length ? account.waves : [account];
        for (const wave of waves) {
          const products = wave.products || account.products || record.products || [record.product];
          add({ ...record, ...wave, accountResults: undefined, accountSlot: account.slot, payment: account.payment,
            product: { title: products.filter(Boolean).map(p => p.title || p.id).join(' ＋ ') },
            quantity: wave.quantity ?? (products.length === 1 ? products[0]?.quantity : undefined) });
        }
      }
    } else if (record.accountSlot || record.slot) add({ ...record, accountSlot: record.accountSlot || record.slot,
      ...(record.mode === 'batch' && record.products?.length ? { product: { ...record.product, title: record.products.map(p => `${p.title || p.id} ×${p.quantity}`).join(' ＋ ') } } : {}) });
  }
  rows.sort((a, b) => (Date.parse(b.item.completedAt || b.item.startedAt) || 0) - (Date.parse(a.item.completedAt || a.item.startedAt) || 0));
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  return { total: rows.length, rows: rows.filter(({ item }) => (!filters.account || item.accountSlot === filters.account)
    && (!filters.status || esliteSheetOutcome(item).group === filters.status)
    && (!keyword || [item.product?.title, item.product?.id, item.orderNumber].join(' ').toLowerCase().includes(keyword))) };
}

export function renderFunboxTables(autoPurchase = {}) {
  const e = esliteSheetEscape, root = document.getElementById('funbox-sheet-orders');
  if (!root) return;
  const accounts = autoPurchase.credentials?.funbox?.accounts || [], runtimes = autoPurchase.runtime?.funbox?.accounts || [];
  const labels = { ready: '已登入', needs_login: '需登入', checking: '檢查中', warming: '準備中', error: '檢查異常', idle: '待檢查' };
  for (const slot of currentFunboxSlots()) {
    const account = accounts.find(item => item.slot === slot) || {}, runtime = runtimes.find(item => item.slot === slot) || {};
    const put = (name, text, tone = '') => { const cell = document.getElementById('funbox-sheet-' + name + '-' + slot); cell.textContent = text; cell.className = tone; };
    put('identity', slot + ' · ' + (account.displayAccount || account.account || '未設定'));
    put('login', !account.ready ? '未設定' : labels[runtime.loginState || account.loginState] || '待檢查', runtime.loginState === 'ready' ? 'ok' : 'muted');
    const text = !account.ready ? '未設定' : runtime.purchaseHold ? '訂單待核對' : runtime.busy ? '正在下單' : account.enabled === false ? '已停用' : runtime.pickupSetupRequired ? '貨到門市待設定' : !runtime.heartbeatEnabled ? '休眠' : runtime.loginState === 'ready' ? '可接任務' : '待登入檢查';
    put('api', text + (runtime.checkoutTransport === 'http_api' ? ' · API' : runtime.checkoutTransport === 'browser' ? ' · 網頁' : '') + (autoPurchase.funbox?.accountModes?.[slot] === 'batch' ? ' · 合單' : ' · 單品'), runtime.purchaseHold ? 'eslite-warning' : runtime.loginState === 'ready' ? 'ok' : 'muted');
    const payment = autoPurchase.funbox?.accountPayments?.[slot] || autoPurchase.funbox?.payment;
    put('payment', payment === 'virtual_atm_home' ? '宅配 ATM' : '7-11 貨到付款');
    put('pending', String((autoPurchase.queue || []).filter(item => item.platform === 'funbox' && item.accountSlot === slot).length), 'eslite-num');
    put('purchased', String(runtime.purchasedProductCount || 0), 'eslite-num');
    put('heartbeat', runtime.heartbeatEnabled ? '8 分鐘' : '休眠', 'muted');
    document.getElementById('funbox-sheet-hold-' + slot).hidden = !runtime.purchaseHold;
    document.getElementById('funbox-sheet-settings-' + slot).setAttribute('aria-expanded', String(funboxExpandedSlots.has(slot)));
  }
  const running = (autoPurchase.inProgress || []).filter(item => item.platform === 'funbox');
  const queue = (autoPurchase.queue || []).filter(item => item.platform === 'funbox');
  const waiting = autoPurchase.funboxWaitingTasks || [], sequence = {};
  document.getElementById('funbox-sheet-queue-count').textContent = queue.length + ' 件待購 · ' + running.length + ' 件執行 · ' + waiting.length + ' 件待新觀測';
  document.getElementById('funbox-sheet-event-state').textContent = autoPurchase.funboxRestockEvent?.active ? '補貨事件持續中' : '等待補貨訊號';
  document.getElementById('funbox-sheet-queue').innerHTML = [...running.map(item => ({ ...item, running: true })), ...queue, ...waiting.map(item => ({ ...item, waiting: true }))].map(item => {
    const order = item.running ? '執行中' : item.waiting ? '—' : (sequence[item.accountSlot] = (sequence[item.accountSlot] || 0) + 1);
    const remaining = item.expiresAt ? Math.max(0, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 1000)) + 's' : '—';
    return '<tr><td>' + e(item.accountSlot) + '</td><td class="eslite-num">' + e(order) + '</td><td>' + e(item.product?.title || item.title) + '</td><td>' + e(item.running ? item.steps?.at(-1)?.label || '處理中' : item.blockedReason || '待派送') + '</td><td>' + e(remaining) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="eslite-empty">目前沒有待購商品</td></tr>';
  const filter = document.getElementById('funbox-sheet-account-filter');
  for (const slot of currentFunboxSlots()) if (!Array.from(filter.options).some(option => option.value === slot)) { const option = document.createElement('option'); option.value = slot; option.textContent = slot; filter.append(option); }
  const selected = funboxSheetRecords(autoPurchase, { keyword: document.getElementById('funbox-sheet-search').value, account: filter.value, status: document.getElementById('funbox-sheet-status-filter').value });
  const expanded = root._expandedSteps || (root._expandedSteps = new Set());
  root.innerHTML = esliteSheetOrderRowsHtml(selected.rows, expanded).replaceAll('data-eslite-step', 'data-funbox-step').replaceAll('data-eslite-export', 'data-funbox-export');
  document.getElementById('funbox-sheet-order-count').textContent = selected.rows.length + '／' + selected.total + ' 筆';
  root.onclick = event => { const exportButton = event.target.closest('button[data-funbox-export]'); if (exportButton) { exportPurchaseLog('funbox', exportButton.dataset.funboxExport); return; } const button = event.target.closest('button[data-funbox-step]'); if (!button) return; const key = button.dataset.funboxStep; if (expanded.has(key)) expanded.delete(key); else expanded.add(key); renderFunboxTables(autoPurchase); };
}

export const funboxTableClient = [funboxAccountRowHtml, funboxSheetRecords, renderFunboxTables].map(fn => fn.toString()).join('\n');
