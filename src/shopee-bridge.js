import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createShopeeState, parseShopeeObservation, reduceShopeeObservation, previewShopeeNotification, shopeeProductIdentity } from './shopee-observations.js';

const hash = value => createHash('sha256').update(value).digest();
const DEFAULT_URL = 'https://shopee.tw/mall/search?keyword=beyblade&shop=285705541';
const FUNBOX_SHOP_ID = '285705541';
const FUNBOX_SEED_PRODUCTS = Object.freeze([
  'https://shopee.tw/product/285705541/24620298578', // UX-03
  'https://shopee.tw/product/285705541/50417252581', // UX-21
  'https://shopee.tw/product/285705541/53617247663'  // BX-00 蒼龍神劍 V2
]);
const DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const DISCOVERY_RECOVERY_MS = 15 * 60 * 1000;
export function shopeeTargetUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error('請輸入完整的蝦皮 HTTPS 網址'); }
  if (u.protocol !== 'https:' || u.hostname !== 'shopee.tw' || u.port || u.username || u.password) throw new Error('只接受 https://shopee.tw/ 網址，不接受其他網站或短網址');
  const p = shopeeProductIdentity(u.href);
  if (p) return { url: p.productUrl, shopId: p.shopId, kind: 'product', itemId: p.itemId };
  const shopId = u.searchParams.get('shop');
  if (u.pathname !== '/mall/search' || !/^[1-9]\d*$/.test(shopId || '') || !u.searchParams.get('keyword')?.trim()) throw new Error('請使用帶有 shop 與 keyword 的店內搜尋網址，或完整商品網址');
  const clean = new URL('https://shopee.tw/mall/search');
  clean.searchParams.set('keyword', u.searchParams.get('keyword').trim()); clean.searchParams.set('shop', shopId);
  return { url: clean.href, shopId, kind: 'search' };
}
export function normalizeShopeeTarget(raw, id = raw.id) {
  if (!/^[a-z0-9-]{1,70}$/.test(id || '')) throw new Error('無效的監控編號');
  const intervalSeconds = Number(raw.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) throw new Error('蝦皮掃描間隔需為 30～3600 秒');
  const activeStart = String(raw.activeStart || '09:00'), activeEnd = String(raw.activeEnd || '22:00');
  if (![activeStart, activeEnd].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('監控時段格式錯誤');
  const keywords = [...new Set((Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords || '').split(/[\n,，、|｜]+/)).map(k => String(k).trim()).filter(Boolean))];
  if (!keywords.length || keywords.length > 6 || keywords.some(k => k.length > 60)) throw new Error('請設定 1～6 組關鍵字，每組最多 60 字');
  return { id, name: String(raw.name || '蝦皮監控').trim().slice(0, 70), ...shopeeTargetUrl(raw.url),
    enabled: raw.enabled === true, intervalSeconds, activeStart, activeEnd, keywords,
    audience: ['private', 'public', 'mmtoy', 'shadow'].includes(raw.audience) ? raw.audience : 'private',
    notifyDiscovery: raw.notifyDiscovery !== false, notifyRestock: raw.notifyRestock !== false };
}
export function inShopeeHours(target, now = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const { activeStart: a, activeEnd: b } = target;
  return a === b || (a < b ? time >= a && time < b : time >= a || time < b);
}
export function defaultShopeeTarget() {
  return normalizeShopeeTarget({ id: 'shopee-funbox', name: 'FUNBOX旗艦館・蝦皮', url: DEFAULT_URL, intervalSeconds: 60, keywords: ['beyblade', '戰鬥陀螺'], audience: 'private', enabled: false });
}
const sourceFor = t => ({ id: t.audience === 'mmtoy' ? 'shopee-mm' : t.shopId === '285705541' ? 'shopee-funbox' : 'shopee-other', shopId: t.shopId, shopIdVerified: true });

export class ShopeeBridge {
  constructor({ file, notify, parentEnabled = () => true, now = () => new Date() }) {
    this.file = file; this.notify = notify; this.parentEnabled = parentEnabled; this.now = now;
    this.data = { targets: [defaultShopeeTarget()], states: {}, runtime: {}, outbox: [], logs: [] };
    this.queue = Promise.resolve(); this.lastBridgeAt = null; this.pending = new Map(); this.sending = false;
  }
  async load() {
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.data.targets = this.data.targets.map(t => normalizeShopeeTarget(t));
    // A send interrupted by process exit is uncertain; do not blindly duplicate it.
    for (const e of this.data.outbox) if (e.status === 'sending') e.status = 'uncertain';
    return this;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(this.data, null, 2)); await fs.rename(tmp, this.file);
  }
  serial(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  log(message) { this.data.logs.unshift({ at: this.now().toISOString(), message }); this.data.logs = this.data.logs.slice(0, 80); }
  status() {
    const now = this.now().getTime();
    const connected = this.lastBridgeAt && now - Date.parse(this.lastBridgeAt) < 90000;
    return { paired: Boolean(this.data.extensionId), connected: Boolean(connected), parentEnabled: this.parentEnabled(),
      extensionDirectory: path.resolve(path.dirname(this.file), '../extensions/shopee-monitor'),
      targets: this.data.targets.map(t => {
        const r = this.data.runtime[t.id] || {};
        const fresh = r.checkedAt && now - Date.parse(r.checkedAt) < Math.max(90000, t.intervalSeconds * 2500);
        return { ...t, ...r, loginState: connected && fresh ? r.loginState || 'unknown' : 'unknown',
          lastLoginState: r.loginState || 'unknown', withinHours: inShopeeHours(t, this.now()), fresh: Boolean(fresh) };
      }), logs: this.data.logs, delivery: this.data.outbox.slice(-20).reverse().map(({ id, title, status, error, messageId }) => ({ id, title, status, error, messageId })) };
  }
  async update(body) {
    let savedId;
    if (body.action === 'delete') {
      this.data.targets = this.data.targets.filter(t => t.id !== body.id);
      delete this.data.runtime[body.id]; delete this.data.states[body.id]; this.pending.delete(body.id);
      this.data.outbox = this.data.outbox.filter(e => e.targetId !== body.id || e.status !== 'pending');
    } else {
      const id = body.id || `shopee-${randomBytes(6).toString('hex')}`;
      savedId = id;
      const t = normalizeShopeeTarget(body, id), old = this.data.targets.find(x => x.id === id);
      if (this.data.targets.some(x => x.url === t.url && x.id !== id)) throw new Error('這個蝦皮網址已存在');
      if (!old && this.data.targets.length >= 10) throw new Error('最多 10 個蝦皮監控網址');
      if (old && (old.url !== t.url || old.audience !== t.audience || JSON.stringify(old.keywords) !== JSON.stringify(t.keywords))) {
        delete this.data.states[id]; delete this.data.runtime[id];
      }
      this.data.targets = this.data.targets.filter(x => x.id !== id).concat(t); this.pending.delete(id);
      this.data.outbox = this.data.outbox.filter(e => e.targetId !== id || e.status !== 'pending');
    }
    await this.save(); return { id: savedId, message: '蝦皮設定已儲存；未連接 Chrome 時不會宣稱已開始掃描。' };
  }
  async pairToken() {
    const token = randomBytes(32).toString('hex');
    this.data.tokenHash = hash(token).toString('hex'); this.data.extensionId = null; this.lastBridgeAt = null; this.pending.clear();
    await this.save(); return { token, message: '配對碼僅供本機蝦皮擴充功能使用；重新產生會撤銷舊連接。' };
  }
  authenticate(req) {
    const origin = req.headers.origin || '';
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error('只接受已配對的 Chrome 擴充功能');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const expected = Buffer.from(this.data.tokenHash || '', 'hex');
    if (expected.length !== 32 || !timingSafeEqual(hash(token), expected)) throw new Error('配對碼無效');
    if (this.data.extensionId && this.data.extensionId !== origin) throw new Error('擴充功能不符合已配對來源');
    this.data.extensionId = origin; this.lastBridgeAt = this.now().toISOString();
  }
  plans() {
    const now = this.now().getTime();
    const plans = [];
    for (const t of this.data.targets.filter(t => t.enabled && this.parentEnabled()
      && (inShopeeHours(t, this.now()) || this.data.runtime[t.id]?.manualRequestedAt))
      .sort((a,b) => Date.parse(this.data.runtime[a.id]?.checkedAt || '1970-01-01') - Date.parse(this.data.runtime[b.id]?.checkedAt || '1970-01-01'))) {
      const r = this.data.runtime[t.id] || {};
      const manual = Boolean(r.manualRequestedAt);
      const pending = this.pending.get(t.id);
      if (r.halted || (pending && now - pending.at < 60000)) continue;
      if (r.nextAllowedAt && now < Date.parse(r.nextAllowedAt)) continue;
      if (r.checkedAt && now - Date.parse(r.checkedAt) < t.intervalSeconds * 1000) continue;
      const scanId = randomBytes(16).toString('hex');
      const probeProducts = new Map();
      const addProbe = value => { const p = shopeeProductIdentity(value); if (p && p.shopId === t.shopId) probeProducts.set(p.itemId, p); };
      if (t.kind === 'product') addProbe(t.url);
      if (t.shopId === FUNBOX_SHOP_ID) for (const url of FUNBOX_SEED_PRODUCTS) addProbe(url);
      for (const record of Object.values(this.data.states[t.id]?.records || {})) addProbe(record.productUrl);
      const candidates = [...probeProducts.values()].slice(0, 24);
      const start = candidates.length ? Number(r.probeCursor || 0) % candidates.length : 0;
      const selected = candidates.length <= 6 ? candidates
        : Array.from({ length: 6 }, (_, index) => candidates[(start + index) % candidates.length]);
      const discoveryDue = t.kind === 'search' && (!r.lastDiscoveryAt || now - Date.parse(r.lastDiscoveryAt) >= DISCOVERY_INTERVAL_MS);
      const allowVerifyRecovery = discoveryDue && (!r.lastDiscoveryAttemptAt || now - Date.parse(r.lastDiscoveryAttemptAt) >= DISCOVERY_RECOVERY_MS);
      this.pending.set(t.id, { scanId, at: now, probeCount: selected.length, probeTotal: candidates.length, manual });
      if (manual) r.manualRequestedAt = null;
      plans.push({ id: t.id, url: t.url, shopId: t.shopId, kind: t.kind, scanId,
        probeProducts: selected, discoveryDue, allowVerifyRecovery });
      if (plans.length === 2) break;
    }
    return plans;
  }
  async ingest(body) {
    const t = this.data.targets.find(x => x.id === body.id), pending = this.pending.get(body.id);
    if (!t || !pending || pending.scanId !== body.scanId || this.now().getTime() - pending.at > 60000) throw new Error('掃描回報已過期或未經排程');
    this.pending.delete(t.id);
    if (!t.enabled || !this.parentEnabled() || (!pending.manual && !inShopeeHours(t, this.now()))) return { message: '時段外或已停用，忽略結果' };
    const observedAt = this.now().toISOString();
    const raw = body.observation || {};
    const final = new URL(raw.finalUrl || t.url);
    const expected = shopeeTargetUrl(t.url);
    if (final.hostname !== 'shopee.tw' || final.protocol !== 'https:' || final.port || final.username || final.password) throw new Error('回報來源錯誤');
    if (!final.pathname.startsWith('/verify/') && !final.pathname.includes('/login')) {
      if (shopeeTargetUrl(final.href).url !== expected.url) throw new Error('分頁已離開設定網址');
    }
    const rows = Array.isArray(raw.items) ? raw.items.slice(0, 100) : [];
    const d = raw.diagnostics || {};
    const diagnostics = {
      readyState: ['loading','interactive','complete'].includes(d.readyState) ? d.readyState : 'unknown',
      cardLinkCount: Number.isInteger(d.cardLinkCount) ? Math.max(0,Math.min(1000,d.cardLinkCount)) : null,
      visibleCardCount: Number.isInteger(d.visibleCardCount) ? Math.max(0,Math.min(1000,d.visibleCardCount)) : null
    };
    // Browser DOM observations do not provide an HTTP status. 200 here is only
    // the adapter's parser contract after confirming a rendered result container.
    const observation = parseShopeeObservation({ finalUrl: final.href, visibleText: String(raw.accessText || '').slice(0, 300),
      httpStatus: Number.isInteger(raw.httpStatus) ? raw.httpStatus : raw.rendered === true ? 200 : undefined,
      observedAt, scopeId: t.kind === 'product' ? `product:${t.itemId}` : 'search:beyblade',
      // Never infer listing disappearance from a partial page or recommendations.
      coverage: 'partial', items: rows, emptyResultVerified: false }, sourceFor(t));
    const previousRuntime = this.data.runtime[t.id] || {};
    const failureStreak = observation.health === 'ready' ? 0 : Number(previousRuntime.failureStreak || 0) + 1;
    const delays = observation.health === 'rate-limited' ? [300, 900, 1800, 3600]
      : observation.health === 'blocked' ? [120, 300, 900, 1800]
        : [30, 120, 300, 900];
    const nextAllowedAt = observation.health === 'ready' ? null
      : new Date(this.now().getTime() + delays[Math.min(failureStreak - 1, delays.length - 1)] * 1000).toISOString();
    const r = this.data.runtime[t.id] = { ...previousRuntime, checkedAt: observedAt,
      loginState: ['logged-in', 'logged-out'].includes(raw.loginState) ? raw.loginState : previousRuntime.loginState || 'unknown',
      health: observation.health, reason: observation.reason, halted: false, failureStreak, nextAllowedAt,
      readCount: rows.length, matchedCount: 0, coverage: 'partial', durationMs: this.now().getTime() - pending.at };
    if (pending.probeTotal) r.probeCursor = (Number(previousRuntime.probeCursor || 0) + pending.probeCount) % pending.probeTotal;
    r.diagnostics = diagnostics;
    r.transport = ['pdp-api', 'dom'].includes(raw.transport) ? raw.transport : 'dom';
    if (raw.diagnostics?.discoveryAttempted === true) r.lastDiscoveryAttemptAt = observedAt;
    if (raw.diagnostics?.discoveryHealthy === true) r.lastDiscoveryAt = observedAt;
    if (observation.health === 'read-error' && diagnostics.readyState === 'complete' && diagnostics.cardLinkCount > 0) {
      r.health = 'parse-error'; r.reason = '商品卡存在但未能解析，保留原基線';
    }
    if (observation.health === 'ready') {
      observation.products = observation.products.filter(p => t.keywords.some(k => p.title.toLowerCase().includes(k.toLowerCase())));
      r.matchedCount = observation.products.length;
      const old = this.data.states[t.id] || createShopeeState(sourceFor(t));
      const result = reduceShopeeObservation(old, observation, sourceFor(t));
      result.state.initialized = true; // Quiet first *partial* baseline; never claim full coverage.
      this.data.states[t.id] = result.state;
      for (const event of result.events) {
        const discovery = ['first-seen', 'reappeared'].includes(event.kind);
        if ((discovery && !t.notifyDiscovery) || (!discovery && !t.notifyRestock)) continue;
        const preview = previewShopeeNotification(event, { test: false });
        if (!preview) continue;
        this.data.outbox.push({ id: `${t.id}:${event.eventId}`, targetId: t.id, title: event.product.title,
          text: `${t.name}\n${preview.content}`, audience: t.audience, status: t.audience === 'shadow' ? 'shadow' : 'pending', at: observedAt });
      }
    }
    this.data.outbox = this.data.outbox.filter(e => ['pending', 'sending', 'uncertain'].includes(e.status)).concat(this.data.outbox.filter(e => !['pending', 'sending', 'uncertain'].includes(e.status)).slice(-100));
    const probeText = raw.diagnostics?.apiSuccessCount != null
      ? `；商品直查 ${raw.diagnostics.apiSuccessCount} 成功／${raw.diagnostics.apiFailureCount || 0} 失敗` : '';
    const discoveryText = raw.diagnostics?.discoverySkipped ? '；賣場探索遇驗證，保留商品直查'
      : raw.diagnostics?.discoveryHealthy ? '；賣場探索完成' : '';
    this.log(`${t.name}：${r.health}，讀取 ${r.readCount} 件，符合 ${r.matchedCount} 件${probeText}${discoveryText}${diagnostics.cardLinkCount !== null ? `；頁面卡片 ${diagnostics.cardLinkCount}／可見 ${diagnostics.visibleCardCount}` : ''}${nextAllowedAt ? `；退避至 ${nextAllowedAt}` : '（部分頁面，不推斷下架）'}`);
    await this.save(); return { message: '已接收', health: r.health };
  }
  async drain() {
    if (this.sending) return; this.sending = true;
    try {
      for (;;) {
        const e = await this.serial(async () => { const e = this.data.outbox.find(x => x.status === 'pending'); if (e) {e.status = 'sending'; await this.save();} return e; });
        if (!e) break;
        let result, error; try { result = await this.notify(e.text, e.audience); } catch (err) { error = err.message; }
        await this.serial(async () => { e.status = error ? 'failed' : 'sent'; e.error = error || null; e.messageId = result?.messageId || null; await this.save(); });
      }
    } finally { this.sending = false; }
  }
  async test(audience = 'private') {
    if (!['private', 'public', 'mmtoy'].includes(audience)) throw new Error('測試頻道無效');
    return this.notify('🧪 蝦皮模擬補貨｜FUNBOX旗艦館\nBEYBLADE X UX-21 惡魔冥界改造組\n狀態：模擬恢復可購（非真實補貨）\n數量：未公開\nhttps://shopee.tw/product/285705541/50417252581', audience);
  }
  async handle(req, res) {
    if (!req.url.startsWith('/shopee/')) return false;
    const reply = (code, data) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    try {
      const ext = req.url.startsWith('/shopee/bridge/');
      const origin = req.headers.origin || '';
      if (ext && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
        if (req.method === 'OPTIONS') { reply(204, {}); return true; }
      }
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) throw new Error('僅接受 JSON POST');
      if (!ext && ((origin && origin !== `http://${req.headers.host}`) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || ''))) throw new Error('僅接受本機儀表操作');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('資料過大'); }
      const body = JSON.parse(raw || '{}');
      const result = await this.serial(async () => {
        if (ext) this.authenticate(req);
        if (req.url === '/shopee/bridge/poll') { await this.save(); return { targets: this.plans() }; }
        if (req.url === '/shopee/bridge/report') return this.ingest(body);
        if (req.url === '/shopee/settings') return this.update(body);
        if (req.url === '/shopee/pair') return this.pairToken();
        if (req.url === '/shopee/resume') { const r = this.data.runtime[body.id] ||= {}; r.halted=false;r.checkedAt=null;r.nextAllowedAt=null;r.failureStreak=0;r.manualRequestedAt=this.now().toISOString(); this.pending.delete(body.id); await this.save(); return {message:'已清除退避並排入一次立即檢查；Chrome 擴充功能需保持連接'}; }
        if (req.url === '/shopee/test') return this.test(body.audience);
        throw new Error('不存在的蝦皮操作');
      });
      reply(200, result); if (req.url === '/shopee/bridge/report') void this.drain().catch(() => {});
    } catch (e) { reply(400, { error: e.message }); }
    return true;
  }
}
