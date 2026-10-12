import { safePurchaseText, purchaseErrorSummary, safePurchaseStep } from './purchase-diagnostics.js';

export function purchaseLogTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date) : '—';
}

export function compactPurchaseStep(raw, index = 0) {
  const step = safePurchaseStep(raw);
  const number = step.stepNumber || index + 1;
  const action = number === 1 ? '清空購物車' : step.stepTitle || step.label || '未記錄';
  const states = { start: '準備中', success: number === 1 ? '完成清車' : '完成', retry: '重試', failed: '停止', unknown: '待核對', info: '處理中' };
  const status = (states[step.state] || step.state) + (step.state === 'retry' && step.attempt ? ` ${step.attempt}` : '')
    + (step.state === 'failed' && step.reason ? `：${safePurchaseText(step.reason, 80)}` : '');
  return { number, action, status, state: step.state,
    time: purchaseLogTime(step.at), elapsed: (raw.at || Number(raw.elapsedMs) > 0) && raw.elapsedMs != null && Number.isFinite(Number(raw.elapsedMs))
      ? `+${(Number(raw.elapsedMs) / 1000).toFixed(1)}s` : '—' };
}

export function purchaseRecordsText(rows) {
  const clean = value => safePurchaseText(value, 200);
  const payments = { seven_cod: '7-11 取貨付款', virtual_atm_home: '宅配 ATM', line_pay_home: '宅配 LINE Pay' };
  const outcomes = { ordered: '訂單成立', canceled: '訂單取消', cancelled: '訂單取消', order_failed: '訂單失敗', shipped: '已出貨', completed: '訂單完成', success: '流程成功，待核對單號', failed: '未成立',
    submitted_unconfirmed: '送單結果待核對', processing: '執行中', stock_out: '售罄', carted: '停在購物車', checkout_ready: '結帳資料已核對，未送單' };
  const lines = ['自動下單步驟｜台灣時間｜— = 未記錄', ''];
  for (const { item } of rows) {
    const title = item.mode === 'batch' && item.products?.length ? item.products.map(p => `${p.title || p.id} ×${p.quantity}`).join(' ＋ ') : `${item.product?.title || item.product?.id || '—'} ×${item.quantity ?? '—'}`;
    lines.push(`【${item.platform === 'funbox' ? 'FUNBOX' : '誠品'} ${clean(item.accountSlot || '—')}】${clean(title)}`,
      `佇列：${clean(item.queueId || item.taskId || '—')}｜單號：${clean(item.orderId || item.orderNumber || '—')}｜${payments[item.payment || item.paymentType] || '未記錄'}｜${outcomes[item.status] || clean(item.status || '未記錄')}`);
    if (item.paymentFallback) lines.push(`備援：${payments[item.paymentFallback.from]} → ${payments[item.paymentFallback.to]}`);
    if (item.error) lines.push(`錯誤：${purchaseErrorSummary(item.error)}`);
    const steps = item.steps?.length ? item.steps : item.timings?.steps || [];
    if (!steps.length) lines.push('此筆紀錄沒有逐步日誌；不推測或補造。');
    const compact = steps.map(compactPurchaseStep);
    if (compact.length) lines.push('步驟｜時間｜加秒｜動作｜狀態｜下一步');
    compact.forEach((step, index) => {
      const next = step.state === 'unknown' ? '唯讀查單' : step.state === 'failed' ? '下一筆任務／待補資料'
        : step.state === 'start' ? '等待完成' : step.state === 'retry' ? step.action
        : compact.slice(index + 1).find(future => future.number !== step.number)?.action || '結束';
      lines.push(`${String(step.number).padStart(2, '0')}｜${step.time}｜${step.elapsed}｜${step.action}｜${step.status}｜${next}`);
    });
    lines.push('');
  }
  return lines.join('\r\n');
}

export function exportPurchaseLog(platform, key) {
  if (!['eslite', 'funbox'].includes(platform)) return;
  const prefix = platform + '-sheet-';
  const filters = key ? {} : { keyword: document.getElementById(prefix + 'search')?.value,
    account: document.getElementById(prefix + 'account-filter')?.value, status: document.getElementById(prefix + 'status-filter')?.value };
  const selected = (platform === 'eslite' ? esliteSheetRecords : funboxSheetRecords)(currentStatus?.autoPurchase || {}, filters);
  const rows = key ? selected.rows.filter(row => row.key === key) : selected.rows;
  if (!rows.length) { alert('目前沒有可匯出的紀錄。'); return; }
  const blob = new Blob(['\uFEFF', purchaseRecordsText(rows)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const identity = key ? `${rows[0].item.accountSlot || ''}-${rows[0].item.orderId || rows[0].item.orderNumber || 'task'}` : 'filtered';
  link.download = `${platform}-${identity}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`.replace(/[^\w.\-]/g, '_');
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const purchaseLogExportClient = [safePurchaseText, purchaseErrorSummary, safePurchaseStep, purchaseLogTime, compactPurchaseStep, purchaseRecordsText, exportPurchaseLog].map(fn => fn.toString()).join('\n');
