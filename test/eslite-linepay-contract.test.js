import test from 'node:test';
import assert from 'node:assert/strict';
import { esliteLinePayFallbackTemplate } from '../src/eslite-account-setup.js';
import { verifyEsliteBatchQuote } from '../src/eslite-batch-cart.js';
import { purchaseEsliteViaApi } from '../src/auto-purchase.js';

const profile = { fullName: '共用收件人', phone: '0900000000', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試地址' };
const template = { paymentMode: 'virtual_atm_home', checkout: { payment: '3', delivery: '2', discount_point: 150,
  subscriber: { name: '本帳號會員', country: 'TW', mobile: { number: '0900000000' } } } };
const choices = { shipping_fee: { '2': { main_island_fee: 50, payment_codes: ['19'] } }, payment_prompt_texts: [{ payment_type_id: 19, payment_type: 'pay_line' }] };
const response = (body, status = 200) => ({ ok: () => status === 200, status: () => status, json: async () => body, dispose: async () => {} });

test('官方已觀測的 LINE Pay payload：配送2、付款19、紅利0、cardholder一次性prime', () => {
  const before = structuredClone(template);
  const result = esliteLinePayFallbackTemplate(template, profile, '19', { status: 0, prime: 'MOCK-ONCE-ONLY' });
  assert.equal(result.checkout.payment, '19'); assert.equal(result.checkout.delivery, '2'); assert.equal(result.checkout.discount_point, 0);
  assert.deepEqual(result.checkout.cardholder, { prime: 'MOCK-ONCE-ONLY', name: '', remember: false });
  assert.equal(result.checkout.subscriber.name, '本帳號會員'); assert.equal(result.checkout.recipient.name, profile.fullName);
  assert.deepEqual(template, before);
  for (const prime of [null, { status: 1, prime: 'bad' }, { status: 0, prime: '' }]) assert.throws(() => esliteLinePayFallbackTemplate(template, profile, '19', prime), /一次性/);
});

test('LINE Pay 無prime來源不送單；超額或收件資訊缺少前不取得prime', async () => {
  let calls = 0;
  const run = options => verifyEsliteBatchQuote({ api: { get: async url => response(url.includes('payments_deliveries') ? choices : { cart: { total_amount: 100 } }) },
    checkout: template.checkout, requestedPayment: 'virtual_atm_home', deliveryProfile: profile, maxTotal: 200, timeoutForStep: () => 5000, ...options });
  await assert.rejects(run({}), /一次性付款憑證/);
  const provider = async () => { calls++; return { status: 0, prime: 'MOCK' }; };
  await assert.rejects(run({ maxTotal: 120, linePayPrimeProvider: provider }), /超額/);
  await assert.rejects(run({ deliveryProfile: {}, linePayPrimeProvider: provider }), /宅配資料/);
  assert.equal(calls, 0);
  const result = await run({ linePayPrimeProvider: provider });
  assert.equal(result.payment, 'line_pay_home'); assert.equal(result.total, 150); assert.equal(calls, 1);
});

for (const mode of ['accepted', 'busy', 'timeout']) test('LINE Pay 合單 mock runner：一次prime、一次送單，不沿用prime重送 ' + mode, async () => {
  const items = [], submitted = [], steps = []; let primes = 0;
  const api = { get: async url => response(url.includes('payments_deliveries') ? choices : { cart: { total_amount: 100, cart_items: items } }),
    post: async (url, options) => {
      if (url === '/api/v2/cart/items') { items.push({ product_guid: options.data.product_guid, qty: 1 }); return response({ product_guid: options.data.product_guid, response_quantity: 1 }); }
      assert.equal(url, '/api/v1/orders/checkout'); submitted.push(options.data.checkout);
      if (mode === 'busy') return response({ success: false, error: '系統忙碌' }, 422);
      if (mode === 'timeout') throw Error('timeout');
      return response({ order_number: 'MOCK-LINEPAY' });
    } };
  const run = () => purchaseEsliteViaApi({ apiContext: api, prevalidated: true, product: { id: 'one' }, checkoutTemplate: template,
    settings: { action: 'checkout', payment: 'virtual_atm_home', batchProducts: [{ id: 'one', quantity: 1 }], maxTotal: 200,
      batchAllowPartial: true, deliveryProfile: profile, linePayPrimeProvider: async () => { primes++; return { status: 0, prime: 'MOCK-ONCE' }; } },
    onStep: step => steps.push(step) });
  if (mode === 'busy') await assert.rejects(run(), error => error.purchaseStatus === 'checkout_busy');
  else { const result = await run(); assert.equal(result.status, mode === 'accepted' ? 'ordered' : 'submitted_unconfirmed'); assert.equal(result.payment, 'line_pay_home'); }
  assert.equal(primes, 1); assert.equal(submitted.length, 1); assert.equal(submitted[0].discount_point, 0);
  assert.doesNotMatch(JSON.stringify(steps), /MOCK-ONCE/);
});
