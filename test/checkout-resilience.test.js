import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoPurchaseCoordinator, purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { verifyEsliteBatchQuote } from '../src/eslite-batch-cart.js';
import { EsliteRestockTasks } from '../src/eslite-restock-tasks.js';
import { purchaseRequestBudget } from '../src/purchase-deadline.js';
import { submitFunboxAtmCheckout } from '../src/funbox-api-checkout.js';

test('整筆共用時間預算，後續請求只用剩餘時間；到期前未送的 POST 次數為零', async () => {
  let clock = 0, posts = 0; const timeouts = [];
  const api = { get: async (_url, options) => { timeouts.push(options.timeout); clock += 700; }, post: async () => { posts++; } };
  const budget = purchaseRequestBudget(api, { deadlineMs: 1000, now: () => clock });
  await budget.request.get('/read', { timeout: 8000 });
  await budget.request.get('/read', { timeout: 8000 });
  assert.deepEqual(timeouts, [1000, 300]);
  assert.throws(() => budget.request.post('/submit'), error => error.purchaseStatus === 'deadline_exceeded' && error.requestNotDispatched);
  assert.equal(posts, 0);
});

test('已派送的逾時 POST 不自動再送；不可把網路錯誤當成尚未派送', async () => {
  let posts = 0;
  const api = { post: async () => { posts++; throw Object.assign(new Error('timeout'), { purchaseStatus: 'deadline_exceeded' }); } };
  const result = await submitFunboxAtmCheckout({ api: purchaseRequestBudget(api).request,
    prepared: { contract: { cartUrl: 'https://shop.funbox.com.tw/carts/' + 'a'.repeat(32) }, form: {}, headers: {} } });
  assert.equal(result.status, 'submitted_unconfirmed'); assert.equal(posts, 1);
});

test('送單前預算已到期不誤記結果不明，不觸發第二張或付款切換', async () => {
  let clock = 0, posts = 0;
  const budget = purchaseRequestBudget({ post: async () => { posts++; } }, { deadlineMs: 1, now: () => clock }); clock = 2;
  await assert.rejects(submitFunboxAtmCheckout({ api: budget.request,
    prepared: { contract: { cartUrl: 'https://shop.funbox.com.tw/carts/' + 'a'.repeat(32) }, form: {}, headers: {} } }),
  error => error.purchaseStatus === 'deadline_exceeded' && error.requestNotDispatched);
  assert.equal(posts, 0);
});

test('只有已確認上一單、零加車量的封箱延期可重排；仍需新觀測與次數上限', () => {
  let clock = Date.now(); const tasks = new EsliteRestockTasks({ now: () => clock, maxAttempts: 3 });
  const observe = () => tasks.observe({ id: 'one', url: 'https://www.eslite.com/product/one', available: true, freshObservationAt: new Date(clock).toISOString() }, { activate: true });
  const deferred = { status: 'skipped', purchaseStatus: 'batch_deferred', batchParentStatus: 'ordered', orderId: 'MOCK', quantity: 0 };
  observe(); tasks.complete('one', 'key', deferred, 'A'); assert.equal(tasks.reason('one', 'key', 'A'), '等待失敗後的新觀測');
  clock++; observe(); assert.equal(tasks.reason('one', 'key', 'A'), '');
  tasks.complete('one', 'key', deferred, 'A'); clock++; observe(); tasks.complete('one', 'key', deferred, 'A'); clock++; observe();
  assert.match(tasks.reason('one', 'key', 'A'), /任務上限/);
  for (const patch of [{ batchParentStatus: 'submitted_unconfirmed' }, { orderId: '' }, { quantity: 1 }, { purchaseStatus: 'purchase_limited' }, { purchaseStatus: 'stock_out' }]) {
    const other = new EsliteRestockTasks({ now: () => clock });
    other.observe({ id: 'one', url: 'https://www.eslite.com/product/one', available: true, freshObservationAt: new Date(clock).toISOString() }, { activate: true });
    other.complete('one', 'key', { ...deferred, ...patch }, 'A'); clock++;
    other.observe({ id: 'one', url: 'https://www.eslite.com/product/one', available: true, freshObservationAt: new Date(clock).toISOString() });
    assert.notEqual(other.reason('one', 'key', 'A'), '');
  }
});

test('誠品合單 COD 官方不可用：同車改 ATM、重新核價、紅利零，不重加或重送', async () => {
  const cart = [], submissions = [];
  const response = body => ({ ok: () => true, status: () => 200, json: async () => body, dispose: async () => {} });
  const api = { get: async url => response(url.includes('payments_deliveries') ? { shipping_fee: { '2': { payment_codes: ['3'], main_island_fee: 50 } } }
    : { cart: { cart_items: cart, total_amount: 100 } }), post: async (url, options) => {
      if (url.includes('/cart/items')) { cart.push({ product_guid: options.data.product_guid, qty: options.data.qty }); return response({ product_guid: options.data.product_guid, response_quantity: 1 }); }
      submissions.push(options.data.checkout); return response({ order_number: 'MOCK-ATM' }); } };
  const result = await purchaseEsliteViaApi({ apiContext: api, prevalidated: true, product: { id: 'one' },
    checkoutTemplate: { paymentMode: 'seven_cod', checkout: { payment: '8', delivery: '5', discount_point: 100,
      subscriber: { name: '本帳號', country: 'TW', mobile: { number: '0900000000' } } } },
    settings: { payment: 'seven_cod', action: 'checkout', batchProducts: [{ id: 'one', quantity: 1 }], maxTotal: 200, batchAllowPartial: true,
      deliveryProfile: { fullName: '共用收件人', phone: '0900000000', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試地址' } } });
  assert.equal(result.status, 'ordered'); assert.equal(result.payment, 'virtual_atm_home'); assert.equal(result.paymentFallback.from, 'seven_cod');
  assert.equal(result.amount, 150); assert.equal(cart.length, 1); assert.equal(submissions.length, 1);
  assert.equal(submissions[0].discount_point, 0); assert.equal(submissions[0].payment, '3'); assert.equal(submissions[0].delivery, '2');
  assert.equal(submissions[0].subscriber.name, '本帳號'); assert.equal(submissions[0].recipient.name, '共用收件人');
});

test('官方 API 失敗、ATM 不可用、超額，不能用備援掩蓋或猜 LINE Pay 代碼', async () => {
  const response = (body, status = 200) => ({ ok: () => status === 200, status: () => status, json: async () => body, dispose: async () => {} });
  const query = (choices, status = 200) => verifyEsliteBatchQuote({
    api: { get: async url => response(url.includes('payments_deliveries') ? choices : { cart: { total_amount: 100 } }, status) },
    checkout: { payment: '8', delivery: '5' }, requestedPayment: 'seven_cod', maxTotal: 200, timeoutForStep: () => 4000 });
  await assert.rejects(query({}, 503), e => e.purchaseStatus === 'precheckout_unavailable');
  await assert.rejects(query({ shipping_fee: { '2': { payment_codes: ['unknown-linepay-code'], main_island_fee: 50 } } }), e => e.purchaseStatus === 'payment_unavailable');
});

for (const profile of ['smooth', 'late', 'congested']) test('雙站同時補貨：合單延期接續、單品獨立、不重複記帳 ' + profile, async () => {
  let clock = Date.now() + (profile === 'late' ? 10000 : 0);
  const state = { data: {}, save: async () => {}, writeSnapshot: async () => {} }, calls = [], active = new Set();
  const settings = { enabled: true, buyMode: 'whitelist', buyKeywords: ['BEYBLADE'], skipBuyKeywords: [], priorityKeywords: ['BX-09'], accountModes: { A: 'batch', B: 'single' }, batchCollectMs: 0 };
  const adapters = Object.fromEntries(['funbox', 'eslite'].map(platform => [platform, {
    independentQueues: true, maxConcurrency: 3, queueSlots: () => ['A', 'B'], accountIdentity: slot => slot,
    queueBlockReason: () => '', credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {},
    purchase: async (_product, options) => {
      const key = platform + options.accountSlot; assert.equal(active.has(key), false); active.add(key);
      try {
        calls.push({ platform, slot: options.accountSlot }); const reference = 'MOCK-' + platform + '-' + calls.length;
        await options.onAccountAssigned(options.accountSlot);
        const planned = options.batchProducts || [{ ..._product, quantity: 1 }];
        const products = planned.slice(0, 1), skippedProducts = planned.slice(1).map(p => ({ ...p, reason: 'batch_deferred' }));
        if (profile === 'congested') await new Promise(resolve => setImmediate(resolve));
        await options.onBeforeSubmit({ products });
        return { status: 'ordered', orderId: reference, orderNumber: reference, products, skippedProducts, quantity: 1 };
      } finally { active.delete(key); }
    }
  }]));
  const c = new AutoPurchaseCoordinator({ state, adapters, getConfig: () => ({ enabled: true, funbox: settings, eslite: settings }),
    notifyPrivate: async () => {}, continuousFunboxTasks: true, continuousEsliteTasks: true, funboxTaskClock: () => clock, esliteTaskClock: () => clock });
  const product = (platform, id) => ({ id, title: 'BEYBLADE ' + (id === 'one' ? 'BX-09' : 'UX-03'),
    url: (platform === 'funbox' ? 'https://shop.funbox.com.tw/products/' : 'https://www.eslite.com/product/') + id,
    stock: 10, available: true, reason: 'restock', detectedAt: new Date(clock).toISOString(), freshObservationAt: new Date(clock).toISOString() });
  try {
    await Promise.all(['funbox', 'eslite'].map(platform => c.enqueue(platform, [product(platform, 'one'), product(platform, 'two')])));
    await c.whenIdle();
    assert.equal(calls.length, 6);
    clock += 1000;
    c.observeFunboxInventory([product('funbox', 'one'), product('funbox', 'two')], clock);
    for (const id of ['one', 'two']) c.observeEslitePurchaseProduct(product('eslite', id));
    await c.whenIdle();
    assert.equal(calls.length, 8);
    const ledger = state.data.commerce.autoPurchase.purchaseLedger;
    assert.equal(Object.keys(ledger.orders).length, 8); assert.equal(Object.keys(ledger.reservations).length, 0);
    for (const platform of ['funbox', 'eslite']) for (const slot of ['A', 'B']) {
      assert.equal(Object.keys(state.data.commerce.autoPurchase[platform + 'Purchased'][slot]).length, 2);
    }
    clock += 1000;
    c.observeFunboxInventory([product('funbox', 'one'), product('funbox', 'two')], clock);
    for (const id of ['one', 'two']) c.observeEslitePurchaseProduct(product('eslite', id));
    await c.whenIdle(); assert.equal(calls.length, 8);
  } finally { await c.close(); }
});
