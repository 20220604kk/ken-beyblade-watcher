import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ShoppingSiteMonitor, isEsliteSourceBuySignal, notificationEmbed } from '../src/shopping-sites.js';
import { AutoPurchaseCoordinator, EslitePurchaseAdapter, MultiAccountEslitePurchaseAdapter, purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { eslitePurchaseReadinessLabel } from '../src/dashboard-status.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const response = (status, body) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => body, dispose: async () => {} });
const target = { id: 'overhaul', name: '誠品測試', enabled: true, sourceType: 'eslite-keywords', siteName: '誠品線上', url: 'https://www.eslite.com/Search', keywords: [], discoveryUrls: ['https://www.eslite.com/exhibitions/CU202608-00061'] };
const toy = (id) => ({ id, title: `BEYBLADE X CX-${id}`, url: `https://www.eslite.com/product/${id}`, available: true, status: 'add_to_shopping_cart', availabilitySource: 'eslite-exhibition-api' });
test('誠品總覽不把三組失效登入顯示成待命', () => {
  assert.equal(eslitePurchaseReadinessLabel(['A','B','C'].map((slot) => ({ slot, enabled: true, loginState: 'needs_login', apiReady: false }))), '需要登入');
  assert.equal(eslitePurchaseReadinessLabel([{ enabled: true, apiReady: true }, { enabled: true, loginState: 'needs_login' }]), '快線就緒 1／2');
  assert.equal(eslitePurchaseReadinessLabel([{ purchaseHold: { productId: '1' } }]), '訂單待核對');
});
function monitorFixture() {
  const notifications = [], candidates = [];
  const state = { data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen: {} } } } } }, async save() {} };
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target], notify: async (text, options) => { notifications.push({ text, options }); return 'mock'; }, onPurchaseCandidate: (product) => candidates.push(product) });
  return { monitor, notifications, candidates, state };
}

test('23 件明確可購來源不二次確認，全部立即交接並跨來源去重', async () => {
  const { monitor, notifications, candidates } = monitorFixture();
  const products = Array.from({ length: 23 }, (_, i) => toy(String(i + 1)));
  monitor.loadEsliteExhibitProducts = async () => Object.assign([...products], { discoveryPage: { url: target.discoveryUrls[0], isLive: true, productCount: 23, title: 'BEYBLADE X' } });
  let verificationCalls = 0;
  monitor.verifyEsliteProduct = async () => { verificationCalls++; throw new Error('不得多打一輪'); };
  try {
    const start = Date.now();
    await monitor.loadEsliteKeywordProducts(target);
    assert.equal(candidates.length, 23);
    assert.equal(verificationCalls, 0);
    assert.ok(Date.now() - start < 5000);
    monitor.applyImmediateEsliteObservations(target, products, { source: 'holmes-search' });
    await tick();
    assert.equal(candidates.length, 23);
    assert.equal(notifications.filter((item) => /發現可購買/.test(item.text)).length, 23);
  } finally { await monitor.close(); }
});

test('未知可購狀態不謊稱售罄，確認慢也不阻塞其他可購商品', async () => {
  const { monitor, notifications, candidates } = monitorFixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  monitor.verifyEsliteProduct = async (item) => { await gate; return { ...item, available: true, availabilitySource: 'eslite-purchase-status' }; };
  monitor.loadEsliteExhibitProducts = async () => [ { ...toy('1'), available: null, status: '' }, toy('2') ];
  try {
    await monitor.loadEsliteKeywordProducts(target);
    assert.deepEqual(candidates.map((item) => item.id), ['2']);
    const notice = notifications.find((item) => item.text.includes('CX-1'));
    assert.match(notice.options.embeds[0].description, /待確認/);
    assert.doesNotMatch(notice.options.embeds[0].description, /已售罄/);
    release(); await Promise.all([...monitor.esliteVerificationJobs.values()]);
    assert.deepEqual(candidates.map((item) => item.id), ['2', '1']);
  } finally { release(); await monitor.close(); }
});

test('來源庫存不能蓋過尚未開賣／禁止加車狀態', () => {
  assert.equal(isEsliteSourceBuySignal(toy('1')), true);
  for (const status of ['can_not_buy', 'coming_soon', 'coming_soon_not_book', '', 'unknown']) {
    assert.equal(isEsliteSourceBuySignal({ ...toy('1'), status }), false);
  }
  assert.match(notificationEmbed(target, toy('1'), null, 'verification-pending').footer.text, /待確認/);
});

test('背景單品確認最多四路，關閉後不再推播或啟動排隊工作', async () => {
  const { monitor, candidates } = monitorFixture();
  let release, running = 0, peak = 0, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  monitor.verifyEsliteProduct = async (item) => { calls++; running++; peak = Math.max(peak, running); await gate; running--; return { ...item, availabilitySource: 'eslite-purchase-status' }; };
  const tasks = Array.from({ length: 10 }, (_, i) => monitor.queueEsliteVerification(target, toy(String(i)), 'test'));
  await tick(); assert.equal(peak, 4);
  const closed = monitor.close(); release(); await closed; await Promise.all(tasks);
  assert.equal(calls, 4); assert.equal(candidates.length, 0);
  assert.equal(monitor.esliteVerificationJobs.size, 0);
});

test('單品逾時採 1、2、4、5 秒有界退避，不再固定封鎖 30 秒', async () => {
  const { monitor } = monitorFixture();
  for (const expected of [1000, 2000, 4000, 5000, 5000]) {
    const now = Date.now(); monitor._backoffEsliteProduct('1');
    assert.ok(monitor.esliteProductBlockedUntil.get('1') - now >= expected);
    assert.ok(monitor.esliteProductBlockedUntil.get('1') - now <= expected + 100);
  }
  await monitor.close();
});

function apiFixture(checkouts) {
  let adds = 0, submits = 0;
  return {
    api: { async get() { return response(200,{cart:{cart_items:[]}}); }, async post(url) { if (url.includes('/cart/items')) { adds++; return response(200, { product_guid: '1', response_quantity: 1 }); } const value = checkouts[Math.min(submits++, checkouts.length - 1)]; if (value instanceof Error) throw value; return value; } },
    counts: () => ({ adds, submits })
  };
}
const purchaseOptions = { sessionFile: 'not-used', product: toy('1'), settings: { action: 'checkout', quantity: 1 }, checkoutTemplate: { checkout: { payment: '8' } }, prevalidated: true, deadlineMs: 20000 };

test('明確 422 忙碌拒絕只重送相同車最多三次，不重複加車', async () => {
  const mock = apiFixture([response(422, { success: false, errors: ['系統忙碌'] }), response(200, { order_id: 'MOCK-1' })]);
  const logs = [];
  const result = await purchaseEsliteViaApi({ ...purchaseOptions, apiContext: mock.api, log: (text) => logs.push(text) });
  assert.equal(result.status, 'ordered'); assert.deepEqual(mock.counts(), { adds: 1, submits: 2 });
  assert.equal(result.timings.checkoutAttempts, 2); assert.match(logs.at(-1), /12｜核對正式訂單 完成 1\/1/);
  const alwaysBusy = apiFixture([response(422, { success: false, error: '系統忙碌' })]);
  await assert.rejects(purchaseEsliteViaApi({ ...purchaseOptions, apiContext: alwaysBusy.api }), (error) => error.purchaseStatus === 'checkout_busy' && error.timings.checkoutAttempts === 3);
  assert.deepEqual(alwaysBusy.counts(), { adds: 1, submits: 3 });
});

test('模糊 422、5xx、429、送單斷線與缺訂單號絕不自動重送', async () => {
  for (const value of [response(422, { errors: [] }), response(503, {}), response(429, {}), new Error('timeout'), response(200, {})]) {
    const mock = apiFixture([value]);
    const result = await purchaseEsliteViaApi({ ...purchaseOptions, apiContext: mock.api });
    assert.equal(result.status, 'submitted_unconfirmed'); assert.deepEqual(mock.counts(), { adds: 1, submits: 1 });
  }
});

async function adapterFixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-overhaul-'));
  const sessionFile = path.join(dataDir, 'session.json');
  await fs.writeFile(sessionFile, '{}');
  const adapter = new EslitePurchaseAdapter({ dataDir, sessionFile, getCredentials: () => ({ account: 'mock', password: 'mock' }), getCheckoutTemplate: () => ({ checkout: { payment: '8' } }), apiContextFactory: async () => ({ api: { dispose: async () => {} }, expiresAtMs: Date.now() + 86400000 }), apiMaintenanceRunner: async () => ({ ok: true, loggedIn: true, cartEmpty: true }), ...options });
  return { adapter, dataDir, async close() { await adapter.close(); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

test('到期登入只嘗試背景恢復，API 驗證成功才恢復待命', async () => {
  let factories = 0, recoveries = 0;
  const f = await adapterFixture({ apiContextFactory: async () => { if (++factories === 1) throw Object.assign(new Error('登入已失效'), { purchaseStatus: 'needs_login' }); return { api: { dispose: async () => {} }, expiresAtMs: Date.now() + 86400000 }; }, sessionRecoveryRunner: async () => { recoveries++; } });
  try { const result = await f.adapter.verifyStoredSession(); assert.equal(result.recovered, true); assert.equal(recoveries, 1); assert.equal(f.adapter.runtimeStatus().apiReady, true); } finally { await f.close(); }
});

test('背景登入遇官方驗證只告警一次，冷卻期不重開瀏覽器', async () => {
  let recoveries = 0, alerts = 0;
  const f = await adapterFixture({ apiContextFactory: async () => { throw Object.assign(new Error('登入已失效'), { purchaseStatus: 'needs_login' }); }, sessionRecoveryRunner: async () => { recoveries++; throw new Error('需要官方驗證'); }, onSessionProblem: async () => { alerts++; } });
  try { await f.adapter.verifyStoredSession(); await f.adapter.verifyStoredSession(); await tick(); assert.equal(recoveries, 1); assert.equal(alerts, 1); assert.equal(f.adapter.loginState, 'needs_login'); } finally { await f.close(); }
});

test('暫時 API 連線慢不誤判登出也不觸發重新登入', async () => {
  let recoveries = 0;
  const f = await adapterFixture({ apiMaintenanceRunner: async () => { throw new Error('Timeout 2500ms'); }, sessionRecoveryRunner: async () => { recoveries++; } });
  try { f.adapter.loginState = 'ready'; const result = await f.adapter.verifyStoredSession(); assert.equal(result.loggedIn, null); assert.equal(f.adapter.loginState, 'ready'); assert.equal(recoveries, 0); } finally { await f.close(); }
});

test('不確定訂單跨重啟保護：禁止下一款與清車', async () => {
  let runs = 0;
  const f = await adapterFixture({ apiPurchaseRunner: async () => { runs++; return { status: 'submitted_unconfirmed' }; } });
  try {
    await f.adapter.purchase(toy('1'), { action: 'checkout' });
    await assert.rejects(f.adapter.purchase(toy('2'), { action: 'checkout' }), (error) => error.purchaseStatus === 'account_held');
    assert.equal(runs, 1);
    const restarted = await adapterFixture({ getPurchaseHold: () => ({ productId: '1' }) });
    try { await assert.rejects(restarted.adapter.purchase(toy('2'), { action: 'checkout' }), (error) => error.purchaseStatus === 'account_held'); await assert.rejects(restarted.adapter.maintainSession({ clearCart: true }), /禁止心跳清車/); } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('A 登入失效不拖住已預熱 B／C，付款策略仍獨立', async () => {
  const multi = new MultiAccountEslitePurchaseAdapter({ dataDir: os.tmpdir(), getAccounts: () => ['A', 'B', 'C'].map((slot) => ({ slot, enabled: true, account: 'mock', password: 'mock' })) });
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  for (const [slot, adapter] of Object.entries(multi.adapters)) {
    adapter.loginState = slot === 'A' ? 'needs_login' : 'ready';
    adapter._apiReady = () => slot !== 'A';
    adapter.purchase = async (_product, settings) => { calls.push([slot, settings.payment]); await gate; return { status: 'ordered', orderId: `MOCK-${slot}` }; };
  }
  const first = multi.purchase(toy('1'), { accountPayments: { B: 'virtual_atm_home', C: 'seven_cod' } });
  const second = multi.purchase(toy('2'), { accountPayments: { B: 'virtual_atm_home', C: 'seven_cod' } });
  await tick(); assert.deepEqual(calls, [['B', 'virtual_atm_home'], ['C', 'seven_cod']]);
  release(); await Promise.all([first, second]); await multi.close();
});

test('永久紀錄不含帳密或結帳範本，重設不刪除檔案，不明訂單不能重設', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-history-'));
  const history = path.join(dir, 'orders.jsonl');
  const record = { platform: 'eslite', status: 'failed', accountSlot: 'A', product: { ...toy('1'), password: 'SECRET' }, password: 'SECRET', checkout: { private: 'SECRET' }, timings: { totalMs: 3 } };
  const state = { data: { commerce: { autoPurchase: { records: { 'eslite:1': record } } } }, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => ({}), adapters: {}, notifyPrivate: async () => {}, esliteHistoryFile: history });
  try {
    await coordinator._recordEsliteAttempt(record); await coordinator.reset('eslite', '1');
    const text = await fs.readFile(history, 'utf8'); assert.doesNotMatch(text, /SECRET|password|checkout/); assert.equal(JSON.parse(text).product.id, '1');
    state.data.commerce.autoPurchase.records['eslite:1'] = { ...record, status: 'submitted_unconfirmed' };
    await assert.rejects(coordinator.reset('eslite', '1'), /不能重設/);
    assert.equal(await fs.readFile(history, 'utf8'), text);
  } finally { await coordinator.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('重啟時已分配帳號的中斷工作轉為待核對，不當成可重試失敗', async () => {
  const state = { data: { commerce: { autoPurchase: { records: {
    'eslite:1': { platform: 'eslite', status: 'processing', accountSlot: 'B', product: toy('1') },
    'eslite:2': { platform: 'eslite', status: 'processing', product: toy('2') }
  } } } }, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => ({}), adapters: {}, notifyPrivate: async () => {} });
  assert.equal(state.data.commerce.autoPurchase.records['eslite:1'].status, 'submitted_unconfirmed');
  assert.equal(state.data.commerce.autoPurchase.records['eslite:2'].purchaseStatus, 'interrupted_before_assignment');
  await coordinator.close();
});

test('解除帳號保護需要明確人工確認並保留原始紀錄', async () => {
  const f = await adapterFixture({ getPurchaseHold: () => null });
  f.adapter.purchaseHold = { productId: '1' };
  const record = { platform: 'eslite', status: 'submitted_unconfirmed', accountSlot: 'B', product: toy('1') };
  const state = { data: { commerce: { autoPurchase: { records: { 'eslite:1': record } } } }, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => ({}), adapters: { eslite: { adapters: { B: f.adapter }, busySlots: new Set(), credentialsStatus: () => ({ ready: true }), close: async () => {} } }, notifyPrivate: async () => {} });
  try {
    await assert.rejects(coordinator.resolveEsliteHold({ accountSlot: 'B', confirmedNoOrder: false }), /人工核對/);
    assert.equal(record.status, 'submitted_unconfirmed');
    await coordinator.resolveEsliteHold({ accountSlot: 'B', confirmedNoOrder: true });
    assert.equal(record.status, 'manually_confirmed_no_order');
    assert.equal(f.adapter.purchaseHold, null); assert.ok(record.resolvedAt);
  } finally { await coordinator.close(); await f.close(); }
});

test('背景確認在監控時段結束後不再交接購買與推播', async () => {
  const { monitor, candidates } = monitorFixture();
  let allowed = true, release;
  const gate = new Promise((resolve) => { release = resolve; });
  monitor.isEsliteMonitoringAllowed = () => allowed;
  monitor.verifyEsliteProduct = async (item) => { await gate; return { ...item, availabilitySource: 'eslite-purchase-status' }; };
  const job = monitor.queueEsliteVerification(target, toy('1'), 'test');
  allowed = false; release(); await job;
  assert.equal(candidates.length, 0); await monitor.close();
});
