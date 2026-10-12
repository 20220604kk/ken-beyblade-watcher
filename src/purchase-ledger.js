// Durable quantity accounting. Midnight changes the day bucket, never erases orders or holds.
export function taipeiPurchaseDay(at) {
  const date = new Date(arguments.length ? at == null || at === '' ? NaN : at : Date.now());
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : '';
}
export class PurchaseLedger {
  constructor(storage) {
    this.data = storage.purchaseLedger ||= { version: 1, orders: {}, reservations: {} };
    this.data.orders ||= {}; this.data.reservations ||= {};
  }
  orderKey(platform, identity, reference) { return `${platform}:${identity}:${reference}`; }
  recordOrder({ platform, identity, reference, at, items }) {
    if (!identity || !reference || !items?.length) return false;
    if (!taipeiPurchaseDay(at)) throw new Error('正式訂單缺少可確認日期，保留額度保護');
    const key = this.orderKey(platform, identity, reference), old = this.data.orders[key];
    const combined = new Map((old?.items || []).map(item => [item.id, item]));
    for (const item of items) {
      if (!item.id || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) throw new Error('購買帳本缺少可確認商品數量');
      const previous = combined.get(String(item.id));
      if (previous && previous.quantity !== Number(item.quantity)) throw new Error('同一官方訂單的商品數量不一致，保留保護');
      combined.set(String(item.id), { id: String(item.id), quantity: Number(item.quantity) });
    }
    this.data.orders[key] = { platform, identity, reference: String(reference), at: old?.at || at, day: taipeiPurchaseDay(old?.at || at), items: [...combined.values()] };
    return true;
  }
  remaining(platform, identity, id, limit, at = Date.now()) {
    const day = taipeiPurchaseDay(at);
    let used = 0;
    for (const order of Object.values(this.data.orders)) {
      if (order.platform !== platform || order.identity !== identity || platform === 'funbox' && order.day !== day) continue;
      used += order.items.filter(item => item.id === id).reduce((sum, item) => sum + item.quantity, 0);
    }
    // Reservations remain across midnight/restart; uncertainty is never a free allowance.
    for (const hold of Object.values(this.data.reservations)) if (hold.platform === platform && hold.identity === identity)
      used += hold.items.filter(item => item.id === id).reduce((sum, item) => sum + item.quantity, 0);
    return platform === 'eslite' ? used ? 0 : Number.MAX_SAFE_INTEGER : Math.max(0, limit - used);
  }
  reserve(taskId, platform, identity, items, at) {
    if (this.data.reservations[taskId]) throw new Error('任務額度已保留，不重複派送');
    if (!taskId || !identity || !items?.length || items.some(item => !item.id || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) throw new Error('任務額度缺少帳號或有效商品數量');
    this.data.reservations[taskId] = { platform, identity, items: items.map(item => ({ id: String(item.id), quantity: Number(item.quantity) })), at, status: 'processing' };
  }
  settle(taskId, result) {
    const reservation = this.data.reservations[taskId];
    if (!reservation) return;
    if (result.status === 'submitted_unconfirmed' || result.status === 'processing') { reservation.status = 'held'; return; }
    if (['ordered', 'success'].includes(result.status)) {
      if (!result.orderNumber && !result.orderId) { reservation.status = 'held'; return; }
      this.recordOrder({ platform: reservation.platform, identity: reservation.identity,
        reference: result.orderNumber || result.orderId, at: result.completedAt || reservation.at, items: result.items || reservation.items });
    }
    delete this.data.reservations[taskId];
  }
}
