// Diagnostics are an allowlisted view, never a dump of a request or response.
export function safePurchaseText(value, limit = 600) {
  return String(value?.message || value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n|Call log:|Request headers:|Response headers:/i)[0]
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[憑證已遮罩]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[憑證已遮罩]')
    .replace(/\b(?:authorization|cookie|set-cookie|password|access_token|refresh_token)\b["']?\s*[:=]\s*[^\r\n]*/gi, '[敏感資料已省略]')
    .trim().slice(0, limit);
}

export function purchaseErrorSummary(error) {
  const text = safePurchaseText(error);
  const timeout = text.match(/Timeout\s+(\d+)ms/i);
  if (timeout) return `網站回應逾時（等待 ${(Number(timeout[1]) / 1000).toFixed(1)} 秒）`;
  if (/<!doctype|<html/i.test(text)) return '網站回傳錯誤頁面，未取得有效 API 資料';
  if (/ECONN|ENET|socket|Read timed out|fetch failed/i.test(text)) return '網站連線暫時中斷';
  return text || '網站未提供可確認的結果';
}

export function safePurchaseStep(step = {}) {
  const label = safePurchaseText(step.label, 100);
  const phases = [
    [1, '購物車', /清空|清車|會員與空車|會員與購物車準備|沿用已驗證/],
    [2, '核對派單任務', /核對派單任務/],
    [3, '加入商品', /開始加車|指定商品已加入|加車確認|加車回應待核對/],
    [4, '核對購物車商品', /單品購物車|合單購物車|購物車封箱|排除不可購品項|讀取並核對本次購物車|購物車商品核對完成|購物車讀取補查/],
    [5, '讀取結帳資料', /官方結帳資料|官方庫存已同步|準備結帳資料/],
    [6, '紅利歸零', /紅利|折抵/],
    [7, '核對配送付款', /可用配送與付款|改用最後補救/],
    [14, '保存訂單資料', /永久記錄|永久保存|保存訂單資料/],
    [8, '核對取貨門市', /門市|電子地圖|選店|配送條件/],
    [9, '核對訂單金額', /結帳方案與金額|含運總額/],
    [10, '保存送單基準', /送單前查單基準|保存送單意圖/],
    [11, '送出訂單', /向官方送出訂單|開始送單|送單回覆|送單回應|拒單|網站忙碌|送單連線/],
    [12, '核對正式訂單', /正式訂單|新訂單已出現|訂單確認|查詢官方訂單|送單結果待核對|送單結果不明/],
    [13, '取得付款資訊', /ATM|轉帳|付款資訊/],
    [15, '私人通知', /私人通知/]
  ];
  const phase = phases.find(([, , pattern]) => pattern.test(label));
  const number = Number(step.stepNumber) || phase?.[0];
  const title = safePurchaseText(step.stepTitle || phase?.[1] || label, 80);
  const state = safePurchaseText(step.state || 'info', 30);
  const complete = state === 'success';
  const current = complete ? 1 : 0;
  const action = complete ? (number === 2 ? '核對成功' : '完成')
    : state === 'start' ? (number === 1 ? '清空中' : number === 2 ? '本次取得任務' : '執行中')
    : ({ retry: '重試中', failed: '停止', unknown: '待核對', info: '處理中' }[state] || '處理中');
  return {
    at: safePurchaseText(step.at, 40),
    label,
    state,
    ...(number ? { stepNumber: number, stepTitle: title, progressCurrent: current, progressTotal: 1,
      displayLabel: `${String(number).padStart(2, '0')}｜${title} ${action}${number === 2 && step.taskNumber ? ' ' + String(step.taskNumber).padStart(2, '0') : ''} ${current}/1` } : {}),
    ...(step.taskNumber ? { taskNumber: Math.max(1, Number(step.taskNumber) || 1) } : {}),
    elapsedMs: Math.max(0, Number(step.elapsedMs) || 0),
    ...(Number.isFinite(step.durationMs) ? { durationMs: Math.max(0, step.durationMs) } : {}),
    ...(Number.isFinite(step.httpStatus) ? { httpStatus: step.httpStatus } : {}),
    ...(Number.isFinite(step.attempt) ? { attempt: step.attempt } : {}),
    ...(step.reason ? { reason: purchaseErrorSummary(step.reason) } : {})
  };
}
