// Runtime-only intent registry. Historical baselines and timers cannot create
// purchases: every lease/retry needs a fresh official observation.
export class EsliteRestockTasks {
  constructor({ now = Date.now, freshnessMs = 30_000, inactivityMs = 30 * 60_000,maxAttempts=Infinity } = {}) {
    this.now = now;
    this.freshnessMs = freshnessMs;
    this.inactivityMs = inactivityMs;
    this.maxAttempts=maxAttempts;
    this.reset();
  }

  reset() {
    this.startedAt = 0;
    this.lastAvailableAt = 0;
    this.products = new Map();
    this.attempts = new Map();
    this.accountCooldowns = new Map();
    this.accountCooldownReasons = new Map();
  }

  active() {
    if (this.products.size && this.now() - this.lastAvailableAt >= this.inactivityMs) this.reset();
    return this.products.size > 0;
  }

  observe(product, { activate = false } = {}) {
    const at = Date.parse(product.freshObservationAt || product.lastObservationAt || '');
    const now = this.now();
    if (!product.id || !product.url || product.verificationPending === true
      || typeof product.available !== 'boolean' || !Number.isFinite(at)
      || at > now || now - at >= this.freshnessMs) return false;
    this.active();
    const previous = this.products.get(String(product.id));
    if (!previous && (!activate || product.available !== true)) return false;
    // Late responses must not resurrect a product after a newer sold-out result.
    if (previous && at < previous.observedAt) return false;
    if (!this.products.size) this.startedAt = now;
    const epoch = (previous?.epoch || 0) + (previous?.available === false && product.available ? 1 : 0);
    const entry = { product: { ...product }, available: product.available, observedAt: at,
      revision: (previous?.revision || 0) + 1, epoch,
      signature: JSON.stringify([product.variantId ?? '', product.stock ?? null, product.qtyCap ?? null]) };
    this.products.set(String(product.id), entry);
    if (product.available) this.lastAvailableAt = now;
    return true;
  }

  reason(id, key, identity = '') {
    if (!this.active()) return '補貨事件已結束';
    const entry = this.products.get(String(id));
    if (!entry || this.now() - entry.observedAt >= this.freshnessMs) return '等待最新 API 觀測';
    if (!entry.available) return '目前不可購';
    if ((this.accountCooldowns.get(identity) || 0) > this.now()) return this.accountCooldownReasons.get(identity) === 'checkout_busy' ? '帳號忙碌冷卻中' : '帳號限流冷卻中';
    const attempt = this.attempts.get(key);
    if (!attempt) return '';
    if(attempt.epoch===entry.epoch&&attempt.count>=this.maxAttempts)return '本輪已達 3 次任務上限，繼續其他商品';
    if (attempt.mode === 'stop') return '本款待檢查';
    if (entry.revision <= attempt.revision) return '等待失敗後的新觀測';
    if (attempt.nextAt > this.now()) return '重試冷卻中';
    if (attempt.mode === 'changed' && entry.signature === attempt.signature && entry.epoch === attempt.epoch) return '等待庫存狀態變化';
    return '';
  }

  complete(id, key, record, identity = '') {
    const entry = this.products.get(String(id));
    if (!entry) return;
    const previous=this.attempts.get(key);
    const count = (previous?.epoch===entry.epoch?previous.count:0) + 1;
    const status = record.purchaseStatus || record.status;
    // Only a never-added item from a confirmed completed cart can be requeued.
    // Fresh inventory, account holds and the event attempt cap still apply.
    const deferred = status === 'batch_deferred' && record.status === 'skipped'
      && record.batchParentStatus === 'ordered' && Boolean(record.orderNumber || record.orderId)
      && record.quantity === 0;
    const transient = new Set(['checkout_busy', 'rate_limited', 'not_ready', 'account_not_ready',
      'deadline_exceeded', 'cart_unknown', 'needs_login', 'needs_setup', 'precheckout_unavailable']);
    const changed = new Set(['inventory_conflict', 'stock_out', 'cart_conflict']);
    const wait = deferred ? 0 : status === 'rate_limited' ? 60_000 : Math.min(60_000, 5000 * 2 ** Math.min(count - 1, 4));
    if (identity && ['rate_limited', 'checkout_busy'].includes(status)) {
      this.accountCooldowns.set(identity, this.now() + wait); this.accountCooldownReasons.set(identity, status);
    }
    this.attempts.set(key, { count, revision: entry.revision, signature: entry.signature, epoch: entry.epoch,
      quotaDay: record.quotaDay || '', outcome: record.status,
      nextAt: this.now() + wait, mode: deferred || record.allowQuotaContinuation || transient.has(status) ? 'retry' : changed.has(status) ? 'changed' : 'stop' });
  }

  status() {
    const active = this.active();
    return { active, productCount: this.products.size, freshnessMs: this.freshnessMs,
      startedAt: active ? new Date(this.startedAt).toISOString() : '',
      lastAvailableAt: active ? new Date(this.lastAvailableAt).toISOString() : '' };
  }
}
