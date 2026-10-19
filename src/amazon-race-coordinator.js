import { randomUUID } from 'node:crypto';
import { nextAmazonPreSubmitRetry } from './amazon-pre-submit-retry.js';

const ROUTES = ['api', 'frontend'];
const ACTIVE = new Set(['preparing', 'granted', 'unknown']);
const fail = message => Object.assign(new Error(message), { code: 'AMAZON_RACE_STOPPED' });

// Only short durable state changes are serialized. No Amazon request or peer
// checkout is ever awaited under this lock. Grants are consumed before sending.
export class AmazonRaceCoordinator {
  constructor({ state, getConfig, now = () => Date.now() }) {
    Object.assign(this, { state, getConfig, now });
    this.queue = Promise.resolve();
    this.online = new Set();
    for (const wave of Object.values(this.root().slots)) {
      const api = wave.routes.api;
      if (api?.state === 'preparing') api.state = 'failed';
      else if (api?.state === 'granted') api.state = 'unknown';
      for (const attempt of Object.values(wave.routes)) {
        if (attempt.state === 'failed' && !attempt.grantedAt && !attempt.retry) attempt.retry = nextAmazonPreSubmitRetry(null, { asin: wave.asin, now: this.now() });
      }
    }
  }
  root() {
    this.state.data.commerce ||= {};
    return this.state.data.commerce.amazonRace ||= { slots: {}, pairing: {} };
  }
  serial(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  async persist() {
    if (typeof this.state.writeSnapshot !== 'function') throw fail('無法保存一次性送單授權，不送單');
    await this.state.writeSnapshot();
  }
  connected(slot) { return this.online.has(slot); }
  current(slot) { return this.root().slots[slot]; }
  maintenanceBlocked() {
    return this.online.size > 0 || Object.values(this.root().slots).some(w => ROUTES.some(r => ACTIVE.has(w.routes[r]?.state)));
  }
  pending(slot) {
    return ROUTES.some(r => ACTIVE.has(this.current(slot)?.routes[r]?.state));
  }
  status(slot) {
    const w = this.current(slot);
    return { connected: this.connected(slot), waveId: w?.id || '', busy: ROUTES.some(r => ['preparing', 'granted'].includes(w?.routes[r]?.state)),
      routes: Object.fromEntries(ROUTES.map(r => [r, w?.routes[r]
        ? { state: w.routes[r].state, orderId: w.routes[r].orderId || '', retryAt: w.routes[r].retry?.nextRetryAt || '' } : { state: 'idle' }])) };
  }
  unavailable(slot) {
    const w = this.current(slot);
    // A later unavailable -> available edge can start another restock wave;
    // an unresolved send must never be treated as a new wave.
    if (w && !this.pending(slot)) w.sawUnavailable = true;
  }
  begin(slot, route, asin) {
    return this.serial(async () => {
      if (!ROUTES.includes(route) || !['A', 'B', 'C'].includes(slot)) throw fail('路線無效');
      const config = this.getConfig(slot);
      if (!config?.enabled || !String(config.targetUrl).includes(asin)) throw fail('任務已停止或商品已更換');
      let wave = this.current(slot);
      if (!wave || wave.asin !== asin || wave.sawUnavailable && !this.pending(slot)) {
        if (wave && this.pending(slot)) throw fail('舊交易尚待核對');
        wave = { id: randomUUID(), asin, at: this.now(), routes: {}, cancelled: false };
        this.root().slots[slot] = wave;
      }
      const previous = wave.routes[route];
      const retryable = previous?.state === 'failed' && !previous.grantedAt && previous.retry
        && this.now() >= Date.parse(previous.retry.nextRetryAt);
      if (wave.cancelled || previous && !retryable || ROUTES.some(r => wave.routes[r]?.state === 'ordered')) {
        throw fail('本波此路已執行，或另一條路已取得訂單；不再次送單');
      }
      const attempt = { id: randomUUID(), state: 'preparing', at: this.now(), ...(retryable ? { retry: previous.retry } : {}) };
      wave.routes[route] = attempt;
      await this.persist();
      return { waveId: wave.id, attemptId: attempt.id, asin, slot, route };
    });
  }
  find(lease) {
    const wave = this.current(lease?.slot), attempt = wave?.routes[lease?.route];
    if (!wave || wave.id !== lease.waveId || wave.asin !== lease.asin || attempt?.id !== lease.attemptId) throw fail('交易授權不符');
    return { wave, attempt };
  }
  canContinue(lease) {
    try {
      const { wave, attempt } = this.find(lease);
      // Already-granted sends are one-use and may finish even if the peer wins.
      return !wave.cancelled && this.getConfig(lease.slot)?.enabled
        && attempt.state === 'preparing' && this.now() - attempt.at < 90_000
        && !ROUTES.some(r => r !== lease.route && wave.routes[r]?.state === 'ordered');
    } catch { return false; }
  }
  grant(lease) {
    return this.serial(async () => {
      if (!this.canContinue(lease)) throw fail('任務取消、授權過期或另一條路已成功；本路不送單');
      const { attempt } = this.find(lease);
      attempt.state = 'granted'; attempt.grantedAt = this.now();
      // Keep consumed state in memory on disk error too. Never issue a retry.
      await this.persist();
      return { granted: true, grantId: lease.attemptId };
    });
  }
  finish(lease, { status, orderId = '' }, onOrdered = () => {}) {
    return this.serial(async () => {
      const { wave, attempt } = this.find(lease);
      if (['ordered', 'failed', 'cancelled'].includes(attempt.state)) return false;
      if (attempt.state === 'unknown' && status !== 'ordered') return false;
      if (status === 'ordered') {
        if (!['granted', 'unknown'].includes(attempt.state) || !Number.isFinite(attempt.grantedAt) || !/^\d{3}-\d{7}-\d{7}$/.test(orderId)) throw fail('缺少本路的送單授權／正式訂單編號');
        if (ROUTES.some(r => r !== lease.route && this.current(lease.slot).routes[r]?.orderId === orderId)) throw fail('此訂單編號已屬於另一條路，不能重複計數');
        attempt.state = 'ordered'; attempt.orderId = orderId;
        const peer = wave.routes[ROUTES.find(r => r !== lease.route)];
        if (peer?.state === 'preparing') peer.state = 'cancelled';
        onOrdered();
      } else {
        attempt.state = status === 'submitted_unconfirmed' || ['granted', 'unknown'].includes(attempt.state) ? 'unknown' : 'failed';
        if (attempt.state === 'failed') attempt.retry = nextAmazonPreSubmitRetry(attempt.retry, { asin: wave.asin, now: this.now() });
      }
      attempt.finishedAt = this.now();
      await this.persist();
      return true;
    });
  }
  cancel(slot) {
    return this.serial(async () => {
      const w = this.current(slot);
      if (w) { w.cancelled = true; for (const r of ROUTES) if (w.routes[r]?.state === 'preparing') w.routes[r].state = 'cancelled'; await this.persist(); }
    });
  }
  reset(slot) {
    return this.serial(async () => {
      if (this.pending(slot)) throw fail('雙路仍有交易待核對，不能重設／換商品');
      delete this.root().slots[slot]; await this.persist();
    });
  }
}
