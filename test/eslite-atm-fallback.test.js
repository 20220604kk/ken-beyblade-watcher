import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareEsliteAccountViaApi, resolveEsliteCheckoutSelection } from '../src/eslite-account-setup.js';
import { EslitePurchaseAdapter, MultiAccountEslitePurchaseAdapter, purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { LocalCredentialStore } from '../src/credential-store.js';

const delivery = { fullName: '共用收件人', phone: '0912345678', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試路1號' };
const member = { id: 1, name: '本帳號會員', account: '0912345678', phone_number: '0912345678', country: '1' };
const saved = { paymentMode: 'virtual_atm_home', checkout: { payment: '3', delivery: '2', discount_point: 250,
  subscriber: { country: 'TW', name: member.name, mobile: { number: member.phone_number } }, recipient: { name: '過期地址' } } };
const response = (body, status = 200) => ({ status: () => status, ok: () => status === 200, json: async () => body, dispose: async () => {} });
function apiFixture(status = 200) {
  const calls = [];
  return { calls, get: async url => { calls.push(url); return response(url.includes('member_detail') ? member : url.includes('address_books') ? [] : { cart: { cart_items: [] } }, status); },
    post: () => assert.fail('準備不應送單'), delete: () => assert.fail('準備不应清車') };
}

test('首次選取 COD 但無門市：GET-only 身分核對後建立共用 ATM 備援', async () => {
  const api = apiFixture();
  const result = await prepareEsliteAccountViaApi({ api, expectedAccount: member.account, payment: 'seven_cod', deliveryProfile: delivery });
  assert.equal(result.checkoutTemplate.paymentMode, 'virtual_atm_home');
  assert.equal(result.checkoutTemplate.requestedPayment, 'seven_cod');
  assert.equal(result.checkoutTemplate.checkout.subscriber.name, member.name);
  assert.equal(result.checkoutTemplate.checkout.recipient.name, delivery.fullName);
  assert.equal(result.checkoutTemplate.checkout.recipient.store.id, '');
  assert.equal(result.checkoutTemplate.checkout.discount_point, 0);
  assert.equal(api.calls.length, 3);
});

test('沒有共用地址、會員不符、API 403 不得以備援掩蓋錯誤', async () => {
  await assert.rejects(prepareEsliteAccountViaApi({ api: apiFixture(), expectedAccount: member.account, payment: 'seven_cod' }), /宅配資料|宅配地址/);
  await assert.rejects(prepareEsliteAccountViaApi({ api: apiFixture(), expectedAccount: '0988888888', payment: 'seven_cod', deliveryProfile: delivery }), e => e.purchaseStatus === 'needs_login');
  await assert.rejects(prepareEsliteAccountViaApi({ api: apiFixture(403), expectedAccount: member.account, payment: 'seven_cod', deliveryProfile: delivery }), e => e.purchaseStatus === 'unknown');
});

test('有可用 COD 範本時不切換；ATM 備援使用最新共用地址且不變更原範本', () => {
  const cod = { paymentMode: 'seven_cod', checkout: { payment: '8' } };
  assert.equal(resolveEsliteCheckoutSelection({ template: cod, payment: 'seven_cod' }).payment, 'seven_cod');
  const before = JSON.stringify(saved);
  const selection = resolveEsliteCheckoutSelection({ template: saved, payment: 'seven_cod', deliveryProfile: delivery, pickupUnavailable: true });
  assert.equal(selection.payment, 'virtual_atm_home');
  assert.equal(selection.checkoutTemplate.checkout.recipient.address, delivery.address);
  assert.equal(JSON.stringify(saved), before);
  const incomplete = { ...saved, paymentMode: 'seven_cod', checkout: { ...saved.checkout, recipient: { type: '5', store: {} } } };
  assert.equal(resolveEsliteCheckoutSelection({ template: incomplete, payment: 'seven_cod', deliveryProfile: delivery }).payment, 'virtual_atm_home');
});

test('備援穿過派單／正式 adapter；結果不明仍然保護帳號，不重送', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-atm-fallback-'));
  const attempts = [];
  const adapter = new EslitePurchaseAdapter({ dataDir: directory, apiOnly: true,
    getCredentials: () => ({ account: member.account, password: 'test' }), getCheckoutTemplate: () => saved,
    getPickupSetup: () => null, getSelectedPayment: () => 'seven_cod', getDeliveryProfile: () => delivery,
    apiContextFactory: async () => ({ api: { dispose: async () => {} }, expiresAtMs: Date.now() + 3600000 }),
    apiPurchaseRunner: async options => { attempts.push(options); return { status: attempts.length === 1 ? 'ordered' : 'submitted_unconfirmed', orderId: attempts.length === 1 ? 'MOCK-001' : undefined }; },
    apiOrderReader: async () => ({ orders: [] }) });
  try {
    await adapter.localSessionLoad;
    adapter._apiReady = () => true;
    const multi = new MultiAccountEslitePurchaseAdapter({ dataDir: directory,
      getAccounts: () => [{ slot: 'C', account: member.account, password: 'test', enabled: true }] });
    multi._syncAccounts = () => {}; multi.adapters = { C: adapter };
    assert.equal(multi.queueBlockReason('C', { accountPayments: { C: 'seven_cod' } }), '');
    const result = await multi.purchase({ id: 'one' }, { accountSlot: 'C', accountPayments: { C: 'seven_cod' } });
    assert.equal(result.payment, 'virtual_atm_home'); assert.equal(result.requestedPayment, 'seven_cod');
    assert.equal(attempts[0].settings.payment, 'virtual_atm_home');
    assert.equal(attempts[0].checkoutTemplate.checkout.discount_point, 0);
    assert.equal(adapter.runtimeStatus().paymentFallbackReady, true);
    const unknown = await adapter.purchase({ id: 'two' }, { payment: 'seven_cod' });
    assert.equal(unknown.status, 'submitted_unconfirmed');
    await assert.rejects(adapter.purchase({ id: 'three' }, { payment: 'seven_cod' }), e => e.purchaseStatus === 'account_held');
    assert.equal(attempts.length, 2);
  } finally { await adapter.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('備援範本的實際與要求付款方式加密保存，重新載入不誤認 COD 已設定', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-atm-save-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    const result = resolveEsliteCheckoutSelection({ template: saved, payment: 'seven_cod', deliveryProfile: delivery });
    await store.setEsliteCheckoutTemplate('C', result.checkoutTemplate, { paymentMode: result.payment });
    const reload = await new LocalCredentialStore(directory).load();
    const value = reload.getEsliteCheckoutTemplate('C');
    assert.equal(value.paymentMode, 'virtual_atm_home'); assert.equal(value.requestedPayment, 'seven_cod');
    assert.equal(value.paymentFallback.to, 'virtual_atm_home');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('備援走完整 API 購買流程：只加一件、紅利歸零、單次 ATM 送單及第 07 步切換紀錄', async () => {
  let carted = false;
  const posts = [], steps = [];
  const selection = resolveEsliteCheckoutSelection({ template: saved, payment: 'seven_cod', deliveryProfile: delivery });
  const api = { get: async () => response({ cart: { cart_items: carted ? [{ product_guid: 'one', qty: 1 }] : [] } }),
    post: async (url, options) => { posts.push({ url, data: options.data }); if (url.includes('/cart/items')) { carted = true; return response({ product_guid: 'one', response_quantity: 1 }); }
      return response({ order_id: 'MOCK-ATM-001' }); } };
  const result = await purchaseEsliteViaApi({ apiContext: api, prevalidated: true, product: { id: 'one', stock: 1 },
    settings: { action: 'checkout', payment: selection.payment, paymentFallback: selection.paymentFallback, quantity: 1, strictSingleProductOrder: true },
    checkoutTemplate: selection.checkoutTemplate, onStep: step => steps.push(step) });
  assert.equal(result.status, 'ordered');
  const submissions = posts.filter(p => p.url.includes('/orders/checkout'));
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].data.checkout.payment, '3'); assert.equal(submissions[0].data.checkout.delivery, '2');
  assert.equal(submissions[0].data.checkout.discount_point, 0);
  assert.equal(submissions[0].data.checkout.recipient.address, delivery.address);
  assert.ok(steps.some(step => step.stepNumber === 7 && /備援|改為宅配 ATM/.test(step.reason)));
  assert.equal(steps[0].stepNumber, 1);
});
