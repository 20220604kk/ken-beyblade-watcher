import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { load } from 'cheerio';
import { parseAmazonDirectBuyForm, parseAmazonHttpReview, amazonOrderIdFromCompletion } from './amazon-jp-http.js';
import { parseYen, extractModelCode, extractAmazonAsin } from './amazon-jp-monitor.js';
import { validateAmazonJpProductCheckout } from './amazon-jp-product-order.js';

const hash = value => createHash('sha256').update(String(value)).digest();
const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const text = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
export function raceDocument(body) {
  const url = new URL(body.url);
  if (url.origin !== 'https://www.amazon.co.jp' || url.username || url.password || url.port) throw new Error('只接受日亞官方分頁');
  if (typeof body.html !== 'string' || body.html.length > 3_000_000) throw new Error('頁面大小不符');
  const $ = load(body.html);
  const words = text($('title').text()) + ' ' + $('body').text();
  if ($('input[type=password], #captchacharacters, iframe[src*="captcha"]').length || /\/ap\/(?:signin|mfa|challenge)|\/errors\/validateCaptcha/i.test(url.pathname)
    || /Robot Check|画像に表示されている文字|Enter the characters you see/i.test(words)) throw new Error('需要登入或人工驗證，本路暫停');
  return { $, url: url.href, html: body.html };
}

// One separately paired extension profile per slot. Tokens never enter URLs,
// page scripts, status responses, logs, or order records.
export class AmazonRaceBridge {
  constructor({ coordinator, monitors, history, saveConfig = async () => {} }) {
    Object.assign(this, { coordinator, monitors, history, saveConfig });
    this.connections = new Map(); this.runtime = new Map(); this.records = new Map();
  }
  async pair(slot) {
    if (!this.monitors[slot]) throw new Error('請選 A、B 或 C');
    if (this.coordinator.pending(slot)) throw new Error('此任務正在結帳或待核對，不能更換插件');
    const token = randomBytes(32).toString('hex');
    this.coordinator.root().pairing[slot] = { tokenHash: hash(token).toString('hex'), origin: null };
    this.connections.get(slot)?.close();
    await this.coordinator.persist();
    return { token, slot };
  }
  async authenticate(origin, message, socket) {
    const slot = message.slot, pairing = this.coordinator.root().pairing[slot];
    const expected = Buffer.from(pairing?.tokenHash || '', 'hex');
    if (!EXTENSION.test(origin) || expected.length !== 32 || !timingSafeEqual(hash(message.token), expected)
      || pairing.origin && pairing.origin !== origin || message.accountConfirmed !== true) throw new Error('配對碼／來源或帳號確認不符');
    if (this.connections.has(slot)) throw new Error('同一任務已有插件連線');
    if (this.monitors[slot]?.fastLaneEnabled && !this.monitors[slot].fastLaneEnabled()) throw new Error('此任務未使用 API 直購方案，不啟用雙路');
    if (Object.values(this.monitors).some(m => ['ordering', 'maintenance'].includes(m.phase))) throw new Error('API 正在結帳／維護，插件稍後自動連接');
    pairing.origin = origin; await this.coordinator.persist();
    this.connections.set(slot, socket); this.coordinator.online.add(slot);
    this.runtime.set(slot, { state: 'connected', accountConfirmed: true, refreshCount: 0, steps: [] });
    return slot;
  }
  status(slot) {
    const r = this.runtime.get(slot) || {};
    return { ...this.coordinator.status(slot), frontend: { state: r.state || 'unpaired',
      refreshCount: r.refreshCount || 0, steps: r.steps || [], error: r.error || '' } };
  }
  inspect(slot) {
    const ws = this.connections.get(slot);
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('插件未連線；請開啟已配對的 Chrome，再按檢查。本次沒有重送。');
    ws.send(JSON.stringify({ type: 'inspect' }));
    return { message: '已通知插件只讀核對原交易分頁；不刷新、不重新購買、不重送。請查看插件路狀態與訂單紀錄。' };
  }
  task(slot) {
    const m = this.monitors[slot], c = m.getConfig(), asin = extractAmazonAsin(c.targetUrl);
    const wave = this.coordinator.current(slot), pending = wave?.routes.frontend;
    return { slot, asin, enabled: Boolean(c.enabled && !m.interactive && !m.browserOperation),
      url: `https://www.amazon.co.jp/dp/${asin}?m=AN1VRQENFRJN5&language=ja_JP&currency=JPY`,
      pricingPolicy: 'amazon_retail_quote', maxPriceYen: null, toleranceYen: c.priceToleranceYen ?? 1,
      maxShippingYen: c.maxShippingYen ?? 500, intervalMs: m.pollIntervalMs(),
      pending: pending?.state || '', retryAt: pending?.state === 'failed' && !pending.grantedAt ? pending.retry?.nextRetryAt || '' : '',
      ...(pending && ['preparing', 'granted', 'unknown'].includes(pending.state) ? { recovery: {
        lease: { waveId: wave.id, attemptId: pending.id, asin: wave.asin, slot, route: 'frontend' },
        state: pending.state, at: pending.grantedAt || pending.at
      } } : {}) };
  }
  step(slot, name, detail = {}) {
    const r = this.runtime.get(slot), record = this.records.get(slot);
    const category = name === 'buy_now_click' ? '01' : name === 'submit_result' ? '03' : '02';
    r.steps.push({ step: category, at: new Date().toISOString(), page: { '01': '商品頁面', '02': '安全結帳', '03': '取得訂單' }[category],
      action: detail.error || ({ buy_now_click: '發現直接購買', checkout_verified: '核對完成', submit_order: '送出訂單', submit_result: detail.orderId ? '取得訂單編號' : '本路待核對' }[name] || name),
      status: ({ ordered: '成功', submitted_unconfirmed: '待核對', failed: '失敗' }[detail.status] || detail.status || '成功'), ...(detail.orderId ? { orderId: detail.orderId } : {}) });
    r.steps = r.steps.slice(-60);
    if (record) return this.history.step(record, { name, ...detail, at: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(record.startedAt) });
  }
  async message(slot, message) {
    const monitor = this.monitors[slot], runtime = this.runtime.get(slot);
    if (message.type === 'ping') return { pong: true };
    if (message.type === 'task') return this.task(slot);
    if (message.type === 'health') {
      runtime.state = ['waiting', 'paused', 'blocked'].includes(message.state) ? message.state : 'paused';
      runtime.error = text(message.error).replace(/https?:\/\/\S+/g, '[網址略]');
      return { ok: true };
    }
    if (message.type === 'product') {
      const task = this.task(slot);
      if (!task.enabled) return { action: 'stop' };
      const page = raceDocument(message);
      if (extractAmazonAsin(page.url) !== task.asin || !/\/(?:dp|gp\/product)\//.test(new URL(page.url).pathname)) throw new Error('商品分頁與任務不符');
      runtime.refreshCount++;
      if (!page.$('#buybox #buy-now-button:not([disabled]), #desktop_buybox #buy-now-button:not([disabled])').length) {
        runtime.state = 'waiting'; this.coordinator.unavailable(slot); return { action: 'wait' };
      }
      const priceText = page.$('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen').first().text();
      const priceInput = page.$('[name="items[0.base][customerVisiblePrice][currencyCode]"]').first().val();
      const price = priceInput === 'JPY' ? Number(page.$('[name="items[0.base][customerVisiblePrice][amount]"]').first().val()) : parseYen(priceText);
      const title = text(page.$('#productTitle').text());
      if (!title || !Number.isSafeInteger(price) || price <= 0) return { action: 'wait' };
      parseAmazonDirectBuyForm(page, { asin: task.asin, priceYen: price });
      let lease;
      try { lease = await this.coordinator.begin(slot, 'frontend', task.asin); }
      catch (error) { if (error.code === 'AMAZON_RACE_STOPPED') return { action: 'wait' }; throw error; }
      const record = await this.history.begin({ slot, mode: 'parallel', trigger: 'extension', route: 'frontend', raceId: lease.waveId,
        scanStartedAt: new Date().toISOString(), snapshot: { asin: task.asin, title, priceYen: price, code: extractModelCode(title) },
        msrpYen: null, compactSteps: true });
      this.records.set(slot, record);
      const attempt = this.coordinator.find(lease).attempt;
      Object.assign(attempt, { priceYen: price, quotePriceYen: price, code: extractModelCode(title), recordId: record.id });
      await this.coordinator.persist();
      runtime.state = 'preparing'; await this.step(slot, 'buy_now_click');
      return { action: 'buy', lease };
    }
    const lease = message.lease;
    if (lease?.slot !== slot || lease?.route !== 'frontend') throw new Error('非本插件的交易');
    const { attempt } = this.coordinator.find(lease);
    if (!this.records.has(slot) && attempt.recordId) {
      await this.history.ready;
      const record = this.history.recent.find(r => r.id === attempt.recordId);
      if (record) this.records.set(slot, record);
    }
    let record = this.records.get(slot);
    if (message.type === 'continue') return { allowed: this.coordinator.canContinue(lease) };
    if (message.type === 'review') {
      const page = raceDocument(message);
      if (record) this.history.captureEvidence(record, 'entry', { ...page, source: 'extension_dom', method: 'DOM' });
      if (!this.coordinator.canContinue(lease)) return { action: 'stop' };
      // Unlike an API form override, a frontend click must already be in JPY.
      if (page.$('#spc-form [name="currentCurrencyOption"]').val() !== 'MARKETPLACE') return { action: 'jpy' };
      const review = parseAmazonHttpReview(page, { asin: lease.asin, priceYen: attempt.priceYen });
      validateAmazonJpProductCheckout(review.checkout, { asin: lease.asin, code: attempt.code, quotePriceYen: attempt.quotePriceYen ?? attempt.priceYen,
        toleranceYen: monitor.getConfig().priceToleranceYen ?? 1, maxShippingYen: monitor.getConfig().maxShippingYen ?? 500 });
      await this.step(slot, 'checkout_verified');
      const grant = await this.coordinator.grant(lease);
      runtime.state = 'granted'; await this.step(slot, 'submit_order');
      return { action: 'submit', ...grant };
    }
    if (message.type === 'result') {
      let orderId = '';
      if (message.html) orderId = amazonOrderIdFromCompletion(raceDocument(message));
      const completionPage = /\/(?:gp\/buy\/thankyou\/|checkout\/.*(?:thank|confirmation))/.test(String(message.url || ''));
      const status = orderId && Number.isFinite(attempt.grantedAt) && ['granted', 'unknown'].includes(attempt.state) ? 'ordered'
        : completionPage || ['granted', 'unknown'].includes(attempt.state) ? 'submitted_unconfirmed' : 'failed';
      const confirmedOrderId = status === 'ordered' ? orderId : '';
      const changed = await this.coordinator.finish(lease, { status, orderId: confirmedOrderId }, () => { monitor.storage().completedCount += 1; });
      if (changed) {
        if (record?.finishedAt && confirmedOrderId) {
          record = await this.history.begin({ slot, mode: 'parallel', trigger: 'extension_reconciliation', route: 'frontend', raceId: lease.waveId,
            scanStartedAt: new Date().toISOString(), snapshot: { ...record.product }, compactSteps: true });
          this.records.set(slot, record);
        }
        runtime.state = confirmedOrderId ? 'ordered' : status === 'failed' ? 'failed' : 'unknown';
        runtime.error = text(message.error);
        await this.step(slot, 'submit_result', { status, orderId: confirmedOrderId });
        if (record) await this.history.finish(record, { status, orderId: confirmedOrderId, error: text(message.error) });
        if (confirmedOrderId) {
          if (monitor.storage().completedCount >= (monitor.getConfig().targetSuccessCount || 1)) {
            monitor.getConfig().enabled = false; monitor.stop(); await this.saveConfig();
          }
        }
        if (confirmedOrderId || status === 'submitted_unconfirmed') {
          const message = confirmedOrderId ? `✅ 日亞插件前端訂單成立｜${lease.asin}｜訂單 ${confirmedOrderId}｜請核對是否與 API 重複`
            : `⚠️ 日亞插件送單結果待核對｜${lease.asin}｜本路不會重送，請核對官方訂單`;
          try { await monitor.notifyPrivate(message, { discordAudience: 'private' }); if (record) await this.history.notification(record, { status: 'sent', at: new Date().toISOString() }); }
          catch (error) { if (record) await this.history.notification(record, { status: 'failed', at: new Date().toISOString(), error: error.message }); }
        }
      }
      else if (record && !record.finishedAt && attempt.state === 'cancelled') await this.history.finish(record, { status: 'failed', error: '另一條路已成功或使用者已停止，本路未送單' });
      return { status, orderId: confirmedOrderId, retryAt: attempt.state === 'failed' ? attempt.retry?.nextRetryAt || '' : '' };
    }
    throw new Error('未知的插件操作');
  }
  attach(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 3_500_000 });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/amazon-race/socket' || !EXTENSION.test(request.headers.origin || '')
        || !/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    });
    wss.on('connection', (ws, request) => {
      let slot, serial = Promise.resolve();
      const deadline = setTimeout(() => ws.close(), 5000);
      ws.on('error', () => {});
      ws.on('message', raw => {
        let body;
        serial = serial.then(async () => {
          body = JSON.parse(raw.toString());
          let result;
          if (!slot) { slot = await this.authenticate(request.headers.origin, body, ws); clearTimeout(deadline); result = { connected: true, task: this.task(slot) }; }
          else result = await this.message(slot, body);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: body.id, result }));
        }).catch(async error => {
          if (slot) { const r = this.runtime.get(slot); r.error = text(error.message); }
          if (slot && body?.lease?.slot === slot && body.lease.route === 'frontend') {
            const record = this.records.get(slot);
            if (record) this.history.captureEvidence(record, 'failure', { html: body.html || '', url: body.url, source: 'extension_dom', error: error.message });
            try { await this.message(slot, { type: 'result', lease: body.lease, error: error.message }); } catch { /* retain the durable consumed grant */ }
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...(slot && body?.id ? { id: body.id } : {}), error: text(error.message) }));
          // Protocol/validation failure is fail-closed. Restarting the extension
          // may only inspect a consumed lease, never click it again.
          if (!slot || !body?.lease || body.lease.slot !== slot || body.lease.route !== 'frontend') ws.close();
        });
      });
      ws.on('close', () => {
        clearTimeout(deadline);
        if (slot && this.connections.get(slot) === ws) { this.connections.delete(slot); this.coordinator.online.delete(slot); }
      });
    });
    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) { if (ws.isAlive === false) ws.terminate(); else { ws.isAlive = false; ws.ping(); } }
    }, 25_000);
    wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });
    heartbeat.unref();
    server.on('close', () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  }
  async handle(request, response) {
    if (!request.url.startsWith('/amazon-race/')) return false;
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (request.method !== 'POST' || request.headers.origin !== `http://${request.headers.host}`
        || !/^127\.0\.0\.1:\d+$/.test(request.headers.host || '') || !String(request.headers['content-type']).startsWith('application/json')) throw new Error('只接受本機控制台操作');
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 1024) throw new Error('請求過大'); }
      const body = JSON.parse(raw);
      if (request.url === '/amazon-race/pair') reply(200, await this.coordinator.serial(() => this.pair(body.slot)));
      else throw new Error('不存在的雙路操作');
    } catch (error) { reply(400, { error: text(error.message) }); }
    return true;
  }
}
