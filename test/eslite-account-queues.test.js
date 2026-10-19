import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoPurchaseCoordinator, EslitePurchaseAdapter } from '../src/auto-purchase.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeEsliteOrderBody, esliteOrderTime, summarizeEsliteOrder, readEsliteOrderHistory, matchEsliteSingleProductOrder } from '../src/eslite-orders.js';

const toy = id => ({ id, title: `BEYBLADE X ${id}`, url: `https://www.eslite.com/product/${id}`, stock: 1 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(purchase, { blocked = {}, slots = ['A', 'B', 'C'] } = {}) {
  const calls = [], busy = new Set();
  const state = { data: {}, async save() {} };
  const adapter = { independentQueues: true, maxConcurrency: 3,
    queueSlots: () => slots, accountIdentity: slot => `identity-${slot}`,
    queueBlockReason: slot => blocked[slot] || '', credentialsStatus: () => ({ ready: true }),
    runtimeStatus: () => ({}), close: async () => {},
    async purchase(product, settings) {
      const slot = settings.accountSlot;
      assert.equal(busy.has(slot), false, 'same account must never overlap');
      busy.add(slot); calls.push([slot, product.id]);
      try { await settings.onAccountAssigned(slot); return await purchase(product, slot); }
      finally { busy.delete(slot); }
    }
  };
  const coordinator = new AutoPurchaseCoordinator({ state, adapters: { eslite: adapter },
    getConfig: () => ({ enabled: true, eslite: { enabled: true, buyMode: 'all', skipBuyKeywords: [] } }), notifyPrivate: async () => {} });
  return { coordinator, state, adapter, calls };
}

test('each account owns all eligible products, serial locally and parallel across accounts', async () => {
  let releaseA;
  const gate = new Promise(resolve => { releaseA = resolve; });
  const f = fixture(async (product, slot) => {
    if (slot === 'A') await gate;
    return { status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot };
  });
  try {
    const result = await f.coordinator.enqueue('eslite', ['1', '2', '3', '4', '5'].map(toy));
    assert.equal(result.accepted, 15);
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(f.calls.filter(([slot]) => slot === 'A').length, 1);
    for (const slot of ['B', 'C']) assert.deepEqual(f.calls.filter(([s]) => s === slot).map(([, id]) => id).sort(), ['1', '2', '3', '4', '5']);
    releaseA(); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 15);
    assert.equal((await f.coordinator.enqueue('eslite', ['1', '2', '3', '4', '5'].map(toy))).accepted, 0);
  } finally { releaseA(); await f.coordinator.close(); }
});

test('prior purchase is excluded for that identity only and survives a new coordinator', async () => {
  const f = fixture(async (product, slot) => ({ status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot }));
  f.state.data.commerce.autoPurchase.eslitePurchased = { 'identity-A': { '1': { orderId: 'old' } } };
  try {
    assert.equal((await f.coordinator.enqueue('eslite', [toy('1')])).accepted, 2);
    await f.coordinator.whenIdle();
    assert.deepEqual(f.calls.map(([slot]) => slot).sort(), ['B', 'C']);
    const fresh = new AutoPurchaseCoordinator({ state: f.state, getConfig: f.coordinator.getConfig,
      adapters: { eslite: f.adapter }, notifyPrivate: async () => {} });
    assert.equal((await fresh.enqueue('eslite', [toy('1')])).accepted, 0);
    await fresh.close();
  } finally { await f.coordinator.close(); }
});

test('held account retains its own queue; others continue; expired tasks cannot purchase', async () => {
  const blocked = { B: '訂單結果待查證' };
  const f = fixture(async (product, slot) => ({ status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot }), { blocked });
  try {
    await f.coordinator.enqueue('eslite', [toy('1')]);
    for (let n = 0; n < 5; n++) await tick();
    assert.deepEqual(f.calls.map(([slot]) => slot).sort(), ['A', 'C']);
    assert.equal(f.coordinator.getStatus().queue[0].blockedReason, blocked.B);
    f.coordinator.queue[0].expiresAt = new Date(0).toISOString();
    delete blocked.B; await f.coordinator._schedule(); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 2);
  } finally { await f.coordinator.close(); }
});

test('account reassignment cancels tasks instead of purchasing with a different identity', async () => {
  const f = fixture(async () => { throw new Error('must not purchase'); }, { slots: ['A'] });
  try {
    const enqueued = f.coordinator.enqueue('eslite', [toy('1')]);
    f.adapter.accountIdentity = () => 'new-identity';
    await enqueued;
    await f.coordinator.whenIdle(); assert.equal(f.calls.length, 0);
  } finally { await f.coordinator.close(); }
});

const rawOrder = (id = '1') => ({ order_id: '123', order_number: '20261008123', created_at: '2026/10/08 13:32:16',
  amount: 345, payment: { type: 'pay_atm', status: 'payment_paid', account: 'DO-NOT-STORE' },
  subscriber: { address: 'DO-NOT-STORE' }, sub_orders: [{ status: { order_init: '2026/10/08 13:32:16' },
    sub_order_items: [{ product_guid: id, product_name: 'mock product', quantity: 1, item_type: 'product' },
      { product_guid: 'shipping', quantity: 1, item_type: 'shipping_fee' }] }] });
test('official response decoding and safe summaries discard address and bank account', () => {
  const key = 'RRD6FAz9.KtEba77r.zE6y!A@NMMbrWG';
  const encoded = Buffer.from(JSON.stringify(rawOrder())).toString('base64');
  const message = [...encoded].map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
  const order = summarizeEsliteOrder(decodeEsliteOrderBody({ message }));
  assert.equal(order.items.length, 1); assert.doesNotMatch(JSON.stringify(order), /DO-NOT-STORE/);
  assert.equal(esliteOrderTime(order.createdAt), Date.parse('2026-10-08T05:32:16Z'));
  const criteria = { productId: '1', quantity: 1, startedAt: '2026-10-08T05:32:07Z' };
  assert.equal(matchEsliteSingleProductOrder([order], criteria).orderId, order.orderId);
  assert.equal(matchEsliteSingleProductOrder([order, order], criteria), null);
  assert.equal(matchEsliteSingleProductOrder([order], { ...criteria, quantity: 2 }), null);
  assert.equal(matchEsliteSingleProductOrder([{ ...order, items: [...order.items, { ...order.items[0], id: '2' }] }], criteria), null);
});
test('official history makes only bounded GETs using IDs returned by the official list', async () => {
  const urls = [];
  const api = { async get(url) { urls.push(url); return { ok: () => true, dispose: async () => {}, json: async () =>
    url.includes('member_orders') ? { current_page: 1, total_pages: 1, orders: [{ order_id: '123', order_number: '20261008123', created_at: '2026/10/08 13:32:16' }] } : rawOrder() }; } };
  const result = await readEsliteOrderHistory(api);
  assert.equal(result.complete, true); assert.equal(result.orders.length, 1);
  assert.deepEqual(urls, ['/api/v1/member_orders?page=1&keyword=&start_at=&end_at=', '/api/v2/orders/details/123']);
});

test('ambiguous POST returns immediately with an account guard; no inline history or duplicate POST', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-reconcile-'));
  let runs = 0, queries = 0;
  const adapter = new EslitePurchaseAdapter({ dataDir: dir, apiOnly: true,
    getCredentials: () => ({ account: 'mock', password: 'mock' }), getCheckoutTemplate: () => ({ checkout: {} }),
    apiContextFactory: async () => ({ api: { dispose: async () => {} }, expiresAtMs: Date.now() + 86400000 }),
    apiMaintenanceRunner: async () => ({ ok: true, loggedIn: true, cartEmpty: true }),
    apiPurchaseRunner: async () => { runs++; return { status: 'submitted_unconfirmed', quantity: 1 }; },
    apiOrderReader: async () => { queries++; return { orders: [{ ...summarizeEsliteOrder(rawOrder()), createdAt: new Date().toISOString() }] }; }
  });
  try {
    const result = await adapter.purchase(toy('1'), { quantity: 1, action: 'checkout' });
    assert.equal(result.status, 'submitted_unconfirmed');
    assert.ok(adapter.activePurchaseHold()); assert.equal(runs, 1); assert.equal(queries, 0);
    await assert.rejects(adapter.purchase(toy('2'), { quantity: 1, action: 'checkout' }), error => error.purchaseStatus === 'account_held');
    assert.equal(runs, 1); assert.equal(queries, 0);
  } finally { await adapter.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('official reconciliation updates old unknown record and imports only non-canceled products', async () => {
  const f = fixture(async () => { throw new Error('read-only test must not purchase'); });
  const order = summarizeEsliteOrder(rawOrder());
  const held = { platform: 'eslite', accountSlot: 'B', status: 'submitted_unconfirmed',
    product: toy('1'), startedAt: '2026-10-08T05:32:07Z', quantity: 1 };
  f.state.data.commerce.autoPurchase.records.old = held;
  const adapter = { accountBusy: false, purchaseHold: { productId: '1' },
    _withAccountLock: callback => callback(), _ensureApiContext: async () => ({}),
    _resetApiReadiness() {}, apiOrderReader: async () => ({ orders: [order,
      { ...order, orderId: 'canceled', items: [{ id: '2', canceled: true }] }], complete: true }) };
  f.adapter.adapters = { B: adapter }; f.adapter.busySlots = new Set();
  try {
    const result = await f.coordinator.reconcileEsliteAccount({ accountSlot: 'B' });
    assert.equal(result.resolved, 1); assert.equal(result.purchasedCount, 1);
    assert.equal(held.status, 'ordered'); assert.equal(adapter.purchaseHold, null); assert.equal(f.calls.length, 0);
    assert.equal(f.coordinator.getStatus().recent[0].status, 'ordered');
    assert.ok(f.state.data.commerce.autoPurchase.eslitePurchased['identity-B']['1']);
  } finally { await f.coordinator.close(); }
});
