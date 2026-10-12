import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import { load } from 'cheerio';
import { AutoPurchaseCoordinator, normalizeAutoPurchaseConfig, updateAutoPurchaseSettings, mergeAutoPurchaseLists } from '../src/auto-purchase.js';
import { createDashboard } from '../src/dashboard.js';

const rules = () => normalizeAutoPurchaseConfig({ enabled: true, rulesVersion: 2,
  funbox: { enabled: true, buyKeywords: ['BX-09', 'UX-16'], skipBuyKeywords: ['BX-10'], accountPayments: { A: 'seven_cod', B: 'virtual_atm_home', C: 'virtual_atm_home' } },
  eslite: { enabled: true, buyMode: 'all', buyKeywords: ['CX-05'], skipBuyKeywords: ['BX-37'], quantity: 1 }
});

test('共用黑名單一次遷移到兩份，重複正規化不把已移除項目補回', () => {
  const migrated = normalizeAutoPurchaseConfig({ enabled: true, sharedSkipBuyKeywords: ['戰鬥盤', 'CX-16', 'cx-16'],
    funbox: { enabled: true, skipBuyKeywords: ['BX-10'], buyKeywords: ['BX-09'] },
    eslite: { enabled: true, skipBuyKeywords: ['BX-37'] } });
  assert.deepEqual(migrated.funbox.skipBuyKeywords, ['BX-10', '戰鬥盤', 'CX-16']);
  assert.deepEqual(migrated.eslite.skipBuyKeywords, ['BX-37', '戰鬥盤', 'CX-16']);
  assert.equal('sharedSkipBuyKeywords' in migrated, false);
  assert.deepEqual(normalizeAutoPurchaseConfig(migrated), migrated);
  const edited = updateAutoPurchaseSettings(migrated, { platform: 'eslite', esliteSkipBuyKeywords: [] });
  assert.deepEqual(normalizeAutoPurchaseConfig(edited).eslite.skipBuyKeywords, []);
  assert.deepEqual(edited.funbox, migrated.funbox);
});

test('誠品優先關鍵字獨立保存、按順序去重，黑白名單同步不覆蓋它', () => {
  const before = rules();
  const changed = updateAutoPurchaseSettings(before, { platform: 'eslite', eslitePriorityKeywords: ['BX-09', '強化組', 'bx-09', ''] });
  assert.deepEqual(changed.eslite.priorityKeywords, ['BX-09', '強化組']);
  assert.deepEqual(changed.funbox, before.funbox);
  assert.deepEqual(normalizeAutoPurchaseConfig(JSON.parse(JSON.stringify(changed))).eslite.priorityKeywords, ['BX-09', '強化組']);
  assert.deepEqual(mergeAutoPurchaseLists(changed, { from: 'funbox', to: 'eslite' }).eslite.priorityKeywords, ['BX-09', '強化組']);
  assert.deepEqual(updateAutoPurchaseSettings(changed, { platform: 'eslite', eslitePriorityKeywords: [] }).eslite.priorityKeywords, []);
  assert.throws(() => updateAutoPurchaseSettings(changed, { platform: 'eslite', eslitePriorityKeywords: 'BX-09' }));
  assert.deepEqual(before.eslite.priorityKeywords, []);
});

test('儲存單平台不連動另一邊模式、名單、付款、開關，明確空名單可保留', () => {
  const before = rules();
  const changed = updateAutoPurchaseSettings(before, { platform: 'eslite', esliteBuyMode: 'whitelist', esliteBuyKeywords: [],
    esliteSkipBuyKeywords: ['BX-11'], funboxEnabled: false, funboxBuyKeywords: ['CX-13'] });
  assert.deepEqual(changed.funbox, before.funbox);
  assert.equal(changed.eslite.buyMode, 'whitelist');
  assert.deepEqual(changed.eslite.buyKeywords, []);
  assert.deepEqual(before.eslite.skipBuyKeywords, ['BX-37']);
});

test('手動同步只合併目的地名單並去重，保留順序且不自動啟用白名單模式', () => {
  const before = rules(); const after = mergeAutoPurchaseLists(before, { from: 'funbox', to: 'eslite' });
  assert.deepEqual(after.funbox, before.funbox);
  assert.deepEqual(after.eslite.skipBuyKeywords, ['BX-37', 'BX-10']);
  assert.deepEqual(after.eslite.buyKeywords, ['CX-05', 'BX-09', 'UX-16']);
  assert.equal(after.eslite.buyMode, 'all');
  assert.deepEqual(after.eslite.accountPayments, before.eslite.accountPayments);
  assert.deepEqual(mergeAutoPurchaseLists(after, { from: 'funbox', to: 'eslite' }), after);
  const reverse = mergeAutoPurchaseLists(after, { from: 'eslite', to: 'funbox', list: 'white' });
  assert.deepEqual(reverse.funbox.buyKeywords, ['BX-09', 'UX-16', 'CX-05']);
  assert.deepEqual(reverse.funbox.skipBuyKeywords, after.funbox.skipBuyKeywords);
  assert.throws(() => mergeAutoPurchaseLists(before, { from: 'momo', to: 'eslite' }));
});

test('誠品白名單模式黑名單優先、空白不買；全品模式維持先到先處理', async () => {
  let config = rules(); const calls = [];
  const state = { data: {}, save: async () => {} };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => config,
    adapters: { eslite: { maxConcurrency: 3, credentialsStatus: () => ({ ready: true }), purchase: async p => { calls.push(p.id); return { status: 'ordered', orderId: 'MOCK-' + p.id }; }, close: async () => {} } },
    notifyPrivate: async () => {} });
  const products = ['BX-09', 'BX-37', 'BX-090', 'CX-05'].map(id => ({ id, title: 'BEYBLADE X ' + id, url: 'https://www.eslite.com/product/' + id }));
  try {
    config = updateAutoPurchaseSettings(config, { platform: 'eslite', esliteBuyMode: 'whitelist', esliteBuyKeywords: ['BX-09', 'BX-37'] });
    assert.equal((await coordinator.enqueue('eslite', products)).accepted, 1);
    await coordinator.whenIdle(); assert.deepEqual(calls, ['BX-09']);
    config = updateAutoPurchaseSettings(config, { platform: 'eslite', esliteBuyKeywords: [] });
    assert.equal((await coordinator.enqueue('eslite', products)).accepted, 0);
    config = updateAutoPurchaseSettings(config, { platform: 'eslite', esliteBuyMode: 'all' });
    assert.equal((await coordinator.enqueue('eslite', products)).accepted, 2);
    await coordinator.whenIdle(); assert.deepEqual(calls, ['BX-09', 'BX-090', 'CX-05']);
  } finally { await coordinator.close(); }
});

test('同步不截斷超過百項的名單，無效購買範圍或名單拒絕儲存', () => {
  const before = rules();
  before.funbox.buyKeywords = Array.from({ length: 90 }, (_, index) => 'BX-' + index);
  before.eslite.buyKeywords = Array.from({ length: 90 }, (_, index) => 'UX-' + index);
  const merged = mergeAutoPurchaseLists(before, { from: 'funbox', to: 'eslite', list: 'white' });
  assert.equal(merged.eslite.buyKeywords.length, 180);
  assert.equal(normalizeAutoPurchaseConfig(merged).eslite.buyKeywords.length, 180);
  for (const body of [{ esliteBuyMode: 'invalid' }, { esliteBuyKeywords: 'BX-09' }, { esliteSkipBuyKeywords: [42] }]) {
    assert.throws(() => updateAutoPurchaseSettings(before, { platform: 'eslite', ...body }));
  }
});

test('退役平台舊設定不會重新啟用，API 不能復活購買器', async () => {
  const config = normalizeAutoPurchaseConfig({ ...rules(), momo: { enabled: true }, kingstone: { enabled: true } });
  assert.equal('momo' in config, false); assert.equal('kingstone' in config, false);
  assert.throws(() => updateAutoPurchaseSettings(config, { platform: 'momo', momoEnabled: true }));
  const coordinator = new AutoPurchaseCoordinator({ state: { data: {}, save: async () => {} }, getConfig: () => config, adapters: {} });
  try {
    for (const platform of ['momo', 'kingstone']) assert.equal((await coordinator.enqueue(platform, [{ id: 'test', url: 'https://example.com' }])).reason, 'disabled');
  } finally { await coordinator.close(); }
});

test('儀表板 API 完整走通單平台儲存與同步，UI 無共用名單或退役控制項', async () => {
  let config = rules();
  const server = createDashboard({ port: 0, log: () => {}, getStatus: () => ({ autoPurchase: config }),
    onSaveAutoPurchaseSettings: async body => { config = updateAutoPurchaseSettings(config, body); return { message: 'saved' }; },
    onSyncAutoPurchaseLists: async body => { config = mergeAutoPurchaseLists(config, body); return { message: 'merged' }; } });
  if (!server.listening) await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const html = await (await fetch(base)).text(); const $ = load(html);
    assert.equal($('#auto-purchase-shared-skip-keywords,#auto-purchase-momo-enabled,#auto-purchase-kingstone-enabled').length, 0);
    for (const id of ['funbox-buy-keywords', 'funbox-skip-buy-keywords', 'eslite-buy-keywords', 'eslite-skip-buy-keywords', 'eslite-buy-mode', 'eslite-priority-keywords']) assert.equal($('#' + id).length, 1);
    assert.equal($('#eslite-priority-keywords').attr('oninput'), "markAutoPurchaseDirty('eslite')");
    const client = $('script:not([src])').map((_i, element) => $(element).html()).get().join('\n');
    const payloadFunction = client.match(/function autoPurchaseSettingsPayload\(platform\)\{[\s\S]*?\n\}/)[0];
    const parserFunction = client.match(/function parseFunboxPurchaseKeywords\(value\)\{[^\n]+/)[0];
    const doc = { querySelector(selector) {
      if (selector === '#eslite-priority-keywords') return { value: 'BX-09，強化組,UX-15' };
      if (selector === '#eslite-buy-mode') return { value: 'all' };
      if (selector === '#auto-purchase-eslite-enabled') return { checked: true };
      if (selector === '#auto-purchase-eslite-quantity') return { value: '1' };
      if (selector === '#eslite-batch-items') return { value: '5' };
      if (selector === '#eslite-batch-collect') return { value: '500' };
      if (selector === '#eslite-batch-build') return { value: '8' };
      if (selector === '#eslite-batch-total') return { value: '1500' };
      if (selector === '#eslite-batch-partial') return { checked: true };
      if (selector.endsWith('-mode')) return { value: 'single' };
      return { value: '' };
    } };
    const context = vm.createContext({ document: doc, esliteAccountPaymentsPayload: () => config.eslite.accountPayments, currentEsliteSlots: () => ['A', 'B', 'C'] });
    vm.runInContext(parserFunction + '\n' + payloadFunction, context);
    const payload = JSON.parse(vm.runInContext("JSON.stringify(autoPurchaseSettingsPayload('eslite'))", context));
    assert.deepEqual(payload.esliteAccountModes, { A: 'single', B: 'single', C: 'single' });
    assert.equal(payload.esliteBatchMaxTotal, 1500);
    for (const platform of ['funbox', 'eslite']) {
      for (const slot of ['A', 'B', 'C']) {
        const choices = $(`input[name="${platform}-account-${slot}-payment"]`);
        assert.equal(choices.length, 2);
        choices.each((_i, element) => assert.equal($(element).attr('onchange'), `markAutoPurchaseDirty('${platform}')`));
      }
    }
    $('script:not([src])').each((_i, element) => new vm.Script($(element).html()));
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal((await post('/auto-purchase/settings', payload)).status, 200);
    assert.equal((await post('/auto-purchase/settings', { platform: 'eslite', esliteBuyMode: 'whitelist', esliteBuyKeywords: ['CX-05'] })).status, 200);
    assert.equal((await post('/auto-purchase/sync-lists', { from: 'funbox', to: 'eslite' })).status, 200);
    const saved = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(saved.autoPurchase.eslite.buyKeywords, ['CX-05', 'BX-09', 'UX-16']);
    assert.equal(saved.autoPurchase.eslite.buyMode, 'whitelist');
    assert.deepEqual(saved.autoPurchase.eslite.priorityKeywords, ['BX-09', '強化組', 'UX-15']);
    assert.deepEqual(saved.autoPurchase.funbox.buyKeywords, ['BX-09', 'UX-16']);
    assert.notEqual((await post('/auto-purchase/sync-lists', { from: 'momo', to: 'eslite' })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('正式啟動入口不載入退役類別或派單，不依賴外部封存原始碼', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MomoPurchaseAdapter|KingstonePurchaseAdapter|enqueueMomoAutoPurchase|enqueueKingstoneAutoPurchase/);
  assert.match(source, /momo-category/); // 商品監控入口保留。
});
