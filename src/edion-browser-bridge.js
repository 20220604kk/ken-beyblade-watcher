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
    return this.state.data.commerce.edionBrowser ||= { runtime: {} };
  }
  serial(work) { const promise = this.queue.then(work); this.queue = promise.catch(() => {}); return promise; }
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
      const fresh = connected && this.now() - Date.parse(runtime.checkedAt || '') < freshMs;
      const targetEnabled = this.getTargets().some(t => t.id === id && t.enabled !== false);
      return { ...runtime, connected, fresh, state: !this.enabled() || !targetEnabled ? 'paused' : !connected ? 'disconnected' : !fresh ? 'waiting' : runtime.health,
        intervalSeconds: Math.max(60, Number(this.intervalSeconds()) || 60) };
    }
    return { connected, paired: Boolean(root.extensionOrigin), enabled: this.enabled(), lastBridgeAt: this.lastBridgeAt ? new Date(this.lastBridgeAt).toISOString() : null,
      extensionDirectory: path.resolve(this.dataDir, '../extensions/edion-monitor'), intervalSeconds: Math.max(60, Number(this.intervalSeconds()) || 60) };
  }
  plans() {
    if (!this.enabled()) return [];
    const root = this.root(); const now = this.now();
    return this.getTargets().filter(t => t.enabled !== false && t.sourceType === 'edion' && t.transport === 'chrome-bridge').flatMap(target => {
      const runtime = root.runtime[target.id] || {};
      const pending = this.pending.get(target.id);
      if (pending && now - pending.at < 40_000) return [];
      if (now < Date.parse(runtime.nextObserveAt || '')) return [];
      const scanId = randomBytes(16).toString('hex');
      const action = runtime.health === 'verification_required' || now < Date.parse(runtime.nextReloadAt || '') ? 'observe' : 'reload';
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
    const root = this.root(); const previous = root.runtime[target.id] || {};
    const now = this.now(); const checkedAt = new Date(now).toISOString();
    const health = observation.health === 'verification_required' ? 'verification_required' : observation.health === 'ready' ? 'ready' : 'unreadable';
    const runtime = { ...previous, health, checkedAt, nextObserveAt: new Date(now + 20_000).toISOString() };
    if (health !== 'ready') {
      root.runtime[target.id] = runtime;
      runtime.failureCount = Number(previous.failureCount || 0) + 1;
      runtime.nextReloadAt = new Date(now + Math.min(900_000, 60_000 * 2 ** Math.min(runtime.failureCount - 1, 4))).toISOString();
      runtime.error = health === 'verification_required' ? '普通 Chrome 需人工驗證；保留分頁、不重整，完成後自動確認' : '普通 Chrome 尚未讀到商品；保留既有基線並降速';
      this.state.data.commerce.japanAuctions ||= { targets: {} };
      const targets = this.state.data.commerce.japanAuctions.targets ||= {};
      targets[target.id] = { ...(targets[target.id] || {}), lastError: runtime.error, lastErrorCode: health, lastAttemptAt: checkedAt };
      // Persist once-per-episode alert before sending: an uncertain send must
      // not become an endless reminder after process restart.
      const alert = health === 'verification_required' && !previous.verificationEpisode;
      if (health === 'verification_required') runtime.verificationEpisode = previous.verificationEpisode || checkedAt;
      await this.state.save();
      if (alert) {
        this.log(`${target.name}：需人工驗證，已停止重整；同次阻擋只提醒一次。`);
        try {
          await this.notify(`🔐 愛電王需要人工驗證\n請開啟 Chrome 的「愛電王」監控分頁完成驗證。程式不會代解驗證，重新讀到商品後自動恢復。\n${target.url}`);
          runtime.alertStatus = 'sent';
        } catch (error) { runtime.alertStatus = 'failed_or_uncertain'; this.log(`愛電王人工驗證提醒失敗：${error.message}`); }
        await this.state.save();
      }
      return { health, pauseReload: health === 'verification_required' };
    }
    const products = normalizeEdionProducts(observation.items);
    const result = await this.monitor.ingestBrowserProducts(target, products);
    Object.assign(runtime, { failureCount: 0, error: '', verificationEpisode: null, alertStatus: '',
      nextReloadAt: pending.action === 'reload' || previous.health !== 'ready'
        ? new Date(now + Math.max(60, Number(this.intervalSeconds()) || 60) * 1000).toISOString()
        : previous.nextReloadAt,
      lastHealthyAt: checkedAt });
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
        if (request.url === '/edion-browser/bridge/poll') { await this.state.save(); return { targets: this.plans(), enabled: this.enabled() }; }
        if (request.url === '/edion-browser/bridge/report') return this.ingest(body);
        throw new Error('不存在的愛電王操作');
      });
      reply(200, result);
    } catch (error) { reply(400, { error: error.message }); }
    return true;
  }
}
