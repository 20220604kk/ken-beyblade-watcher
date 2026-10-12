// Contract observed on the official /member/orders page on 2026-10-09.
// This is the site's public response encoding, NOT an authentication bypass.
const RESPONSE_KEY = 'RRD6FAz9.KtEba77r.zE6y!A@NMMbrWG';

export function decodeEsliteOrderBody(body) {
  if (!body || typeof body !== 'object') throw new Error('訂單 API 格式無法確認');
  if (typeof body.message !== 'string') return body;
  const encoded = [...body.message].map((char, i) => String.fromCharCode(
    char.charCodeAt(0) ^ RESPONSE_KEY.charCodeAt(i % RESPONSE_KEY.length))).join('');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('官方訂單回應編碼無法確認');
  try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('官方訂單回應格式已變更'); }
}

export function esliteOrderTime(value) {
  const text = String(value || '');
  if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return Date.parse(text.replaceAll('/', '-').replace(' ', 'T') + '+08:00');
  }
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
}

async function read(api, url, timeoutMs) {
  const response = await api.get(url, { timeout: timeoutMs, maxRetries: 0 });
  try {
    if (!response.ok()) throw new Error(`官方查單暫時無法確認（HTTP ${response.status()}）`);
    return decodeEsliteOrderBody(await response.json());
  } finally { await response.dispose?.(); }
}

export function summarizeEsliteOrder(body) {
  if (!body?.order_id || !body.order_number || !Array.isArray(body.sub_orders)) {
    throw new Error('官方訂單明細缺少必要欄位');
  }
  const items = body.sub_orders.flatMap(sub => {
    if (!sub.status || !Array.isArray(sub.sub_order_items)) throw new Error('官方子訂單格式無法確認');
    return sub.sub_order_items.filter(item => item.item_type === 'product').map(item => ({
      id: String(item.product_guid || ''), title: String(item.product_name || ''), quantity: Number(item.quantity),
      canceled: Boolean(sub.status.order_canceled || sub.status.order_failed || sub.status.order_split_canceled)
    }));
  });
  if (!items.length || items.some(i => !i.id || !Number.isInteger(i.quantity) || i.quantity < 1)) {
    throw new Error('官方訂單商品無法確認');
  }
  const statuses = body.sub_orders.map(sub => sub.status);
  const canceled = status => Boolean(status.order_canceled || status.order_split_canceled);
  const orderStatus = statuses.every(canceled) ? 'canceled'
    : statuses.every(status => status.order_failed) ? 'order_failed'
    : statuses.every(status => status.order_finished) ? 'completed'
    : statuses.every(status => status.order_shipped || status.order_arrived || status.order_finished) ? 'shipped' : 'ordered';
  return {
    officialId: String(body.order_id), orderId: String(body.order_number), createdAt: String(body.created_at),
    items, paymentStatus: String(body.payment?.status || ''), paymentType: String(body.payment?.type || ''),
    paymentDeadline: String(body.payment?.expired || ''), amount: Number(body.amount),
    resultUrl: 'https://www.eslite.com/member/orders', orderStatus,
    orderStatusLabel: { canceled: '訂單取消', order_failed: '訂單失敗', completed: '訂單完成', shipped: '已出貨', ordered: '訂單成立' }[orderStatus]
  };
}

// A bounded read-only scan. Absence is NEVER evidence that a POST was rejected.
export async function readEsliteOrderHistory(api, {
  startedAt = '', expectedOrderId = '', maxPages = 3, maxDetails = 12, timeoutMs = 8000, maxDurationMs = 20000, onDetail = null
} = {}) {
  const deadline = Date.now() + Math.max(1, maxDurationMs);
  const remaining = () => {
    const value = Math.min(timeoutMs, deadline - Date.now());
    if (value <= 0) throw new Error('官方查單超過本次等待期限；保持結果不明保護');
    return value;
  };
  const since = startedAt ? esliteOrderTime(startedAt) : NaN;
  if (startedAt && !Number.isFinite(since)) throw new Error('查單起始時間無法確認');
  const orders = [];
  let scannedDetails = 0, complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const list = await read(api, `/api/v1/member_orders?page=${page}&keyword=&start_at=&end_at=`, remaining());
    if (!Array.isArray(list.orders) || list.current_page !== page || !Number.isInteger(list.total_pages)) {
      throw new Error('官方訂單列表或分頁格式已變更');
    }
    for (const entry of list.orders) {
      if (!/^\d+$/.test(String(entry.order_id)) || !entry.order_number) throw new Error('官方訂單識別無法確認');
      if (expectedOrderId && String(entry.order_number) !== String(expectedOrderId)) continue;
      const time = esliteOrderTime(entry.created_at);
      if (startedAt && (!Number.isFinite(time) || time < since - 5000 || time > since + 120000)) continue;
      if (scannedDetails >= maxDetails) return { orders, complete: false };
      scannedDetails++;
      const body = await read(api, `/api/v2/orders/details/${entry.order_id}`, remaining());
      const detail = summarizeEsliteOrder(body);
      if (detail.officialId !== String(entry.order_id) || detail.orderId !== String(entry.order_number)) {
        throw new Error('官方列表與明細訂單身分不符');
      }
      orders.push(detail);
      await onDetail?.(body);
    }
    if (page >= list.total_pages) { complete = true; break; }
  }
  return { orders, complete };
}

export function matchEsliteSingleProductOrder(orders, { productId, quantity, startedAt, expectedOrderId = '' }) {
  return matchEsliteProductOrder(orders, { products: [{ id: String(productId), quantity: Number(quantity) }], startedAt, expectedOrderId });
}

export function matchEsliteProductOrder(orders, { products, startedAt, expectedOrderId = '' }) {
  const start = esliteOrderTime(startedAt);
  if (!Number.isFinite(start)) return null;
  const matches = orders.filter(order => {
    const at = esliteOrderTime(order.createdAt);
    return (!expectedOrderId || order.orderId === String(expectedOrderId))
      && Number.isFinite(at) && at >= start - 5000 && at <= start + 120000
      && Array.isArray(products) && products.length > 0 && new Set(products.map(p=>String(p.id))).size === products.length
      && order.items.length === products.length
      && products.every(p => order.items.filter(item=>!item.canceled && item.id===String(p.id) && item.quantity===Number(p.quantity)).length === 1);
  });
  return matches.length === 1 ? matches[0] : null;
}
