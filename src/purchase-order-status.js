import { parseFunboxOrderReceipt, officialFunboxUrl } from './funbox-api-checkout.js';
import { readAndReleaseResponse } from './api-response.js';
import { readEsliteOrderHistory, decodeEsliteOrderBody, summarizeEsliteOrder } from './eslite-orders.js';
import { purchaseErrorSummary } from './purchase-diagnostics.js';

const terminal = new Set(['canceled', 'cancelled', 'completed', 'order_failed']);

// Only first-party, authenticated GETs. Never login, clear carts, or submit here.
export async function readFunboxOrderStatus(api, record) {
  const url = new URL(officialFunboxUrl(record.resultUrl));
  const token = url.pathname.match(/^\/(?:account\/)?orders\/([a-z0-9]{32})\/?$/i)?.[1];
  if (!token) throw new Error('缺少正式訂單明細連結');
  const target = `https://shop.funbox.com.tw/account/orders/${token}`;
  const response = await api.get(target, { timeout: 5000, maxRedirects: 0, maxRetries: 0 });
  const html = await readAndReleaseResponse(response);
  if (!response.ok() || response.url() !== target) throw new Error(`官方查單無法確認（HTTP ${response.status()}）`);
  const receipt = parseFunboxOrderReceipt(html, target);
  if (!receipt.orderNumber || receipt.orderNumber !== String(record.orderNumber || record.orderId)) throw new Error('官方明細單號不符；保留原結果');
  if (!receipt.orderStatus) throw new Error('官方訂單狀態格式無法确认；保留原結果');
  return { orderId: receipt.orderNumber, status: receipt.orderStatus, paymentStatus: receipt.paymentStatus,
    orderStatusLabel: receipt.orderStatusLabel };
}

export async function readEsliteOrderStatus(api, record) {
  let order;
  if (/^\d+$/.test(String(record.officialId || ''))) {
    const response = await api.get(`/api/v2/orders/details/${record.officialId}`, { timeout: 5000, maxRetries: 0 });
    const status = response.status();
    const body = await readAndReleaseResponse(response, 'json');
    if (status !== 200) throw new Error(`官方查單無法確認（HTTP ${status}）`);
    order = summarizeEsliteOrder(decodeEsliteOrderBody(body));
  } else {
    const history = await readEsliteOrderHistory(api, { expectedOrderId: String(record.orderId), maxPages: 2,
      maxDetails: 1, timeoutMs: 4000, maxDurationMs: 8000 });
    order = history.orders.find(item => item.orderId === String(record.orderId));
  }
  if (!order || order.orderId !== String(record.orderId) || record.officialId && order.officialId !== String(record.officialId)) throw new Error('官方尚未確認這張訂單；保留原結果');
  return { ...order, status: order.orderStatus || 'ordered' };
}

// Metadata is persisted with records: reloading the UI/service cannot multiply polling.
export class PurchaseOrderStatusRefresher {
  constructor({ getStorage, isBusy, readOrder, save, now = Date.now, intervalMs = 600000 }) {
    Object.assign(this, { getStorage, isBusy, readOrder, save, now, intervalMs });
    this.pending = new Map();
  }

  entries(platform) {
    const storage = this.getStorage(), result = [];
    for (const parent of [...Object.values(storage.records || {}), ...(storage.recent || [])]) {
      if (parent.platform !== platform) continue;
      if (platform === 'funbox' && parent.accountResults?.length) {
        for (const account of parent.accountResults) for (const child of account.waves?.length ? account.waves : [account]) {
          result.push({ ref: child, item: { ...parent, ...child, accountSlot: account.slot, accountIdentity: account.accountIdentity || child.accountIdentity || '' } });
        }
      } else result.push({ ref: parent, item: parent });
    }
    return result;
  }

  refresh(options = {}) {
    const platform = options.platform;
    if (!['funbox', 'eslite'].includes(platform)) throw new Error('查單平台不正確');
    if (this.pending.has(platform)) return this.pending.get(platform);
    const work = this.run(options).finally(() => this.pending.delete(platform));
    this.pending.set(platform, work);
    return work;
  }

  async run({ platform, force = false, orderId = '', accountSlot = '' }) {
    if (this.isBusy(platform)) return { deferred: true, checked: 0, message: '搶購／登入正在進行，查單延後；不影響任務' };
    const storage = this.getStorage(), now = this.now();
    storage.orderStatusSync ||= {};
    const previous = storage.orderStatusSync[platform] || {};
    const cooldown = force ? 30000 : this.intervalMs;
    if (previous.attemptedAt && now - Date.parse(previous.attemptedAt) < cooldown) return { cached: true, checked: 0, message: force ? '剛剛已查單，30 秒後可再次更新' : '沿用查單快取' };
    const entries = this.entries(platform), seen = new Set();
    const candidates = entries.filter(({ item }) => {
      const id = item.orderNumber || item.orderId;
      const key = `${item.accountSlot}|${id}`;
      if (!id || !item.accountSlot || item.status === 'processing' || item.status === 'submitted_unconfirmed' || seen.has(key)) return false;
      if (orderId && String(id) !== String(orderId) || accountSlot && item.accountSlot !== accountSlot) return false;
      if (!force && (terminal.has(item.status) || terminal.has(item.orderStatus)
        || now - Date.parse(item.completedAt || item.startedAt) > 30 * 86400000
        || item.orderStatusCheckedAt && now - Date.parse(item.orderStatusCheckedAt) < this.intervalMs)) return false;
      seen.add(key); return true;
    }).sort((a, b) => (Date.parse(a.item.orderStatusCheckedAt) || 0) - (Date.parse(b.item.orderStatusCheckedAt) || 0)
      || (Date.parse(b.item.startedAt) || 0) - (Date.parse(a.item.startedAt) || 0)).slice(0, force ? 6 : 2);
    if (!candidates.length) return { checked: 0, message: '沒有待更新的正式訂單' };
    storage.orderStatusSync[platform] = { ...previous, attemptedAt: new Date(now).toISOString() };
    let checked = 0, failed = 0, changed = 0;
    const deadline = now + 20000;
    for (const { item } of candidates) {
      if (this.isBusy(platform) || this.now() >= deadline) break;
      const id = item.orderNumber || item.orderId;
      const copies = entries.filter(row => row.item.accountSlot === item.accountSlot
        && String(row.item.orderNumber || row.item.orderId) === String(id)).map(row => row.ref);
      const at = new Date(this.now()).toISOString();
      try {
        const official = await this.readOrder(platform, item);
        if (official?.deferred) continue;
        if (!official || String(official.orderId) !== String(id) || !['ordered', 'canceled', 'shipped', 'completed', 'order_failed'].includes(official.status)) throw new Error('官方狀態無法確認');
        const update = { status: official.status, orderStatus: official.status, orderStatusLabel: official.orderStatusLabel || '',
          orderStatusCheckedAt: at, orderStatusError: '', ...(official.paymentStatus ? { paymentStatus: official.paymentStatus } : {}),
          ...(official.officialId ? { officialId: official.officialId } : {}) };
        if (item.status !== update.status) changed++;
        for (const ref of copies) { ref.orderCreatedStatus ||= ref.status; Object.assign(ref, update); }
        checked++;
      } catch (error) {
        for (const ref of copies) Object.assign(ref, { orderStatusCheckedAt: at, orderStatusError: purchaseErrorSummary(error) });
        failed++;
      }
    }
    Object.assign(storage.orderStatusSync[platform], { checked, failed, changed });
    await this.save();
    return { checked, failed, changed, message: `查單更新 ${checked} 筆${changed ? `，狀態變更 ${changed} 筆` : ''}${failed ? `，${failed} 筆暫無法確認（保留原結果）` : ''}` };
  }
}
