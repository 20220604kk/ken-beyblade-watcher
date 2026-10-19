import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const freshMs = 90_000;
export function edionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.edion.com', 'edion.com'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('非愛電王官方網址');
  url.hostname = 'www.edion.com'; url.hash = ''; url.searchParams.sort();
  return url.href;
}
export function normalizeEdionProducts(items) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('未讀到完整商品資料，保留基線');
  const seen = new Set();
  return items.map(item => {
    const url = new URL(edionUrl(item.url));
    const id = url.searchParams.get('p_cd');
    if (url.pathname !== '/detail.html' || !/^\d{5,20}$/.test(id || '') || seen.has(id)) throw new Error('商品編號或連結異常');
    seen.add(id);
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) throw new Error('商品名稱異常');
    let imageUrl = '';
    try { const image = new URL(item.imageUrl); if (image.protocol === 'https:' && /(?:^|\.)edion\.(?:com|jp)$/.test(image.hostname) && !image.username && !image.password) imageUrl = image.href; } catch { /* optional public image */ }
    url.search = ''; url.searchParams.set('p_cd', id);
    const stock = Number.isInteger(item.stock) && item.stock >= 0 && item.stock <= 10_000_000 ? item.stock : null;
    return { id, url: url.href, title, imageUrl, price: String(item.price || '').slice(0, 50),
      available: stock === 0 ? false : item.available === true || item.available === false ? item.available : undefined,
      detail: stock === null ? 'EDION 普通 Chrome 觀測；數量未公開' : `EDION 前台庫存：${stock}` };
  });
}

export class EdionBrowserBridge {
  constructor({ state, monitor, getTargets, enabled, intervalSeconds, notify = async () => {}, log = () => {}, now = () => Date.now(), dataDir }) {
    Object.assign(this, { state, monitor, getTargets, enabled, intervalSeconds, notify, log, now, dataDir });
    this.pending = new Map(); this.lastBridgeAt = 0; this.queue = Promise.resolve();
  }
  root() {
    this.state.data.commerce ||= {};
    const root = this.state.data.commerce.edionBrowser ||= { runtime: {} };
    root.runtime ||= {};
    for (const [id, runtime] of Object.entries(root.runtime)) {
      if (runtime.noManualRequired === true) continue;
      // Legacy DOM polls are not failed fresh GETs. Keep the existing cooldown
      // and baseline, but migrate obsolete instructions and the retry counter.
      runtime.noManualRequired = true;
      runtime.failureCount = 0;
      runtime.alertStatus = 'disabled_no_manual_prompt';
      if (['verification_required', 'unreadable'].includes(runtime.health)) {
        runtime.error = runtime.health === 'verification_required'
          ? '官網暫時受限；背景冷卻後自動重查，不需手動操作；庫存未更新'
          : '背景讀取未完成；自動重查，保留舊基線；庫存未更新';
        const targetState = this.state.data.commerce.japanAuctions?.targets?.[id];
        if (targetState) targetState.lastError = runtime.error;
      }
    }
    return root;
  }
  serial(work) { const promise = this.queue.then(work); this.queue = promise.catch(() => {}); return promise; }
  reloadIntervalMs(runtime = {}) {
    const recentBlock = this.now() - Date.parse(runtime.lastVerificationAt || '') < 86400000;
    const recoverySeconds = recentBlock ? Math.min(1800, 900 * 2 ** Math.min(1, Math.max(0, Number(runtime.verificationCount || 1) - 1))) : 0;
    return Math.max(300, Number(this.intervalSeconds()) || 300, recoverySeconds) * 1000;
  }
  async pair() {
    const token = randomBytes(32).toString('hex');
    const root = this.root(); root.tokenHash = hash(token).toString('hex'); root.extensionOrigin = null;
    this.pending.clear(); this.lastBridgeAt = 0;
    await this.state.save(); return { token };
  }
  authenticate(request) {
    const origin = String(request.headers.origin || '');
    const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
    const root = this.root(); const expected = Buffer.from(root.tokenHash || '', 'hex');
    if (!EXTENSION_ORIGIN.test(origin) || expected.length !== 32 || !timingSafeEqual(hash(token), expected)
      || (root.extensionOrigin && root.extensionOrigin !== origin)) throw new Error('連接器配對無效');
    root.extensionOrigin = origin; this.lastBridgeAt = this.now();
  }
  status(id = null) {
    const root = this.root();
    const connected = this.lastBridgeAt > 0 && this.now() - this.lastBridgeAt < freshMs;
    if (id) {
      const runtime = root.runtime[id] || {};
      const fresh = connected && this.now() - Date.parse(runtime.lastDataAt || '') < this.reloadIntervalMs(runtime) + freshMs;
      const targetEnabled = this.getTargets().some(t => t.id === id && t.enabled !== false);
      const restricted = ['verification_required', 'unreadable'].includes(runtime.health);
      return { ...runtime, connected, fresh, state: !this.enabled() || !targetEnabled ? 'paused' : !connected ? 'disconnected'
        : this.clientProtocol !== 2 ? 'waiting' : restricted ? 'auto_wait' : !fresh ? 'stale' : runtime.health,
        noManualRequired: true, intervalSeconds: this.reloadIntervalMs(runtime) / 1000 };
    }
    return { connected, paired: Boolean(root.extensionOrigin), enabled: this.enabled(), lastBridgeAt: this.lastBridgeAt ? new Date(this.lastBridgeAt).toISOString() : null,
      extensionDirectory: path.resolve(this.dataDir, '../extensions/edion-monitor'), protocol: this.clientProtocol || 0,
      noManualRequired: true, intervalSeconds: this.reloadIntervalMs() / 1000 };
  }
  plans(protocol = 2) {
    this.clientProtocol = protocol;
    // Old runners only read cached DOM or reload pages. Do not give them work
    // that could be misreported as a newly fetched stock snapshot.
    if (!this.enabled() || protocol !== 2) return [];
    const root = this.root(); const now = this.now();
    return this.getTargets().filter(t => t.enabled !== false && t.sourceType === 'edion' && t.transport === 'chrome-bridge').flatMap(target => {
      const runtime = root.runtime[target.id] || {};
      const pending = this.pending.get(target.id);
      if (pending && now - pending.at < 40_000) return [];
      if ((runtime.lastDataAt || runtime.health !== 'ready') && now < Date.parse(runtime.nextReloadAt || '')) return [];
      const scanId = randomBytes(16).toString('hex');
      const action = 'fetch';
      this.pending.set(target.id, { scanId, at: now, action });
      return [{ id: target.id, url: edionUrl(target.url), scanId, action }];
    });
  }
  async ingest(body) {
    const target = this.getTargets().find(t => t.id === body.id && t.sourceType === 'edion' && t.transport === 'chrome-bridge');
    const pending = this.pending.get(body.id);
    if (!target || !pending || pending.scanId !== body.scanId || this.now() - pending.at > 40_000) throw new Error('觀測回報已過期或未經排程');
    this.pending.delete(body.id);
    if (!this.enabled() || target.enabled === false) return { ignored: true };
    const observation = body.observation || {};
    if (edionUrl(observation.url) !== edionUrl(target.url)) throw new Error('分頁已離開設定的搜尋網址');
    if (pending.action !== 'fetch' || observation.fetched !== true) throw new Error('缺少本次背景讀取證據，未更新基線');
    const root = this.root(); const previous = root.runtime[target.id] || {};
    const now = this.now(); const checkedAt = new Date(now).toISOString();
    const health = observation.health === 'verification_required' ? 'verification_required' : observation.health === 'ready' ? 'ready' : 'unreadable';
    const runtime = { ...previous, health, checkedAt, lastFetchAttemptAt: checkedAt,
      httpStatus: Number(observation.httpStatus) || null, noManualRequired: true };
    if (health !== 'ready') {
      root.runtime[target.id] = runtime;
      runtime.failureCount = Number(previous.failureCount || 0) + 1;
      const baseDelay = health === 'verification_required'
        ? Math.min(3600000, 900000 * 2 ** Math.min(runtime.failureCount - 1, 2))
        : Math.min(900000, 60000 * 2 ** Math.min(runtime.failureCount - 1, 4));
      const retryAfterMs = Number.isFinite(Number(observation.retryAfterSeconds)) ? Math.max(0, Number(observation.retryAfterSeconds)) * 1000 : 0;
      runtime.nextReloadAt = new Date(now + Math.min(8.64e15 - now, Math.max(baseDelay, retryAfterMs))).toISOString();
      runtime.error = health === 'verification_required' ? '官網暫時受限；背景冷卻後自動重查，不需手動操作；庫存未更新' : '背景讀取未完成；自動重查，保留舊基線；庫存未更新';
      runtime.alertStatus = 'disabled_no_manual_prompt';
      this.state.data.commerce.japanAuctions ||= { targets: {} };
      const targets = this.state.data.commerce.japanAuctions.targets ||= {};
      targets[target.id] = { ...(targets[target.id] || {}), lastError: runtime.error, lastErrorCode: health, lastAttemptAt: checkedAt };
      // Record the restriction without sending a "please verify" notification.
      const newEpisode = health === 'verification_required' && !previous.verificationEpisode;
      if (health === 'verification_required') {
        runtime.verificationEpisode = previous.verificationEpisode || checkedAt;
        if (newEpisode) {
          runtime.verificationCount = now - Date.parse(previous.lastVerificationAt || '') < 86400000 ? Number(previous.verificationCount || 0) + 1 : 1;
          runtime.lastVerificationAt = checkedAt;
        }
      }
      await this.state.save();
      if (previous.health !== health) this.log(`${target.name}：${runtime.error}。`);
      return { health, pauseReload: true, nextCheckAt: runtime.nextReloadAt, noManualRequired: true };
    }
    const products = normalizeEdionProducts(observation.items);
    const result = await this.monitor.ingestBrowserProducts(target, products);
    Object.assign(runtime, { failureCount: 0, error: '', verificationEpisode: null, alertStatus: '',
      nextReloadAt: new Date(now + this.reloadIntervalMs(runtime)).toISOString(),
      lastHealthyAt: checkedAt, lastDataAt: checkedAt, dataTransport: 'chrome_first_party_http' });
    root.runtime[target.id] = runtime;
    await this.state.save();
    return { health: 'ready', result };
  }
  async handle(request, response) {
    if (!request.url.startsWith('/edion-browser/')) return false;
    const reply = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(code === 204 ? '' : JSON.stringify(value)); };
    try {
      const origin = String(request.headers.origin || ''); const extension = request.url.startsWith('/edion-browser/bridge/');
      if (extension && EXTENSION_ORIGIN.test(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (request.method === 'OPTIONS') { reply(204, {}); return true; }
      }
      if (request.method !== 'POST' || !String(request.headers['content-type']).startsWith('application/json')) throw new Error('只接受 JSON POST');
      if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) throw new Error('只接受本機連線');
      if (!extension && origin !== `http://${request.headers.host}`) throw new Error('只接受本機控制台配對');
      let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 131072) throw new Error('回報過大'); }
      const body = JSON.parse(raw || '{}');
      const result = await this.serial(async () => {
        if (extension) this.authenticate(request);
        if (request.url === '/edion-browser/pair') return this.pair();
        if (request.url === '/edion-browser/bridge/check') return { enabled: this.enabled() && (!body.id || this.getTargets().some(t => t.id === body.id && t.enabled !== false && t.sourceType === 'edion' && t.transport === 'chrome-bridge')) };
        if (request.url === '/edion-browser/bridge/poll') { await this.state.save(); return { targets: this.plans(body.protocol === 2 ? 2 : 0), enabled: this.enabled(), noManualRequired: true }; }
        if (request.url === '/edion-browser/bridge/report') return this.ingest(body);
        throw new Error('不存在的愛電王操作');
      });
      reply(200, result);
    } catch (error) { reply(400, { error: error.message }); }
    return true;
  }
}
