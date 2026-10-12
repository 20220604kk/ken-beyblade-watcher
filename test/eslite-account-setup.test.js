import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEsliteAccountTemplate, prepareEsliteAccountViaApi, esliteMemberMatchesAccount } from '../src/eslite-account-setup.js';
import { LocalCredentialStore } from '../src/credential-store.js';
import { EslitePurchaseAdapter } from '../src/auto-purchase.js';
import { esliteAccountReadiness } from '../src/eslite-purchase-ui.js';

const member = { id: 1, uuid: 'member-1', account: '0912345678', name: '測試會員', phone_number: '0912345678',
  phone_country_code: '886', address: '', zipcode: '', country: '1' };
const delivery = { fullName: '指定收件人', phone: '0999999999', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試路1號' };
const template = extra => buildEsliteAccountTemplate({ member, addresses: [], payment: 'virtual_atm_home', deliveryProfile: delivery, ...extra });
function apiFixture(bodies) {
  const calls = [];
  return { calls, async get(url) {
    calls.push(url);
    const body = bodies[url];
    const status = body?.httpStatus || 200;
    return { status: () => status, ok: () => status === 200, json: async () => structuredClone(body), dispose: async () => {} };
  }, post: () => { throw new Error('unexpected POST'); }, delete: () => { throw new Error('unexpected DELETE'); } };
}
const bodies = () => ({ '/api/v2/member_detail': member, '/api/v2/member_address_books': [],
  '/api/v2/cart/items?type=shopping&step=1': { cart: { cart_items: [] } } });

test('official member country 1 and blank subscriber address match captured contract; recipient stays complete', () => {
  const result = template();
  assert.equal(result.checkout.subscriber.name, member.name);
  assert.equal(result.checkout.subscriber.address, '');
  assert.equal(result.checkout.subscriber.country, 'TW');
  assert.equal(result.checkout.recipient.name, delivery.fullName);
  assert.equal(result.checkout.recipient.address, delivery.address);
  assert.equal(result.checkout.payment, '3');
  assert.equal(result.checkout.delivery, '2');
});

test('identifies mobile aliases without mixing identities', () => {
  assert.equal(esliteMemberMatchesAccount(member, '+886912345678'), true);
  assert.equal(esliteMemberMatchesAccount(member, '0988888888'), false);
  assert.equal(esliteMemberMatchesAccount(member, ''), false);
});

test('GET-only setup verifies identity, saves name and prepares template with no cart mutations', async () => {
  const api = apiFixture(bodies());
  let identified;
  const result = await prepareEsliteAccountViaApi({ api, expectedAccount: member.account,
    payment: 'virtual_atm_home', deliveryProfile: delivery, onMember: value => { identified = value; } });
  assert.equal(result.cartEmpty, true);
  assert.deepEqual(identified, { id: '1', uuid: 'member-1', name: member.name });
  assert.deepEqual(api.calls, ['/api/v2/member_detail', '/api/v2/member_address_books', '/api/v2/cart/items?type=shopping&step=1']);
});

test('foreign session fails closed before persisting name or reading cart', async () => {
  const api = apiFixture(bodies());
  await assert.rejects(prepareEsliteAccountViaApi({ api, expectedAccount: '0988888888', onMember: () => assert.fail() }),
    error => error.purchaseStatus === 'needs_login');
  assert.equal(api.calls.length, 1);
});

test('official timeout/403 do not get mislabeled as expired authentication', async () => {
  const api = apiFixture({ '/api/v2/member_detail': { httpStatus: 403 } });
  await assert.rejects(prepareEsliteAccountViaApi({ api, expectedAccount: member.account }), error => error.purchaseStatus === 'unknown');
  await assert.rejects(prepareEsliteAccountViaApi({ api: { get: async () => { throw new Error('authorization: PRIVATE-TOKEN; Timeout'); } }, expectedAccount: member.account }),
    error => error.purchaseStatus === 'unknown' && !/PRIVATE-TOKEN|authorization/.test(error.message));
});

test('name identification survives unavailable shipping fields; incomplete or ambiguous data is not fabricated', async () => {
  let identified = false;
  await assert.rejects(prepareEsliteAccountViaApi({ api: apiFixture(bodies()), expectedAccount: member.account,
    payment: 'virtual_atm_home', onMember: () => { identified = true; } }), /宅配地址/);
  assert.equal(identified, true);
  assert.throws(() => template({ deliveryProfile: {}, addresses: [{ delivery_type: '2' }, { delivery_type: '2' }] }), /宅配地址/);
  assert.throws(() => template({ member: { ...member, address: '不完整地址', zipcode: '320' } }), /會員地址/);
});

test('existing cart is reported, never emptied', async () => {
  const data = bodies(); data['/api/v2/cart/items?type=shopping&step=1'].cart.cart_items.push({ id: 1 });
  const api = apiFixture(data);
  const result = await prepareEsliteAccountViaApi({ api, expectedAccount: member.account, payment: 'virtual_atm_home', deliveryProfile: delivery });
  assert.equal(result.cartEmpty, false);
});

test('7-11 can reuse only this account captured store; preserve invoice preferences', () => {
  const old = { paymentMode: 'seven_cod', checkout: { subscriber: {}, recipient: { type: '5', country: 'TW', name: '原取貨人',
    mobile: { country: 886, number: '0912345678' }, store: { id: 'TEST', name: '測試門市', address: '測試地址' } }, invoice: { type: 'invoice_cellphone_barcode', cellphone_barcode: '/TEST123' } } };
  const result = template({ payment: 'seven_cod', existingTemplate: old, pickupProfile: { fullName: '設定取貨人', phone: '0999999999', storeName: '測試門市' } });
  assert.equal(result.checkout.recipient.name, '設定取貨人');
  assert.equal(result.checkout.invoice.cellphone_barcode, '/TEST123');
  assert.equal(result.checkout.payment, '8');
  assert.throws(() => template({ payment: 'seven_cod', existingTemplate: old, pickupProfile: { storeName: '其他門市' } }), /無法唯一辨識/);
  assert.throws(() => template({ payment: 'seven_cod' }), /無法唯一辨識/);
});

test('readiness labels distinguish sleep, preparation, held order and ready API', () => {
  const ready = { ready: true };
  assert.equal(esliteAccountReadiness({}, ready, { checkoutTemplateReady: true }).text, '休眠／待檢查');
  assert.equal(esliteAccountReadiness({}, ready, { checkoutTemplateReady: true, accountPreparationState: 'ready' }).text, '休眠／資料已備妥');
  assert.equal(esliteAccountReadiness({}, ready, { heartbeatEnabled: true, apiReady: true }).text, 'API 就緒');
  assert.equal(esliteAccountReadiness({}, ready, { accountPreparationState: 'running' }).text, '自動辨識中');
  assert.equal(esliteAccountReadiness({}, ready, { purchaseHold: {}, accountPreparationState: 'running' }).text, '訂單待核對');
});

test('parallel account persistence remains encrypted; stale account result is rejected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-setup-test-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await Promise.all(['A', 'B', 'C'].map(slot => store.setEsliteAccount(slot, { account: `user-${slot}`, password: 'test-password', enabled: true })));
    await Promise.all(['A', 'B', 'C'].map(slot => store.setEsliteMemberProfile(slot, { id: slot, name: `測試${slot}` }, { expectedCredentials: { account: `user-${slot}`, password: 'test-password' } })));
    const reloaded = await new LocalCredentialStore(directory).load();
    assert.deepEqual(reloaded.getEsliteMemberNames(), { A: '測*A', B: '測*B', C: '測*C' });
    const raw = await fs.readFile(path.join(directory, 'private-purchase/credentials.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /user-|test-password|測試/);
    await store.setEsliteAccount('B', { account: 'changed', password: 'changed-password' });
    await assert.rejects(store.setEsliteCheckoutTemplate('B', template(), { expectedCredentials: { account: 'user-B', password: 'test-password' } }), /帳密已更新/);
    assert.equal(store.getEsliteMemberNames().B, '');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('preparation requests serialize per account and use latest requested payment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-preparation-test-'));
  const adapter = new EslitePurchaseAdapter({ dataDir: directory });
  try {
    const payments = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    adapter.prepareAccount = async ({ payment }) => { payments.push(payment); await gate; };
    const first = adapter.scheduleAccountPreparation({ payment: 'seven_cod' });
    await Promise.resolve();
    const second = adapter.scheduleAccountPreparation({ payment: 'virtual_atm_home' });
    assert.equal(first, second);
    release(); await first;
    assert.deepEqual(payments, ['seven_cod', 'virtual_atm_home']);
  } finally { await adapter.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
