import test from 'node:test';
import assert from 'node:assert/strict';
import { PurchaseLedger, taipeiPurchaseDay } from '../src/purchase-ledger.js';
import { purchasePolicy, normalizeDispatchSettings } from '../src/purchase-rules.js';
import { planAccountPurchase, sortPurchaseTasks, selectAccountBatch, compatibleWithPayment } from '../src/purchase-dispatcher.js';
import { AutoPurchaseCoordinator, updateAutoPurchaseSettings, purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { fillEsliteBatchCart, assertEsliteBatchItems, verifyEsliteBatchQuote } from '../src/eslite-batch-cart.js';
import { matchEsliteProductOrder } from '../src/eslite-orders.js';
import { esliteSheetOrderRowsHtml } from '../src/eslite-purchase-ui.js';
import { funboxSheetRecords } from '../src/funbox-purchase-ui.js';

const day1 = '2026-10-11T15:59:59Z', day2 = '2026-10-11T16:00:00Z';
const p = (id, extra = {}) => ({ id, title: `BEYBLADE X ${id}`, url: `https://shop.funbox.com.tw/products/${id}`, stock: 10, ...extra });
const rules = { buyKeywords: ['BEYBLADE'], skipBuyKeywords: [], priorityKeywords: [], quantity: 1 };
const response = (body, status = 200) => ({ ok: () => status >= 200 && status < 300, status: () => status, json: async () => body, dispose: async () => {} });

test('台北午夜改日期桶，不刪除訂單；缺時間不能當今天', () => {
  assert.equal(taipeiPurchaseDay(day1), '2026-10-11'); assert.equal(taipeiPurchaseDay(day2), '2026-10-12');
  assert.equal(taipeiPurchaseDay(''), ''); assert.equal(taipeiPurchaseDay(null), '');
  const data = {}, ledger = new PurchaseLedger(data);
  ledger.recordOrder({ platform: 'funbox', identity: 'A', reference: 'F1', at: day1, items: [{ id: 'BX-20', quantity: 1 }] });
  assert.equal(ledger.remaining('funbox', 'A', 'BX-20', 1, day1), 0);
  assert.equal(ledger.remaining('funbox', 'A', 'BX-20', 1, day2), 1);
  assert.equal(Object.keys(data.purchaseLedger.orders).length, 1);
});
test('隨機強化組同日 2+1 累計三；訂單重查不重複記帳', () => {
  const ledger = new PurchaseLedger({}), row = { platform: 'funbox', identity: 'A', reference: 'F1', at: day1, items: [{ id: 'BX-35', quantity: 2 }] };
  ledger.recordOrder(row); ledger.recordOrder(row);
  assert.equal(ledger.remaining('funbox', 'A', 'BX-35', 3, day1), 1);
  assert.equal(ledger.remaining('funbox', 'B', 'BX-35', 3, day1), 3);
  const plan = planAccountPurchase({ platform: 'funbox', product: p('BX-35', { title: 'BEYBLADE 隨機強化組 BX-35' }), settings: rules, identity: 'A', ledger, at: day1 });
  assert.equal(plan.quantity, 1);
  ledger.recordOrder({ ...row, reference: 'F2', items: [{ id: 'BX-35', quantity: 1 }] });
  assert.equal(ledger.remaining('funbox', 'A', 'BX-35', 3, day1), 0);
  assert.throws(() => ledger.recordOrder({ ...row, items: [{ id: 'BX-35', quantity: 3 }] }), /不一致/);
});
test('未知送單跨午夜及重啟仍占額度；無單號不能解除', () => {
  const data = {}, ledger = new PurchaseLedger(data);
  ledger.reserve('t1', 'funbox', 'A', [{ id: 'BX-35', quantity: 3 }], day1);
  ledger.settle('t1', { status: 'submitted_unconfirmed' });
  const restarted = new PurchaseLedger(JSON.parse(JSON.stringify(data)));
  assert.equal(restarted.remaining('funbox', 'A', 'BX-35', 3, day2), 0);
  restarted.settle('t1', { status: 'ordered' });
  assert.equal(restarted.data.reservations.t1.status, 'held');
  restarted.settle('t1', { status: 'ordered', orderNumber: 'F1', completedAt: day1, items: [{ id: 'BX-35', quantity: 2 }] });
  assert.equal(restarted.remaining('funbox', 'A', 'BX-35', 3, day1), 1);
  assert.equal(restarted.remaining('funbox', 'A', 'BX-35', 3, day2), 3);
});
test('誠品永久限購；一般款一天一件及午夜重置標示人工假設', () => {
  const ledger = new PurchaseLedger({});
  ledger.recordOrder({ platform: 'eslite', identity: 'A', reference: 'E1', at: day1, items: [{ id: 'UX-03', quantity: 1 }] });
  assert.equal(ledger.remaining('eslite', 'A', 'UX-03', null, day2), 0);
  const policy = purchasePolicy('funbox', p('BX-20'), rules);
  assert.equal(policy.evidence, 'manual_assumption_daily_1'); assert.equal(policy.resetEvidence, 'manual_assumption_taipei_midnight');
  assert.equal(purchasePolicy('funbox', p('BX-35', { title: 'BEYBLADE 隨機強化組' }), rules).dailyLimit, 3);
});
test('黑名單優先於白名單及心願清單；型號不誤中 BX-090', () => {
  const settings = { ...rules, skipBuyKeywords: ['BX-09'], priorityKeywords: ['BX-09'] };
  assert.equal(purchasePolicy('funbox', p('BX-09'), settings).reason, 'blacklist');
  assert.equal(purchasePolicy('funbox', p('BX-090'), settings).eligible, true);
  assert.equal(purchasePolicy('funbox', { title: 'TOMICA' }, rules).eligible, false);
  assert.equal(purchasePolicy('eslite', { title: 'TOMICA' }, { ...rules, buyMode: 'all' }).eligible, true);
  assert.equal(purchasePolicy('eslite', { title: 'TOMICA' }, { ...rules, buyMode: 'whitelist' }).eligible, false);
});
test('優先組保留發現順序；其他款用帳號隨機順位', () => {
  const settings = { ...rules, priorityKeywords: ['BX-09', '強化組'] };
  const items = [p('1'), p('2', { title: '隨機強化組' }), p('BX-09'), p('4', { title: '隨機強化組' }), p('5')]
    .map((product, i) => ({ platform: 'eslite', product, discoveryOrder: i, rank: 5 - i }));
  assert.deepEqual(sortPurchaseTasks(items, settings).map(i => i.product.id), ['BX-09', '2', '4', '5', '1']);
});
test('合單只選本帳號本平台；模式預設單品；人工超商排除規則', () => {
  const first = { platform: 'funbox', accountSlot: 'A', accountIdentity: 'a' }, other = { ...first, id: 2 };
  const settings = { accountModes: { A: 'batch' }, batchMaxItems: 2 };
  assert.deepEqual(selectAccountBatch(first, [{ ...first, accountSlot: 'B' }, { ...first, platform: 'eslite' }, other], settings, () => true), [first, other]);
  assert.deepEqual(normalizeDispatchSettings().accountModes, {});
  assert.equal(compatibleWithPayment({ title: '戰鬥盤' }, 'seven_cod', { sevenCodBlockedKeywords: ['戰鬥盤'] }), false);
  assert.equal(compatibleWithPayment({ title: '戰鬥盤' }, 'virtual_atm_home', { sevenCodBlockedKeywords: ['戰鬥盤'] }), true);
});
test('UI 設定可保存零等待與每帳號模式；非法模式不改設定', () => {
  const saved = updateAutoPurchaseSettings({}, { platform: 'funbox', funboxAccountModes: { A: 'batch', B: 'single', D: 'batch' }, funboxBatchCollectMs: 0, funboxBatchMaxItems: 4, funboxBatchMaxTotal: 2200 });
  assert.equal(saved.funbox.accountModes.D, 'batch'); assert.equal(saved.funbox.batchCollectMs, 0); assert.equal(saved.funbox.batchMaxTotal, 2200);
  assert.throws(() => updateAutoPurchaseSettings(saved, { funboxAccountModes: { A: 'parallel-post' } }), /單品或合單/);
});

async function batchFixture(options = {}) {
  const cart = [], adds = [], steps = []; let clock = 0;
  const products = [p('1', { quantity: 1 }), p('2', { quantity: 2 }), p('3', { quantity: 1 })];
  const api = { post: async (_url, { data }) => {
    adds.push(data.product_guid); clock += options.latency || 1;
    if (data.product_guid === options.skip) return response({ error: options.limit ? '曾經購買，限購' : '已售罄' }, 409);
    cart.push({ product_guid: data.product_guid, qty: data.qty });
    if (data.product_guid === options.timeout) throw new Error('timeout');
    return response({ product_guid: data.product_guid, response_quantity: data.qty });
  } };
  const run = () => fillEsliteBatchCart({ api, products, settings: { batchBuildMs: options.budget || 8000, batchAllowPartial: options.partial !== false },
    readCart: async () => options.extra ? [...cart, { product_guid: 'other', qty: 1 }] : cart, timeoutForStep: x => x, checkpoint: (...s) => steps.push(s), now: () => clock });
  return { run, adds, steps };
}
test('誠品合單：依序加車、售罄排除、封箱只含實際成功款', async () => {
  const f = await batchFixture({ skip: '2' }), result = await f.run();
  assert.deepEqual(f.adds, ['1', '2', '3']); assert.deepEqual(result.products.map(p => p.id), ['1', '3']);
  assert.equal(result.quantity, 2); assert.equal(result.skippedProducts[0].reason, 'stock_out');
});
test('誠品合單：加車逾時查車而非重加；其他商品不混車', async () => {
  const f = await batchFixture({ timeout: '2' }); assert.equal((await f.run()).quantity, 4); assert.equal(f.adds.length, 3);
  await assert.rejects((await batchFixture({ extra: true })).run(), /不符/);
});
test('誠品合單：封箱期限不等所有款；不允許缺款則不送', async () => {
  const result = await (await batchFixture({ latency: 1000, budget: 1500 })).run();
  assert.equal(result.products.length, 2); assert.equal(result.skippedProducts.length, 1);
  await assert.rejects((await batchFixture({ skip: '2', partial: false })).run(), /未接受/);
});
test('誠品合單：可用付款、含運上限與未知金額都先擋下', async () => {
  const quote = subtotal => ({ get: async url => response(url.includes('payments_deliveries') ? { shipping_fee: { '2': { payment_codes: ['7'], main_island_fee: 50 } } } : { cart: { total_amount: subtotal } }) });
  const args = { checkout: { delivery: '2', payment: '7' }, maxTotal: 500, timeoutForStep: () => 5000 };
  assert.equal((await verifyEsliteBatchQuote({ ...args, api: quote(400) })).total, 450);
  await assert.rejects(verifyEsliteBatchQuote({ ...args, api: quote(451) }), /超過/);
  await assert.rejects(verifyEsliteBatchQuote({ ...args, api: quote(undefined) }), /不明/);
  await assert.rejects(verifyEsliteBatchQuote({ ...args, checkout: { delivery: '2', payment: '8' }, api: quote(100) }), /未提供/);
});
test('誠品合單真實 runner 合約：清車→逐款加車→紅利0→一張單', async () => {
  const cart = [], events = []; let intent, submits = 0;
  const products = [p('1', { quantity: 1 }), p('2', { quantity: 1 })];
  const api = { get: async url => {
    events.push(url);
    if (url.includes('payments_deliveries')) return response({ shipping_fee: { '2': { payment_codes: ['7'], main_island_fee: 50 } } });
    return response({ cart: { cart_items: cart, total_amount: 200 } });
  }, post: async (url, opts) => {
    if (url.includes('/cart/items')) { cart.push({ product_guid: opts.data.product_guid, qty: opts.data.qty }); return response({ product_guid: opts.data.product_guid, response_quantity: opts.data.qty }); }
    assert.equal(opts.data.checkout.discount_point, 0); submits++; return response({ order_number: 'E-MOCK' });
  } };
  const result = await purchaseEsliteViaApi({ product: products[0], apiContext: api, prevalidated: true,
    settings: { action: 'checkout', payment: 'virtual_atm_home', batchProducts: products, maxTotal: 300, batchAllowPartial: true, onBeforeSubmit: async i => { intent = i; } },
    checkoutTemplate: { checkout: { discount_point: 150, delivery: '2', payment: '7' } } });
  assert.equal(result.status, 'ordered'); assert.equal(submits, 1); assert.equal(result.products.length, 2); assert.equal(result.amount, 250);
  assert.equal(intent.products.length, 2); assert.ok(events[0].includes('step=1'));
});
test('合單查單需整車品項數量唯一匹配；單款匹配不能解除整車未知', () => {
  const order = { createdAt: day1, orderId: 'E1', items: [{ id: '1', quantity: 1 }, { id: '2', quantity: 2 }] };
  const args = { products: order.items, startedAt: day1 };
  assert.equal(matchEsliteProductOrder([order], args), order);
  assert.equal(matchEsliteProductOrder([order, { ...order, orderId: 'E2' }], args), null);
  assert.equal(matchEsliteProductOrder([order], { ...args, products: [{ id: '1', quantity: 1 }] }), null);
  assert.throws(() => assertEsliteBatchItems([{ product_guid: '1', qty: 2 }], [{ id: '1', quantity: 1 }]), /不符/);
});

for (const platform of ['eslite', 'funbox']) test(`${platform} 總管：A合單、B單品，獨立清車及逐款記帳`, async () => {
  const state = { data: {}, save: async () => {}, writeSnapshot: async () => {} }, calls = [], notifications = [];
  const config = { enabled: true, [platform]: { ...rules, enabled: true, buyMode: 'all', accountModes: { A: 'batch', B: 'single' }, batchCollectMs: 50, batchMaxItems: 5 } };
  const adapter = { independentQueues: true, maxConcurrency: 3, queueSlots: () => ['A', 'B'], accountIdentity: s => s, queueBlockReason: () => '',
    credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {},
    purchase: async (product, settings) => {
      const products = settings.batchProducts || [{ ...product, quantity: settings.quantity }];
      calls.push({ slot: settings.accountSlot, products }); await settings.onAccountAssigned(settings.accountSlot);
      await settings.onBeforeSubmit({ products });
      return { status: 'ordered', accountSlot: settings.accountSlot, orderNumber: `O${calls.length}`, orderId: `O${calls.length}`, products, quantity: products.reduce((s, p) => s + p.quantity, 0) };
    } };
  const c = new AutoPurchaseCoordinator({ state, adapters: { [platform]: adapter }, getConfig: () => config, notifyPrivate: async m => notifications.push(m) });
  try {
    const queued = await c.enqueue(platform, [p('1'), p('2'), p('3')]); assert.equal(queued.accepted, 6);
    await c.whenIdle();
    assert.equal(calls.filter(x => x.slot === 'A').length, 1); assert.equal(calls.find(x => x.slot === 'A').products.length, 3);
    assert.equal(calls.filter(x => x.slot === 'B').length, 3);
    const storage = state.data.commerce.autoPurchase;
    assert.equal(Object.keys(storage.purchaseLedger.orders).length, 4);
    assert.equal(Object.keys(storage.purchaseLedger.reservations).length, 0);
    assert.equal(Object.keys(storage[platform + 'Purchased'].A).length, 3);
    assert.equal((await c.enqueue(platform, [p('1'), p('2'), p('3')])).accepted, 0);
    if (platform === 'funbox') { await c.close(); assert.ok(notifications.some(m => m.includes('成功單號：') && m.includes('購物車內容：'))); }
  } finally { await c.close(); }
});
test('FUNBOX總管：同日強化組買2後新鮮觀測可補1；午夜不沿用永久停止', async () => {
  let clock = Date.now(), count = 0; const calls = [], state = { data: {}, save: async () => {} };
  const config = { enabled: true, funbox: { ...rules, enabled: true } };
  const adapter = { independentQueues: true, maxConcurrency: 1, queueSlots: () => ['A'], accountIdentity: () => 'A', queueBlockReason: () => '',
    credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {}, purchase: async (product, settings) => {
      calls.push(settings.quantity); await settings.onAccountAssigned('A');
      return { status: 'ordered', orderNumber: 'F' + (++count), quantity: count === 1 ? 2 : settings.quantity };
    } };
  const c = new AutoPurchaseCoordinator({ state, adapters: { funbox: adapter }, getConfig: () => config, notifyPrivate: async () => {},
    continuousFunboxTasks: true, funboxTaskClock: () => clock });
  const product = () => p('booster', { title: 'BEYBLADE 隨機強化組', available: true, variantId: '1', reason: 'restock', detectedAt: new Date(clock).toISOString() });
  try {
    await c.enqueue('funbox', [product()]); await c.whenIdle(); assert.deepEqual(calls, [3]);
    clock += 6000; c.observeFunboxInventory([product()], clock); await c.whenIdle(); assert.deepEqual(calls, [3, 1]);
    clock += 6000; c.observeFunboxInventory([product()], clock); await c.whenIdle(); assert.equal(calls.length, 2);
    clock += 86400000; await c.enqueue('funbox', [product()]); await c.whenIdle(); assert.deepEqual(calls, [3, 1, 3]);
  } finally { await c.close(); }
});
test('合單結果不明持久保留整批，重啟不能把其他款視為可買', async () => {
  const state = { data: {}, save: async () => {} }, child = {}, adapter = {
    independentQueues: true, maxConcurrency: 1, adapters: { A: child }, queueSlots: () => ['A'], accountIdentity: () => 'A',
    queueBlockReason: () => child.purchaseHold ? '待查單' : '', credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {},
    purchase: async (_product, settings) => { await settings.onAccountAssigned('A'); return { status: 'submitted_unconfirmed', products: settings.batchProducts }; }
  };
  const config = { enabled: true, funbox: { ...rules, enabled: true, accountModes: { A: 'batch' }, batchCollectMs: 20 } };
  const c = new AutoPurchaseCoordinator({ state, adapters: { funbox: adapter }, getConfig: () => config, notifyPrivate: async () => {} });
  try {
    await c.enqueue('funbox', [p('1'), p('2')]); await c.whenIdle(); assert.equal(child.purchaseHold.products.length, 2);
    const ledger = new PurchaseLedger(JSON.parse(JSON.stringify(state.data.commerce.autoPurchase)));
    assert.equal(ledger.remaining('funbox', 'A', '1', 1), 0); assert.equal(ledger.remaining('funbox', 'A', '2', 1), 0);
    assert.equal((await c.enqueue('funbox', [p('1'), p('2')])).accepted, 0);
  } finally { await c.close(); }
});
test('官方已有單號但本地記帳失敗：保留單號與整車額度，不當成未送單', async () => {
  const state = { data: {}, save: async () => {} }, child = {}, adapter = {
    independentQueues: true, maxConcurrency: 1, adapters: { A: child }, queueSlots: () => ['A'], accountIdentity: () => 'A',
    queueBlockReason: () => child.purchaseHold ? '待查單' : '', credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {},
    purchase: async (_product, settings) => {
      await settings.onAccountAssigned('A'); await settings.onBeforeSubmit({ products: settings.batchProducts });
      return { status: 'ordered', accountSlot: 'A', orderNumber: 'F-LOCAL-ERROR', products: settings.batchProducts };
    }
  };
  const config = { enabled: true, funbox: { ...rules, enabled: true, accountModes: { A: 'batch' }, batchCollectMs: 20 } };
  const c = new AutoPurchaseCoordinator({ state, adapters: { funbox: adapter }, getConfig: () => config, notifyPrivate: async () => {} });
  const getLedger = c._ledger.bind(c); let injected = false;
  c._ledger = () => {
    const ledger = getLedger(), settle = ledger.settle.bind(ledger);
    ledger.settle = (taskId, result) => {
      if (!injected && result.status === 'ordered') { injected = true; throw new Error('模擬本地記帳失敗'); }
      return settle(taskId, result);
    };
    return ledger;
  };
  try {
    await c.enqueue('funbox', [p('1'), p('2')]); await c.whenIdle();
    const record = state.data.commerce.autoPurchase.recent[0];
    assert.equal(injected, true); assert.equal(record.orderNumber, 'F-LOCAL-ERROR');
    assert.equal(record.status, 'submitted_unconfirmed'); assert.equal(child.purchaseHold.products.length, 2);
    assert.equal(Object.values(state.data.commerce.autoPurchase.purchaseLedger.reservations)[0].status, 'held');
    assert.equal((await c.enqueue('funbox', [p('1'), p('2')])).accepted, 0);
  } finally { await c.close(); }
});

test('合單表格一張單顯示所有款，HTML 仍跳脫', () => {
  const record = { platform: 'funbox', mode: 'batch', accountSlot: 'A', taskId: 't', status: 'ordered', orderNumber: 'F1', products: [p('1', { title: '<img>', quantity: 1 }), p('2', { quantity: 2 })] };
  const rows = funboxSheetRecords({ recent: [record] }).rows;
  const html = esliteSheetOrderRowsHtml(rows); assert.ok(html.includes('&lt;img&gt; ×1')); assert.ok(html.includes('BEYBLADE X 2 ×2')); assert.equal(html.includes('<img>'), false);
});
