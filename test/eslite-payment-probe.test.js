import test from 'node:test';
import assert from 'node:assert/strict';
import { probeEslitePaymentChoices, cleanupEslitePaymentProbe } from '../src/eslite-payment-probe.js';

const id = '10000000000000000001', member = { id: 1, name: '測試會員', account: 'test@example.invalid' };
const response = (body, status = 200) => ({ ok: () => status === 200, status: () => status, json: async () => body, dispose: async () => {} });
function fixture({ original = [], uncertain = false, changedQty = false, failDelete = false } = {}) {
  let cart = [...original], postCount = 0, deleteCount = 0;
  const api = { get: async url => {
    if (url === '/api/v2/member_detail') return response(member);
    if (url.includes('/purchase_status')) return response({ product_guid: id, product_button_status: 'add_to_shopping_cart', stock: 50 });
    if (url === '/api/v1/cart/payments_deliveries') return response({ shipping_fee: { '2': { main_island_fee: 50, payment_codes: ['fixture-atm', 'fixture-linepay'], private: 'not-exported' } }, unknownPrivate: 'secret' });
    assert.ok(url.startsWith('/api/v2/cart/items')); return response({ cart: { cart_items: cart, total_amount: 100 } });
  }, post: async (url, options) => {
    assert.equal(url, '/api/v2/cart/items', '禁止送單或付款端點'); assert.equal(options.data.qty, 1); postCount++;
    cart.push({ product_guid: id, qty: changedQty ? 2 : 1, cart_item_id: 'fixture-item' });
    if (uncertain) throw new Error('timeout'); return response({ product_guid: id, response_quantity: 1 });
  }, delete: async (url, options) => {
    assert.equal(url, '/api/v2/cart/items'); assert.equal(options.data.cart_item_id, 'fixture-item'); deleteCount++;
    if (failDelete) return response({}, 503); cart = cart.filter(item => item.cart_item_id !== options.data.cart_item_id); return response({});
  } };
  return { api, run: () => probeEslitePaymentChoices({ api, productId: id, expectedAccount: member.account }),
    state: () => ({ postCount, deleteCount, cart }) };
}

test('只加一件、讀付款選項、只移除測試商品，零送單零付款', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'choices_captured'); assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(f.state(), { postCount: 1, deleteCount: 1, cart: [] });
  assert.equal(result.orderSubmissions, 0); assert.equal(result.paymentSubmissions, 0);
  assert.doesNotMatch(JSON.stringify(result), /test@example|測試會員|unknownPrivate|not-exported/);
});
test('原車有商品，不清車、不加車、不刪除原有商品', async () => {
  const original = [{ product_guid: 'another', qty: 1, cart_item_id: 'original' }], f = fixture({ original });
  assert.equal((await f.run()).status, 'skipped_existing_cart'); assert.deepEqual(f.state(), { postCount: 0, deleteCount: 0, cart: original });
});
test('加車逾時，只查車與清理，絕不重加或送單', async () => {
  const f = fixture({ uncertain: true }), result = await f.run();
  assert.equal(result.status, 'probe_incomplete'); assert.equal(result.cleanupConfirmed, true);
  assert.equal(f.state().postCount, 1); assert.equal(f.state().deleteCount, 1);
});
test('數量被變更或清理未確認時，保留警告，不擅自清空購物車', async () => {
  for (const options of [{ changedQty: true }, { failDelete: true }]) {
    const f = fixture(options), result = await f.run(); assert.equal(result.cleanupConfirmed, false); assert.equal(f.state().cart.length, 1);
  }
});
test('會員不符不加車，非法商品識別拒絕', async () => {
  const f = fixture();
  const result = await probeEslitePaymentChoices({ api: f.api, productId: id, expectedAccount: 'wrong@example.invalid' });
  assert.equal(result.status, 'probe_incomplete'); assert.equal(f.state().postCount, 0);
  await assert.rejects(probeEslitePaymentChoices({ api: f.api, productId: '../orders/checkout' }));
});

test('官方重新建立 cart_item_id，仍可核對唯一同款一件並移除；不再加車', async () => {
  const f = fixture({ original: [{ product_guid: id, qty: 1, cart_item_id: 'fixture-item' }] });
  const result = await cleanupEslitePaymentProbe({ api: f.api, expectedAccount: member.account,
    hold: { scope: 'cart_probe', productId: id, cartItemId: 'older-id' } });
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.remainingOtherItems, 0);
  assert.equal(f.state().postCount, 0); assert.equal(f.state().deleteCount, 1);
});
