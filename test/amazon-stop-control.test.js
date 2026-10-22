import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AmazonJpHttpClient } from '../src/amazon-jp-http.js';
import { product, review, asin, origin } from './fixtures/amazon-race-fixtures.js';

const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('onSaveAmazonJpProductOrder: async'), source.indexOf('  onOpenAmazonJpProductOrderLogin:', source.indexOf('onSaveAmazonJpProductOrder: async')));
function fixture({ running = true, interactive = false, phase = 'checking', pending = null, saveConfig } = {}) {
  const calls = [], current = { enabled: true, mode: 'hybrid', fastLane: true, checkoutTransport: 'api',
    targetUrl: origin + '/dp/' + asin, targetSuccessCount: 3, maxShippingYen: 500, priceToleranceYen: 1 };
  const storage = { completedCount: 2, apiTransaction: pending, checkoutStockWait: { asin, url: 'private-position' } };
  const monitor = { running, interactive, phase, stopped: false, browserOperation: false,
    assertIdle() { calls.push('assertIdle'); if (this.running) throw Error('busy'); },
    stop() { this.stopped = true; calls.push('stop'); },
    storage: () => storage, hasPendingApiTransaction: () => Boolean(pending),
    closeBrowser: async () => calls.push('closeBrowser'), resetProgress: async () => assert.fail('no reset'),
    start: async () => assert.fail('no start') };
  const config = { amazonJpProductOrders: { A: current } };
  const save = vm.runInNewContext('({' + callback + '}).onSaveAmazonJpProductOrder', {
    config, amazonJpProductOrderBySlot: { A: monitor }, saveConfig: async () => { calls.push('save'); await saveConfig?.(); },
    normalizeAmazonJpProductUrl: value => value, normalizeAmazonJpProductMode: value => value,
    amazonRaceCoordinator: { cancel: async slot => { assert.equal(slot, 'A'); calls.push('cancel'); },
      reset: async () => assert.fail('no race reset'), pending: () => Boolean(pending) }, log: () => {}
  });
  return { save, config, current, monitor, storage, calls };
}

test('stop while reading takes effect synchronously before persistence; no idle guard or browser teardown', async () => {
  let release; const saved = new Promise(resolve => { release = resolve; });
  const f = fixture({ saveConfig: () => saved }), before = JSON.stringify({ ...f.current, enabled: false });
  const pending = f.save({ slot: 'A', enabled: false, stopOnly: true });
  assert.equal(f.current.enabled, false); assert.equal(f.monitor.stopped, true);
  assert.deepEqual(f.calls, ['stop', 'save']);
  release(); const result = await pending;
  assert.match(result.message, /安全收尾/); assert.deepEqual(f.calls, ['stop', 'save', 'cancel']);
  assert.equal(JSON.stringify(f.current), before); assert.equal(f.storage.completedCount, 2);
  assert.equal(f.storage.checkoutStockWait.url, 'private-position');
});

for (const phase of ['buy_now', 'submitted', 'confirmed']) test(`stop preserves ${phase} transaction and closes no active checkout`, async () => {
  const transaction = { phase, route: 'direct_buy_now', asin, quantity: 1, orderId: phase === 'confirmed' ? '000-0000000-0000001' : '' };
  const f = fixture({ phase: 'ordering', pending: transaction }); const original = JSON.stringify(f.storage);
  await f.save({ slot: 'A', enabled: false, stopOnly: true });
  assert.equal(JSON.stringify(f.storage), original); assert.equal(f.calls.includes('closeBrowser'), false);
  assert.equal(f.current.enabled, false);
});

test('older dashboard unchanged full settings can stop during polling without reset or applying other edits', async () => {
  const f = fixture(); const original = { ...f.current };
  await f.save({ ...original, slot: 'A', enabled: false });
  assert.equal(f.current.enabled, false); assert.deepEqual(f.calls, ['stop', 'save', 'cancel']);
});

test('settings edits and progress reset stay blocked while busy; only stop bypasses idle', async () => {
  for (const patch of [{ targetUrl: origin + '/dp/B0TEST0002' }, { targetSuccessCount: 4 }, { maxShippingYen: 100 }, { resetProgress: true }]) {
    const f = fixture(), before = JSON.stringify(f.current);
    await assert.rejects(f.save({ ...f.current, slot: 'A', enabled: false, ...patch }), /busy/);
    assert.equal(JSON.stringify(f.current), before); assert.equal(f.monitor.stopped, false);
  }
});

test('stopping an idle task can release its background browser, but leaves manual login open', async () => {
  for (const interactive of [true, false]) {
    const f = fixture({ running: false, interactive }); await f.save({ slot: 'A', enabled: false, stopOnly: true });
    assert.equal(f.calls.includes('closeBrowser'), !interactive);
  }
});

test('disabled task cannot enter final submit after an in-flight checkout read returns', async () => {
  const f = fixture({ phase: 'ordering' }); const calls = []; let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { entered = resolve; });
  const response = html => ({ status: () => 200, headers: () => ({}), text: async () => html, dispose: async () => {} });
  const client = new AmazonJpHttpClient({ directBuyNow: true, canContinue: () => f.current.enabled && !f.monitor.stopped,
    request: { fetch: async (url, options) => {
      const path = new URL(url).pathname; calls.push({ path, method: options.method });
      if (path.startsWith('/dp/')) return response(product());
      if (path === '/checkout/entry/buynow') { entered(); await waiting; return response(review()); }
      assert.fail('stop must prevent final POST');
    } } });
  const quote = await client.readDirectOffer(asin);
  const checkout = client.checkout(quote, { beforeSubmit: async () => {} });
  const rejected = assert.rejects(checkout, /停止/);
  await reading; await f.save({ slot: 'A', enabled: false, stopOnly: true }); release(); await rejected;
  assert.equal(client.submitted, false); assert.equal(calls.filter(c => c.path.endsWith('/place-order')).length, 0);
});

test('stop during final grant persistence prevents order POST and preserves durable intent', async () => {
  const f = fixture({ phase: 'ordering' }), calls = []; let release, entered;
  const pendingGrant = new Promise(resolve => { release = resolve; }), granting = new Promise(resolve => { entered = resolve; });
  const response = html => ({ status: () => 200, headers: () => ({}), text: async () => html, dispose: async () => {} });
  const client = new AmazonJpHttpClient({ directBuyNow: true, canContinue: () => f.current.enabled && !f.monitor.stopped,
    checkpoint: async tx => { f.storage.apiTransaction = { ...tx }; },
    authorizeFinalSubmit: async () => { entered(); await pendingGrant; },
    request: { fetch: async (url, options) => {
      const path = new URL(url).pathname; calls.push({ path, method: options.method });
      if (path.startsWith('/dp/')) return response(product());
      if (path === '/checkout/entry/buynow') return response(review());
      assert.fail('stop during grant must prevent final POST');
    } } });
  const quote = await client.readDirectOffer(asin);
  const checkout = client.checkout(quote, { beforeSubmit: async () => {} }), rejected = assert.rejects(checkout, /停止/);
  await granting; await f.save({ slot: 'A', enabled: false, stopOnly: true }); release(); await rejected;
  assert.equal(client.submitted, false); assert.equal(f.storage.apiTransaction.phase, 'buy_now');
  assert.equal(calls.some(c => c.path.endsWith('/place-order')), false);
});
