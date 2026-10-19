import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { fillEsliteBatchCart } from '../src/eslite-batch-cart.js';

const response = (body, status = 200) => ({ ok: () => status >= 200 && status < 300, status: () => status,
  json: async () => body, dispose: async () => {} });
const product = { id: 'mock-one', stock: 1 };
const args = { product, prevalidated: true, deadlineMs: 30000, checkoutTemplate: { checkout: { discount_point: 150 } },
  settings: { action: 'checkout' } };

for (const timeout of [false, true]) test(`期限前送單有獨立 15 秒回應窗口（timeout=${timeout}），只送一次`, async () => {
  let clock = 0, posts = 0, budget;
  const result = await purchaseEsliteViaApi({ ...args, now: () => clock, apiContext: {
    async get() { clock = 26600; return response({ cart: { cart_items: [{ product_guid: product.id, qty: 1 }] } }); },
    async post(url, options) {
      if (url.includes('/cart/items')) return response({ product_guid: product.id, response_quantity: 1 });
      posts++; budget = options.timeout; assert.equal(options.data.checkout.discount_point, 0);
      clock += timeout ? budget : 12000;
      if (timeout) throw Error('mock timeout');
      return response({ order_number: 'MOCK-ONLY' });
    }
  } });
  assert.equal(posts, 1); assert.equal(budget, 15000);
  assert.equal(result.status, timeout ? 'submitted_unconfirmed' : 'ordered');
  assert.equal(result.timings.dispatchDeadlineMet, true);
  assert.equal(result.timings.deadlineMet, false); // Observation is allowed beyond dispatch cutoff.
});

test('保存意圖期間超過截止：根本未送單，不假稱結果不明', async () => {
  let clock = 0, submits = 0;
  await assert.rejects(purchaseEsliteViaApi({ ...args, now: () => clock,
    settings: { action: 'checkout', onBeforeSubmit: async () => { clock = 30001; } }, apiContext: {
      async get() { return response({ cart: { cart_items: [{ product_guid: product.id, qty: 1 }] } }); },
      async post(url) { if (url.includes('checkout')) submits++; return response({ product_guid: product.id, response_quantity: 1 }); }
    } }), error => error.purchaseStatus === 'deadline_exceeded');
  assert.equal(submits, 0);
});

test('獨立回應窗口不授權截止後重送明確忙碌的單', async () => {
  let clock = 0, submits = 0;
  await assert.rejects(purchaseEsliteViaApi({ ...args, now: () => clock, apiContext: {
    async get() { clock = 29900; return response({ cart: { cart_items: [{ product_guid: product.id, qty: 1 }] } }); },
    async post(url) {
      if (url.includes('/cart/items')) return response({ product_guid: product.id, response_quantity: 1 });
      submits++; clock = 31000; return response({ success: false, error: '系統忙碌' }, 422);
    }
  } }), error => error.purchaseStatus === 'checkout_busy');
  assert.equal(submits, 1);
});

async function batchReads({ lastRejected = false, mixed = false } = {}) {
  const products = [{ id: '1', quantity: 1 }, { id: '2', quantity: 1 }], cart = [];
  let reads = 0, adds = 0;
  const run = () => fillEsliteBatchCart({ products, settings: { batchAllowPartial: true }, now: () => 0,
    timeoutForStep: x => x, checkpoint() {}, readCart: async () => {
      reads++; return mixed ? [...cart, { product_guid: 'other', qty: 1 }] : [...cart];
    }, api: { async post(_url, { data }) {
      adds++;
      if (lastRejected && data.product_guid === '2') return response({ error: '已售罄' }, 409);
      cart.push({ product_guid: data.product_guid, qty: data.qty });
      if (data.product_guid === (lastRejected ? '1' : '2')) throw Error('mock response lost after commit');
      return response({ product_guid: data.product_guid, response_quantity: data.qty });
    } }
  });
  return { run, count: () => ({ reads, adds }) };
}

test('最後一款加車補查已證實整車，不再重複 GET 封箱', async () => {
  const f = await batchReads(); assert.equal((await f.run()).products.length, 2);
  assert.deepEqual(f.count(), { reads: 1, adds: 2 });
});
test('補查後仍有下一次加車請求，即使被拒絕也必須重新封箱核對', async () => {
  const f = await batchReads({ lastRejected: true }); assert.equal((await f.run()).products.length, 1);
  assert.deepEqual(f.count(), { reads: 2, adds: 2 });
});
test('重用整車收據仍拒絕混入殘留商品', async () => {
  const f = await batchReads({ mixed: true }); await assert.rejects(f.run(), /不符/);
});
