import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PICKUP_SETUP_REQUIRED, pickupSetupMatches, verifyFunboxPickupOrder, verifyEslitePickupOrder } from '../src/pickup-setup.js';
import { LocalCredentialStore } from '../src/credential-store.js';
import { FunboxPurchaseAdapter, EslitePurchaseAdapter, MultiAccountFunboxPurchaseAdapter, MultiAccountEslitePurchaseAdapter, normalizeAutoPurchaseConfig } from '../src/auto-purchase.js';
import { createDashboard } from '../src/dashboard.js';

const token = 'a'.repeat(32), profile = { storeName: '測試門市' };
const html = payment => `<div class="order_name"><span class="value">BD-20260101</span></div><div class="item"><div class="item_title">付款方式</div><div class="item_content">${payment}</div></div><div class="item"><div class="item_title">配送方式</div><div class="item_content"><span class="store_info">7-11 門市名稱：測試門市</span></div></div>`;
const response = body => ({ ok: () => true, status: () => 200, text: async () => body, json: async () => body, dispose: async () => {} });

test('all default slots prefer ATM; explicit saved choices remain explicit', () => {
  const defaults = normalizeAutoPurchaseConfig({});
  for (const platform of ['funbox', 'eslite']) {
    assert.equal(defaults[platform].payment, 'virtual_atm_home');
    assert.deepEqual(defaults[platform].accountPayments, { A: 'virtual_atm_home', B: 'virtual_atm_home', C: 'virtual_atm_home' });
  }
  assert.equal(normalizeAutoPurchaseConfig({ pickupPolicyVersion: 1, eslite: { accountPayments: { D: 'seven_cod' } } }).pickupPolicyVersion, 1);
});

test('FUNBOX requires an owned official COD receipt matching the store and uses only GET', async () => {
  const calls = [];
  const api = { async get(url) { calls.push(url); return response(calls.length === 1 ? `<a href="/account/orders/${token}">訂單</a>` : html('7-11 貨到付款')); } };
  const setup = await verifyFunboxPickupOrder(api, 'https://shop.funbox.com.tw/orders/' + token, profile);
  assert.equal(setup.orderNumber, 'BD-20260101'); assert.equal(setup.source, 'official_order');
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith('https://shop.funbox.com.tw/account/orders')));
  await assert.rejects(verifyFunboxPickupOrder({ get: async () => response('not this account') }, 'https://shop.funbox.com.tw/orders/' + token, profile), /本帳號/);
  let n = 0;
  await assert.rejects(verifyFunboxPickupOrder({ get: async () => response(++n === 1 ? `<a href="/account/orders/${token}">訂單</a>` : html('虛擬 ATM')) }, 'https://shop.funbox.com.tw/orders/' + token, profile), /未確認/);
  await assert.rejects(verifyFunboxPickupOrder(api, 'https://evil.invalid/orders/' + token, profile), /官方/);
});

test('Eslite order query rejects ATM and unknown enum; COD fixture verifies exact account order', async () => {
  const reference = '202610010001';
  const detail = { order_id: '1', order_number: reference, created_at: '2026/10/01 12:00:00', amount: 350,
    payment: { type: 'pay_cod' }, recipient: { name: '測試收件人', mobile: { country: 886, number: '0912345678' } },
    shipping: { store_type: 'seven', store_id: '123456', store_name: '測試門市', store_address: '測試路1號', city: '桃園市', district: '中壢區', zip: '320' },
    sub_orders: [{ status: { order_init: '2026/10/01 12:00:00' }, sub_order_items: [{ item_type: 'product', product_guid: '1', quantity: 1 }] }] };
  const calls = [];
  const api = { async get(url) { calls.push(url); return response(url.includes('member_orders') ? { current_page: 1, total_pages: 1, orders: [{ order_id: '1', order_number: reference }] } : detail); } };
  assert.equal((await verifyEslitePickupOrder(api, reference, profile)).storeId, '123456');
  assert.equal(calls.length, 2);
  for (const type of ['pay_atm', 'unverified_new_enum']) { detail.payment.type = type; await assert.rejects(verifyEslitePickupOrder(api, reference, profile), /不能解鎖/); }
  detail.payment.type='pay_711'; detail.shipping.type='ship_711';
  assert.equal((await verifyEslitePickupOrder(api,reference,profile)).storeId,'123456');
  detail.shipping.city='';detail.shipping.district='';detail.shipping.zip='';
  assert.equal((await verifyEslitePickupOrder(api,reference,profile)).recipient.city,'');
  detail.shipping.type='ship_home';
  await assert.rejects(verifyEslitePickupOrder(api,reference,profile),/不能解鎖/);
});

test('pickup proof is encrypted, scoped to platform/account/store, and save failure never unlocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickup-proof-'));
  try {
    const store = await new LocalCredentialStore(dir).load();
    await store.setFunboxAccount('A', { account: 'a@example.test', password: 'private' });
    await store.setFunboxAccount('B', { account: 'b@example.test', password: 'private' });
    await store.setPickupProfile({ fullName: '測試', phone: '0912345678', storeName: '測試門市' });
    const setup = { source: 'official_order', verifiedAt: new Date().toISOString(), orderNumber: 'BD-20260101', storeName: '測試門市' };
    await store.setPickupSetup('funbox', 'A', setup, 'a@example.test');
    assert.ok(store.getPickupSetup('funbox', 'A')); assert.equal(store.getPickupSetup('funbox', 'B'), null);
    assert.equal(store.getPickupSetup('eslite', 'A'), null);
    const encoded = await fs.readFile(store.dataFile, 'utf8'); assert.equal(encoded.includes('BD-20260101'), false);
    assert.ok((await new LocalCredentialStore(dir).load()).getPickupSetup('funbox', 'A'));
    await store.setFunboxAccount('A', { account: 'changed@example.test', password: 'private' });
    assert.equal(store.getPickupSetup('funbox', 'A'), null);
    store._save = async () => { throw new Error('disk unavailable'); };
    await assert.rejects(store.setPickupSetup('funbox', 'A', setup, 'changed@example.test'), /disk/);
    assert.equal(store.getPickupSetup('funbox', 'A'), null);
    assert.equal(pickupSetupMatches(setup, { storeName: '不同門市' }), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('both purchase adapters stop unconfigured COD before any browser/cart/order request', async () => {
  const funbox = new FunboxPurchaseAdapter({ dataDir: '/unused', getPickupSetup: () => null });
  await assert.rejects(funbox.purchase({ id: '1' }, { payment: 'seven_cod', action: 'checkout' }), error => error.purchaseStatus === 'needs_setup' && error.message === PICKUP_SETUP_REQUIRED);
  const eslite = new EslitePurchaseAdapter({ dataDir: '/unused', apiOnly: true, getPickupSetup: () => null });
  await assert.rejects(eslite.purchase({ id: '1' }, { payment: 'seven_cod', action: 'checkout' }), error => error.purchaseStatus === 'needs_setup');
});

test('queue guards enforce COD proof independently by account; ATM is unaffected', () => {
  const accounts = [{ slot: 'A', account: 'a', password: 'p', enabled: true }, { slot: 'B', account: 'b', password: 'p', enabled: true }];
  for (const Adapter of [MultiAccountFunboxPurchaseAdapter, MultiAccountEslitePurchaseAdapter]) {
    const multi = new Adapter({ dataDir: '/unused', getAccounts: () => accounts, getPickupSetup: slot => slot === 'B' ? { verifiedAt: 'now' } : null,
      getCheckoutTemplate: () => ({ checkout: {} }) });
    if (Adapter === MultiAccountFunboxPurchaseAdapter) assert.equal(multi.queueBlockReason('A', { payment: 'seven_cod' }), PICKUP_SETUP_REQUIRED);
    else assert.match(multi.queueBlockReason('A', { payment: 'seven_cod' }), /共用 ATM 宅配資料不完整/);
    assert.equal(multi.queueBlockReason('A', { payment: 'virtual_atm_home' }), '');
    assert.equal(multi.queueBlockReason('B', { payment: 'seven_cod' }), '');
  }
});

test('dashboard exposes a read-only verification handler, not a setup purchase button', async () => {
  const calls = [];
  const server = createDashboard({ getStatus: () => ({}), onVerifyPickupSetup: async body => { calls.push(body); return { message: 'verified' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const pageHtml = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.ok(pageHtml.includes('核對門市訂單')); assert.ok(pageHtml.includes('預設宅配 ATM'));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auto-purchase/pickup-setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'funbox', accountSlot: 'A', orderReference: 'official-link' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).message, 'verified'); assert.equal(calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
