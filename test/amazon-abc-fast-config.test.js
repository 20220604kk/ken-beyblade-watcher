import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeAmazonJpProductMode } from '../src/amazon-jp-product-order.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const startup = source.slice(source.indexOf('const legacyAmazonProductOrder ='), source.indexOf('delete config.amazonJpSingleOrder;'));
test('ABC startup preserves fast configuration, targets and disabled flags, with no auto activation', () => {
  const config = { amazonJpProductOrders: {
    A: { enabled: true, fastLane: true, targetUrl: 'A' },
    B: { enabled: false, fastLane: true, targetUrl: 'B', targetSuccessCount: 3, maxShippingYen: 400 },
    C: { enabled: false, fastLane: true, targetUrl: 'C', targetSuccessCount: 2, maxShippingYen: 500 }
  } };
  vm.runInNewContext(startup, { config, normalizeAmazonJpProductMode });
  for (const slot of ['A','B','C']) assert.equal(config.amazonJpProductOrders[slot].fastLane, true);
  assert.equal(config.amazonJpProductOrders.B.enabled, false);
  assert.equal(config.amazonJpProductOrders.C.enabled, false);
  assert.equal(config.amazonJpProductOrders.B.targetUrl, 'B');
  assert.equal(config.amazonJpProductOrders.B.targetSuccessCount, 3);
  assert.equal(config.amazonJpProductOrders.B.maxShippingYen, 400);
  const defaults = {};
  vm.runInNewContext(startup, { config: defaults, normalizeAmazonJpProductMode });
  for (const slot of ['A','B','C']) {
    assert.equal(defaults.amazonJpProductOrders[slot].enabled, false);
    assert.equal(defaults.amazonJpProductOrders[slot].fastLane, true);
  }
});

test('saving B/C retains fast lane and existing task settings, without resetting progress or starting disabled tasks', async () => {
  const callback = source.slice(source.indexOf('onSaveAmazonJpProductOrder: async'), source.indexOf('  onOpenAmazonJpProductOrderLogin:', source.indexOf('onSaveAmazonJpProductOrder: async')));
  for (const slot of ['B','C']) {
    const calls = [];
    const config = { amazonJpProductOrders: { [slot]: { enabled: false, fastLane: false, checkoutTransport: 'api', targetUrl: 'fixture-' + slot, targetSuccessCount: 2, maxShippingYen: 400, mode: 'hybrid' } } };
    const monitor = { assertIdle: () => {}, stop: () => calls.push('stop'), closeBrowser: async () => {},
      hasPendingApiTransaction: () => false, resetProgress: async () => assert.fail('must not reset'),
      start: async () => assert.fail('must not start'), pollIntervalMs: () => 2000 };
    const sandbox = { config, amazonJpProductOrderBySlot: { [slot]: monitor }, saveConfig: async () => calls.push('save'),
      amazonRaceCoordinator: { pending: () => false, cancel: async () => {}, reset: async () => {} },
      normalizeAmazonJpProductUrl: value => value, normalizeAmazonJpProductMode, log: () => {} };
    const save = vm.runInNewContext('({' + callback + '}).onSaveAmazonJpProductOrder', sandbox);
    await save({ slot, enabled: false, fastLane: true, targetSuccessCount: 2 });
    assert.equal(config.amazonJpProductOrders[slot].fastLane, true);
    assert.equal(config.amazonJpProductOrders[slot].enabled, false);
    assert.equal(config.amazonJpProductOrders[slot].targetUrl, 'fixture-' + slot);
    assert.equal(config.amazonJpProductOrders[slot].maxShippingYen, 400);
    assert.deepEqual(calls, ['stop','save']);
    await save({ slot, enabled: false, fastLane: false, targetSuccessCount: 2 });
    assert.equal(config.amazonJpProductOrders[slot].fastLane, true, 'old dashboard payload cannot downgrade an upgraded slot');
    vm.runInNewContext(startup, { config, normalizeAmazonJpProductMode });
    assert.equal(config.amazonJpProductOrders[slot].fastLane, true);
  }
});
