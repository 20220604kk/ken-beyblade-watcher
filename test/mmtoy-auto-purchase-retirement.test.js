import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AutoPurchaseCoordinator, normalizeAutoPurchaseConfig } from '../src/auto-purchase.js';

test('舊版 M.M小舖自動下單設定不會重新啟用購買器', async () => {
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    mmtoy: { enabled: true, turboEnabled: true, action: 'checkout', quantity: 1 }
  });
  assert.equal('mmtoy' in config, false);

  const state = { data: {}, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: {},
    notifyPrivate: async () => {}
  });
  const result = await coordinator.enqueue('mmtoy', [{
    id: 'legacy-mm-item',
    title: 'UX-19 子彈獅鷲H',
    url: 'https://mmtoyshop.com/item/legacy-mm-item'
  }]);
  assert.deepEqual(result, { accepted: 0, ignored: 1, reason: 'disabled' });
});

test('M.M小舖不會被啟動程式自動加回監控，但保留歷史解析與通知模板', async () => {
  const [dashboard, index] = await Promise.all([
    fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(dashboard, /auto-purchase-mmtoy|shared-mm-turbo|M\.M小舖極速器/);
  assert.doesNotMatch(index, /autoPurchase\.enqueue\('mmtoy'\)|MmToyPurchaseAdapter/);
  assert.doesNotMatch(index, /targets\.push\(\{\s*id:\s*'mmtoy-beyblade'/);
  assert.match(dashboard, /discord-mmtoy-status/);
  assert.match(index, /mmtoy-category/);
});
