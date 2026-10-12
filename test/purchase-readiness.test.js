import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { once } from 'node:events';
import { PurchaseReadinessCheck, purchaseReadinessRowsHtml, purchaseReadinessClient } from '../src/purchase-readiness.js';
import { createDashboard, validateDashboardClientScript } from '../src/dashboard.js';

const account = slot => ({ slot, account: 'test-' + slot, password: 'fixture', enabled: true });
const profile = { fullName: '隔離測試', phone: '0900000000', city: '桃園市', district: '中壢區', postalCode: '320', address: '測試地址' };
const store = { getEsliteAccounts: () => [account('A'), account('B'), account('C')], getFunboxAccounts: () => [account('A')],
  getEsliteCheckoutTemplate: () => ({ paymentMode: 'virtual_atm_home', checkout: { subscriber: { name: '隔離測試', country: 'TW', mobile: { number: profile.phone } } } }),
  getDeliveryProfile: () => profile, getPickupSetup: () => null };

test('逐帳號 GET-only 登入核對，401 與暫時受限分開；不匯出帳密或宣告付款驗證', async () => {
  let count = 0;
  const checker = new PurchaseReadinessCheck({ dataDir: 'fixture', credentialStore: store, getConfig: () => ({ eslite: {} }),
    verifyEslite: async (_path, opts) => { assert.equal(opts.timeoutMs, 4000); assert.ok(opts.expectedAccount); count++;
      return count === 1 ? { ok: true, loggedIn: true, status: 200 } : count === 2 ? { ok: false, loggedIn: false, status: 401 } : { ok: false, loggedIn: null, status: 429 }; } });
  const result = await checker.check('eslite');
  assert.deepEqual(result.checks.map(row => row.session), ['valid', 'needs_login', 'unknown']);
  assert.equal(count, 3); assert.ok(result.checks.every(row => row.quoteVerified === false));
  assert.doesNotMatch(JSON.stringify(result), /test-A|fixture|0900000000|password|authorization/);
  assert.match(result.message, /未清車、未加車、未送單/);
});

test('FUNBOX 使用保存會話只 GET 會員頁，不提交登入、加車或付款', async () => {
  const calls = [];
  const checker = new PurchaseReadinessCheck({ dataDir: 'fixture', credentialStore: store, getConfig: () => ({ funbox: {} }),
    requestFactory: { newContext: async opts => { assert.match(opts.storageState, /funbox-session/); return {
      get: async url => { calls.push(url); return { status: () => 200, ok: () => true, url: () => url, text: async () => '<a href="/account/logout">登出</a>', dispose: async () => {} }; },
      post: () => assert.fail('不得 POST'), delete: () => assert.fail('不得清車'), dispose: async () => {} }; } } });
  const result = await checker.check('funbox'); assert.equal(result.checks[0].session, 'valid'); assert.equal(calls.length, 1);
});

test('忙碌延後、同時要求合併、60秒節流、資料缺少不假稱已就緒', async () => {
  let clock = 0, busy = true, calls = 0;
  const checker = new PurchaseReadinessCheck({ dataDir: 'fixture', credentialStore: { ...store, getEsliteCheckoutTemplate: () => null },
    getConfig: () => ({ eslite: {} }), isBusy: () => busy, now: () => clock, verifyEslite: async () => { calls++; return { ok: true }; } });
  assert.equal((await checker.check('eslite')).deferred, true); assert.equal(calls, 0);
  busy = false; const results = await Promise.all([checker.check('eslite'), checker.check('eslite')]);
  assert.equal(calls, 3); assert.deepEqual(results[0], results[1]); assert.equal(results[0].checks[0].setup, 'incomplete');
  assert.equal((await checker.check('eslite')).cached, true); assert.equal(calls, 3);
  clock = 60001; await checker.check('eslite'); assert.equal(calls, 6);
  await assert.rejects(checker.check('../private'), /只支援/);
});

test('結果表格跳脫文字，待儲存時不查官方，不會偷偷改設定', async () => {
  assert.ok(purchaseReadinessRowsHtml({ message: '<img>', checks: [{ slot: '<script>', session: 'valid', setup: 'complete', next: '下一步' }] }).includes('&lt;script&gt;'));
  let calls = 0; const nodes = { 'eslite-purchase-readiness': { textContent: '' }, 'eslite-purchase-readiness-button': { disabled: false } };
  const ctx = vm.createContext({ document: { getElementById: id => nodes[id] }, autoPurchaseDirtyPlatforms: new Set(['eslite']), api: () => { calls++; } });
  vm.runInContext(purchaseReadinessClient, ctx); await vm.runInContext("checkPurchaseReadiness('eslite')", ctx);
  assert.equal(calls, 0); assert.match(nodes['eslite-purchase-readiness'].textContent, /先儲存/);
});

test('控制台入口到唯讀檢查服務的完整路由，非法平台不查外部', async () => {
  const seen = [];
  const server = createDashboard({ port: 0, log: () => {}, getStatus: () => ({}), onCheckPurchaseReadiness: async ({ platform }) => {
    if (!['funbox', 'eslite'].includes(platform)) throw new Error('unsupported'); seen.push(platform); return { message: 'mock', checks: [] }; } });
  if (!server.listening) await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port, html = await (await fetch(base)).text();
    assert.equal(validateDashboardClientScript(html), true);
    for (const platform of ['funbox', 'eslite']) {
      assert.ok(html.includes('id="' + platform + '-purchase-readiness-button"'));
      const response = await fetch(base + '/auto-purchase/readiness', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform }) });
      assert.equal(response.status, 200); assert.deepEqual((await response.json()).checks, []);
    }
    assert.deepEqual(seen, ['funbox', 'eslite']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
