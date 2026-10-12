import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutoPurchaseCoordinator, EslitePurchaseAdapter, purchaseEsliteViaApi, maintainEsliteApiSession, formatPlatformPurchaseNotification } from '../src/auto-purchase.js';
import { safePurchaseText, purchaseErrorSummary } from '../src/purchase-diagnostics.js';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

test('HTML error pages are summarized without the response body', () => {
  assert.equal(purchaseErrorSummary('<!DOCTYPE html><html>500</html>'), '網站回傳錯誤頁面，未取得有效 API 資料');
});

const response = (status, body) => ({ status: () => status, ok: () => status >= 200 && status < 300,
  json: async () => body, dispose: async () => {}, headers: () => ({}) });
const product = { id: 'MOCK-1', title: 'BEYBLADE X BX-09', available: true, stock: 1 };
const cart = id => ({ cart: { cart_items: [{ product_guid: id, qty: 1 }] } });
const options = { product, settings: { action: 'checkout', strictSingleProductOrder: true },
  checkoutTemplate: { checkout: { payment: '3' } }, prevalidated: true, deadlineMs: 30000 };
const timeout = () => new Error('apiRequestContext.get: Timeout 5000ms exceeded.\nCall log:\n - authorization: Bearer FAKE-SECRET\n - cookie: FAKE-COOKIE');

test('加車成功後讀車超時，只補查同商品，不重新加車', async () => {
  let adds = 0, gets = 0, orders = 0, elapsed = 0;
  const steps = [];
  const result = await purchaseEsliteViaApi({ ...options, now: () => elapsed, onStep: step => steps.push(step), apiContext: {
    async post(url) { if (url.includes('/cart/')) { adds++; elapsed += 1800; return response(200, { product_guid: product.id, response_quantity: 1 }); }
      orders++; elapsed += 900; return response(200, { order_id: 'MOCK-ORDER' }); },
    async get() { if (++gets === 1) return response(200,{cart:{cart_items:[]}}); if (gets === 2) { elapsed += 5000; throw timeout(); } elapsed += 200; return response(200, cart(product.id)); }
  } });
  assert.equal(result.status, 'ordered'); assert.deepEqual({ adds, gets, orders }, { adds: 1, gets: 3, orders: 1 });
  assert.ok(steps.some(step => step.state === 'retry'));
  assert.equal(result.timings.totalMs, 7900); // Synthetic clock; not a real-store speed claim.
  assert.doesNotMatch(JSON.stringify(result), /FAKE-SECRET|FAKE-COOKIE|Call log/);
});

test('加車回應遺失但車內有正確商品，以唯讀核對恢復，絕不重加', async () => {
  let adds = 0, orders = 0;
  const result = await purchaseEsliteViaApi({ ...options, apiContext: {
    async post(url) { if (url.includes('/cart/')) { adds++; throw timeout(); } orders++; return response(200, { order_id: 'MOCK' }); },
    async get() { return response(200, adds ? cart(product.id) : {cart:{cart_items:[]}}); }
  } });
  assert.equal(result.status, 'ordered'); assert.equal(adds, 1); assert.equal(orders, 1);
});

test('官方加車成功但車資料延後同步，空車只補查一次後核對送單',async()=>{
  let adds=0,reads=0,orders=0;
  const result=await purchaseEsliteViaApi({...options,apiContext:{
    async get(){reads++;return response(200,reads<3?{cart:{cart_items:[]}}:cart(product.id));},
    async post(url){if(url.includes('/cart/')){adds++;return response(200,{product_guid:product.id,response_quantity:1});}orders++;return response(200,{order_id:'DELAYED'});}
  }});
  assert.equal(result.status,'ordered');assert.equal(adds,1);assert.equal(reads,3);assert.equal(orders,1);
});

test('讀車補查後發現別款、空車、錯誤數量都不得送單', async () => {
  for (const body of [cart('OTHER'), { cart: { cart_items: [] } }, { cart: { cart_items: [{ product_guid: product.id, qty: 2 }] } }]) {
    let orders = 0, reads = 0;
    await assert.rejects(purchaseEsliteViaApi({ ...options, apiContext: {
      async post(url) { if (url.includes('/cart/')) return response(200, { product_guid: product.id, response_quantity: 1 }); orders++; },
      async get() { if (++reads === 1) return response(200,{cart:{cart_items:[]}}); if (reads === 2) throw timeout(); return response(200, body); }
    } }), error => error.purchaseStatus === 'cart_conflict');
    assert.equal(orders, 0);
  }
});

test('兩次讀車皆逾時，記錄真正失敗階段及所有步驟，未送單', async () => {
  let gets = 0, orders = 0;
  await assert.rejects(purchaseEsliteViaApi({ ...options, apiContext: {
    async post(url) { if (url.includes('/cart/')) return response(200, { product_guid: product.id, response_quantity: 1 }); orders++; },
    async get() { if(++gets===1)return response(200,{cart:{cart_items:[]}}); throw timeout(); }
  } }), error => {
    assert.equal(error.timings.failedStage, '核對單品購物車');
    assert.equal(error.timings.steps.at(-1).state, 'failed');
    assert.doesNotMatch(error.message, /Call log|FAKE/); return true;
  });
  assert.equal(gets, 3); assert.equal(orders, 0);
});

test('讀車遇 429 不立即重打；剩餘窗口不足也不補查', async () => {
  for (const rateLimited of [true, false]) {
    let reads = 0, time = 0;
    await assert.rejects(purchaseEsliteViaApi({ ...options, now: () => time, apiContext: {
      async post() { return response(200, { product_guid: product.id, response_quantity: 1 }); },
      async get() { reads++; if (rateLimited) return response(429, {}); time = 29000; throw timeout(); }
    } }));
    assert.equal(reads, 1);
  }
});

test('送單斷線仍只送一次，保留待核對步驟；不是失敗通知或成功通知', async () => {
  let submits = 0, checkoutTimeout,added=false;
  const result = await purchaseEsliteViaApi({ ...options, apiContext: {
    async post(url, opts) { if (url.includes('/cart/')) {added=true;return response(200, { product_guid: product.id, response_quantity: 1 });} submits++; checkoutTimeout = opts.timeout; throw timeout(); },
    async get() { return response(200, added ? cart(product.id) : {cart:{cart_items:[]}}); }
  } });
  assert.equal(submits, 1); assert.equal(result.status, 'submitted_unconfirmed'); assert.ok(checkoutTimeout > 8000 && checkoutTimeout <= 15000);
  assert.equal(result.timings.steps.at(-1).state, 'unknown');
  const message = formatPlatformPurchaseNotification('eslite', product, result);
  assert.match(message.text, /結果待核對/); assert.doesNotMatch(message.text, /自動購買失敗|自動購買成功|FAKE-SECRET|cookie/);
});

test('會員成功但購物車格式損壞，不得當成空車或清車', async () => {
  let deletes = 0;
  await assert.rejects(maintainEsliteApiSession('', { apiContext: {
    async get(url) { return response(200, url.includes('member') ? { id: 'MOCK-MEMBER' } : {}); },
    async delete() { deletes++; }
  } }), error => error.purchaseStatus === 'cart_unknown');
  assert.equal(deletes, 0);
});

async function adapterFixture(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-recovery-'));
  const adapter = new EslitePurchaseAdapter({ dataDir: dir, sessionFile: path.join(dir, 'not-used.json'), apiOnly: true,
    getCredentials: () => ({ account: 'mock', password: 'mock' }), getCheckoutTemplate: () => ({ checkout: {} }),
    apiContextFactory: async () => ({ api: { dispose: async () => {} }, expiresAtMs: Date.now() + 86400000 }),
    ...extra });
  return { adapter, async close() { await adapter.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('冷帳號合併會員與清車，不先重複預熱；失敗階段也可追蹤', async () => {
  let budget;
  const steps = [];
  const f = await adapterFixture({ apiMaintenanceRunner: async () => assert.fail('不應預熱清車'),
    apiContextFactory: async () => ({ api: {dispose:async()=>{},get:async(_url,opts)=>{budget=opts.timeout;throw timeout();}},expiresAtMs:Date.now()+86400000 }) });
  try {
    await assert.rejects(f.adapter.purchase(product, { action: 'checkout', onStep: step => steps.push(step) }), error => {
      assert.equal(error.timings.failedStage, '購物車清空中'); return true;
    });
    assert.ok(budget > 2000 && budget <= 8000); assert.equal(steps.at(-1).state, 'failed');
  } finally { await f.close(); }
});

test('每日維護 500 不誤標登出；API-only 近到期不變每秒心跳', async () => {
  const f = await adapterFixture({ apiMaintenanceRunner: async () => { throw Object.assign(new Error('會員 API 無法確認登入（HTTP 500）'), { purchaseStatus: 'unknown' }); } });
  try {
    await f.adapter.localSessionLoad; f.adapter.loginState = 'ready';
    await assert.rejects(f.adapter.maintainSession()); assert.equal(f.adapter.loginState, 'ready');
    f.adapter.sessionHeartbeatEnabled = true; f.adapter.lastTokenExpiresAtMs = Date.now() + 5 * 60000;
    f.adapter._scheduleHeartbeat(); assert.ok(Date.parse(f.adapter.nextVerifyAt) - Date.now() > 60000);
    f.adapter.purchaseHold = { productId: product.id }; f.adapter.noteActivity();
    assert.equal(f.adapter.sessionHeartbeatStartupTimer, null);
  } finally { await f.close(); }
});

test('未就緒帳號活動檢查有九十秒冷卻，不隨每次掃描重做', async () => {
  let probes = 0;
  const f = await adapterFixture();
  try {
    f.adapter.sessionHeartbeatEnabled = true;
    f.adapter.verifyStoredSession = async () => { probes++; };
    f.adapter.noteActivity(); await new Promise(resolve => setTimeout(resolve, 15));
    f.adapter.noteActivity(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(probes, 1);
  } finally { await f.close(); }
});

test('搜尋 429 尊重冷卻，期間策展 API 仍可讀取', async () => {
  let searches = 0, exhibits = 0;
  const monitor = new ShoppingSiteMonitor({ state: { data: {}, async save() {} }, getTargets: () => [], notify: async () => {},
    fetcher: async url => { if (url.includes('holmes')) { searches++; return { ok: false, status: 429, headers: { get: () => '60' } }; }
      exhibits++; return { ok: true, status: 200 }; } });
  try {
    await monitor.requestEslitePublicApi('https://holmes.eslite.com/v1/search', '');
    await monitor.requestEslitePublicApi('https://holmes.eslite.com/v1/search', '');
    await monitor.requestEslitePublicApi('https://athena.eslite.com/api/v1/book_exhibits/MOCK', '');
    assert.equal(searches, 1); assert.equal(exhibits, 1);
    assert.ok(monitor.esliteSearchApiBlockedUntil - Date.now() > 59000);
  } finally { await monitor.close(); }
});

test('憑證、請求頭及 HTML 不成為可見錯誤細節', () => {
  assert.equal(purchaseErrorSummary(timeout()), '網站回應逾時（等待 5.0 秒）');
  assert.doesNotMatch(safePurchaseText('error authorization: Bearer FAKE-SECRET'), /FAKE-SECRET/);
  assert.doesNotMatch(safePurchaseText('error cookie=FAKE-COOKIE'), /FAKE-COOKIE/);
});

test('永久逐步紀錄關聯帳號／商品，私人通知慢不擋下一個工作', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-diagnostics-'));
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const history = path.join(dir, 'eslite-attempts.jsonl');
  const state = { data: {}, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({ state, esliteHistoryFile: history,
    getConfig: () => ({ enabled: true, eslite: { enabled: true, action: 'checkout' } }),
    adapters: { eslite: { async purchase(_product, settings) { calls++; await settings.onAccountAssigned('A');
      settings.onStep({ label: '加車確認', state: 'success', elapsedMs: 100 });
      return { status: 'ordered', orderId: `MOCK-${calls}` }; }, credentialsStatus: () => ({ ready: true }), async close() {} } }, notifyPrivate: async () => gate });
  try {
    await coordinator._processItem({ key: 'eslite:MOCK-1', platform: 'eslite', product });
    await coordinator._processItem({ key: 'eslite:MOCK-2', platform: 'eslite', product: { ...product, id: 'MOCK-2' } });
    assert.equal(calls, 2); assert.equal(coordinator.privateDeliveries.size, 2);
    const rows = (await fs.readFile(history, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].accountSlot, 'A'); assert.ok(rows[0].steps.some(step => step.label === '加車確認'));
    const stepRows = (await fs.readFile(path.join(dir, 'eslite-steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(stepRows.some(step => step.accountSlot === 'A' && step.taskId === rows[0].taskId));
  } finally { release(); await coordinator.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('原始錯誤不流入狀態、永久紀錄或私人通知', async () => {
  const state = { data: {}, async save() {} }; const messages = [];
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => ({ enabled: true, eslite: { enabled: true } }),
    adapters: { eslite: { async purchase() { throw timeout(); }, credentialsStatus: () => ({ ready: true }), async close() {} } }, notifyPrivate: async text => messages.push(text) });
  try {
    await coordinator._processItem({ key: 'eslite:MOCK-1', platform: 'eslite', product }); await coordinator.whenIdle();
    assert.doesNotMatch(JSON.stringify(state.data) + messages.join(''), /FAKE-SECRET|FAKE-COOKIE|Call log/);
  } finally { await coordinator.close(); }
});

test('帳號分派立即存檔完成後才能開始加車，不等待兩輪 debounce', async () => {
  let release, durable = false, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const state = { data: {}, async save() {}, async writeSnapshot() { await gate; durable = true; } };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => ({ enabled: true, eslite: { enabled: true } }),
    adapters: { eslite: { credentialsStatus: () => ({ ready: true }), async close() {},
      async purchase(_product, settings) { await settings.onAccountAssigned('A'); assert.equal(durable, true); calls++;
        return { status: 'ordered', orderId: 'MOCK-DURABLE' }; } } }, notifyPrivate: async () => {} });
  const task = coordinator._processItem({ key: 'eslite:MOCK-1', platform: 'eslite', product });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    release(); await task; assert.equal(calls, 1);
  } finally { release(); await task; await coordinator.close(); }
});

test('時段外沒有可維護平台，不可標記每日保養完成', async () => {
  const coordinator = new AutoPurchaseCoordinator({ state: { data: {}, async save() {} },
    getConfig: () => ({ enabled: true, eslite: { enabled: true } }), isPlatformMonitoringEnabled: () => false,
    adapters: { eslite: { credentialsStatus: () => ({ ready: true }), async maintainSession() { throw new Error('Must not run'); }, async close() {} } }, notifyPrivate: async () => {} });
  try {
    const result = await coordinator._runDueMaintenance(new Date(2026, 9, 8, 8, 50));
    assert.equal(result.deferred, true);
    assert.equal(coordinator._storage().maintenance.completedSlots['2026-10-08']['08:50'], undefined);
  } finally { await coordinator.close(); }
});
