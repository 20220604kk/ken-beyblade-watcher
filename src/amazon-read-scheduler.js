// Coordinates read-only Amazon web requests. Checkout mutations never enter
// this queue; observations and cookies are never shared between profiles.
export function amazonRetryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export class AmazonReadScheduler {
  constructor({ spacingMs = 200, maxConcurrent = 3, now = Date.now } = {}) {
    this.spacingMs = spacingMs;
    this.maxConcurrent = maxConcurrent;
    this.now = now;
    this.queue = [];
    this.inflight = new Map();
    this.cooldowns = new Map();
    this.active = 0;
    this.backgroundActive = 0;
    this.nextStart = 0;
    this.searchAt = null;
    this.timer = null;
    this.closed = false;
    this.counts = { started: 0, coalesced: 0, failed: 0, rateLimited: 0 };
    this.recent = [];
  }

  reserveSearch(at) { this.searchAt = at; this.pump(); }

  run({ lane = 'single', scope, key, canStart = () => true }, task) {
    if (this.closed) return Promise.reject(Object.assign(new Error('日亞唯讀排程已停止'), { code: 'AMAZON_READ_CANCELLED' }));
    if (!scope) throw new Error('Amazon read requires an explicit profile scope');
    const id = key ? `${scope}\n${key}` : null;
    if (id && this.inflight.has(id)) {
      this.counts.coalesced++;
      return this.inflight.get(id);
    }
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ lane, scope, key, canStart, task, resolve, reject });
    });
    if (id) {
      this.inflight.set(id, promise);
      promise.finally(() => { if (this.inflight.get(id) === promise) this.inflight.delete(id); }).catch(() => {});
    }
    this.pump();
    return promise;
  }

  pump() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || !this.queue.length || this.active >= this.maxConcurrent) return;
    this.queue.sort((a, b) => this.priority(a.lane) - this.priority(b.lane));
    const now = this.now();
    // Keep background work away from the next discovery deadline. Higher
    // priority reads can still start; no catch-up request bursts are created.
    const index = this.queue.findIndex(item => item.lane !== 'background'
      || (!this.backgroundActive && !(this.searchAt != null && this.searchAt <= now + 2000)));
    if (index < 0) {
      this.timer = setTimeout(() => this.pump(), 250);
      return;
    }
    const delay = this.nextStart - now;
    if (delay > 0) { this.timer = setTimeout(() => this.pump(), delay); return; }
    const item = this.queue.splice(index, 1)[0];
    const cooldown = (this.cooldowns.get(item.scope) || 0) - now;
    if (!item.canStart() || cooldown > 0) {
      item.reject(Object.assign(new Error(cooldown > 0 ? '日亞工作階段仍在冷卻' : '日亞唯讀工作已取消'), {
        code: cooldown > 0 ? 'AMAZON_RATE_LIMITED' : 'AMAZON_READ_CANCELLED', retryAfterMs: Math.max(0, cooldown)
      }));
      this.pump();
      return;
    }
    this.active++;
    if (item.lane === 'background') this.backgroundActive++;
    this.nextStart = now + this.spacingMs;
    this.counts.started++;
    const record = { at: new Date(now).toISOString(), lane: item.lane, durationMs: 0, httpStatus: null, errorCode: '' };
    Promise.resolve().then(item.task).then(result => {
      record.httpStatus = typeof result?.status === 'number' ? result.status : result?.diagnostic?.httpStatus ?? null;
      item.resolve(result);
    }, error => {
      this.counts.failed++;
      record.errorCode = error.code || 'AMAZON_READ_FAILED';
      record.httpStatus = error.httpStatus ?? null;
      if (error.code === 'AMAZON_RATE_LIMITED') {
        this.counts.rateLimited++;
        this.cooldowns.set(item.scope, Math.max(this.cooldowns.get(item.scope) || 0,
          this.now() + Math.max(60_000, error.retryAfterMs || 0)));
      }
      item.reject(error);
    }).finally(() => {
      record.durationMs = Math.max(0, this.now() - now);
      this.recent = [...this.recent, record].slice(-40);
      this.active--;
      if (item.lane === 'background') this.backgroundActive--;
      this.pump();
    });
    this.pump();
  }

  priority(lane) { return ({ search: 0, confirmation: 1, single: 1, background: 2 })[lane] ?? 1; }

  status() {
    return { ...this.counts, active: this.active, queued: this.queue.length,
      nextSearchAt: this.searchAt == null ? null : new Date(this.searchAt).toISOString(), recent: this.recent };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const item of this.queue.splice(0)) item.reject(Object.assign(new Error('日亞唯讀排程已停止'), { code: 'AMAZON_READ_CANCELLED' }));
  }
}
