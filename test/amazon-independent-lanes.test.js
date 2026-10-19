import assert from 'node:assert/strict';
import test from 'node:test';
import { AmazonJapanMonitor } from '../src/amazon-jp-monitor.js';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';

// All pages, requests, notifications and orders below are in-memory fakes.
const products = ['BX-52', 'BX-53', 'BX-09'].map((code, index) => ({
  asin: `B0TEST000${index + 1}`, code, title: `BEYBLADE X ${code} Fixture`,
  available: true, sellerConfirmed: true, priceYen: 1000, msrpYen: 1000
}));
const catalog = products.map(product => ({
  code: product.code, name: 'Fixture', normalizedName: 'FIXTURE', msrpYen: 1000
}));
const searchHtml = '<div data-component-type="s-search-result" data-asin="B0OTHER001"><h2>Accessory</h2><span class="a-price"><span class="a-offscreen">￥100</span></span></div>';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, options = {}) {
  const storage = {
    initialized: true, searchDiscoveryVersion: 1, catalog,
    products: Object.fromEntries(products.map(product => [product.asin, { ...product, available: false }])),
    manualProducts: Object.fromEntries(products.map(product => [product.asin, product])),
    brandProducts: {}, xSignals: {}
  };
  const state = { data: { commerce: { amazonJp: storage } }, save: async () => {} };
  const signals = [], notifications = [], logs = [];
  const monitor = new AmazonJapanMonitor({ dataDir: '.', state,
    getConfig: () => ({ watchProducts: [], watchBatchSize: 3, backgroundBatchSize: 1 }),
    log: message => logs.push(message),
    notify: options.notify || (async () => { notifications.push('sent'); }),
    onAvailabilitySignal: options.onSignal || ((product, signal) => { signals.push({ product, signal }); })
  });
  monitor.ensureSeedSignals = async () => {};
  monitor.refreshCatalog = async () => catalog;
  monitor.refreshBrandProducts = async () => ({});
  monitor.loadPage = async () => searchHtml;
  monitor.verifyOffer = async product => ({ ...product });
  t.after(() => monitor.close());
  return { monitor, state, storage, signals, notifications, logs };
}
function purchaseFixture(t, state, checkout) {
  const config = { enabled: true, mode: 'hybrid', fastLane: true,
    targetUrl: `https://www.amazon.co.jp/dp/${products[0].asin}`, targetSuccessCount: 1 };
  const history = { begin: async () => ({}), step: async () => {}, finish: async () => {},
    notification: async () => {}, status: () => ({ recent: [], total: 0 }) };
  const order = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config,
    storageKey: 'amazonJpProductOrderA', orderHistory: history });
  order.httpClient = async () => ({
    readOffer: async () => ({ ...products[0], addCartAvailable: true, priceText: '￥1,000', pageIssue: '' }),
    checkout: checkout || (async () => ({ status: 'ordered', snapshot: {
      orderId: 'FAKE-OFFLINE-ORDER', url: 'https://www.amazon.co.jp/thankyou'
    } }))
  });
  t.after(() => order.close());
  return order;
}
async function pollNow(order) {
  // Exercise the real scheduled entry point without waiting for a real timer.
  clearTimeout(order.timer);
  order.timer = null;
  await order.runScheduledScan();
}

test('first verified product is handed off before later reads, without awaiting the consumer', { timeout: 5000 }, async t => {
  const nextRead = deferred(), releaseRead = deferred(), consumer = deferred();
  t.after(() => { releaseRead.resolve(); consumer.resolve(); });
  const signals = [];
  const f = fixture(t, { onSignal: product => { signals.push(product.asin); return consumer.promise; } });
  f.monitor.verifyOffer = async product => {
    if (product.asin === products[1].asin) { nextRead.resolve(); await releaseRead.promise; }
    return { ...product };
  };
  const scan = f.monitor.scan();
  await nextRead.promise;
  assert.deepEqual(signals, [products[0].asin]);
  releaseRead.resolve();
  const result = await scan; // Consumer is still pending, not awaited.
  assert.equal(result.restocked, 3);
  assert.equal(signals.length, 3);
});

test('a slow Discord request does not delay any product purchase signal', { timeout: 5000 }, async t => {
  const sending = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t, { notify: async () => { sending.resolve(); await release.promise; } });
  const scan = f.monitor.scan();
  await sending.promise;
  assert.deepEqual(f.signals.map(event => event.product.asin), products.map(product => product.asin));
  release.resolve();
  assert.equal((await scan).notified, 3);
});

for (const asynchronous of [false, true]) {
  test(`consumer ${asynchronous ? 'rejection' : 'synchronous throw'} cannot stop monitoring`, async t => {
    const f = fixture(t, { onSignal: () => {
      if (asynchronous) return Promise.reject(new Error('fake consumer failure'));
      throw new Error('fake consumer failure');
    } });
    assert.equal((await f.monitor.scan()).restocked, 3);
    assert.equal(f.notifications.length, 3);
    assert.equal(f.logs.filter(message => message.includes('監控繼續')).length, 3);
  });
}

test('first baseline, coverage upgrade and unchanged availability remain quiet', async t => {
  const f = fixture(t);
  f.storage.initialized = false;
  await f.monitor.scan();
  assert.equal(f.signals.length, 0);
  for (const product of Object.values(f.storage.products)) product.available = false;
  f.storage.searchDiscoveryVersion = 0;
  await f.monitor.scan();
  await f.monitor.scan();
  assert.equal(f.signals.length, 0);
});

test('dedicated pre-catalog signals are handed off before broad search starts', { timeout: 5000 }, async t => {
  const searchStarted = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t);
  const product = { ...products[0], dedicatedUntilCatalog: true, manualMsrpYen: 1000 };
  f.storage.manualProducts = { [product.asin]: product };
  f.monitor.refreshCatalog = async () => [];
  f.monitor.loadPage = async () => { searchStarted.resolve(); await release.promise; return searchHtml; };
  const scan = f.monitor.scan();
  await searchStarted.promise;
  assert.deepEqual(f.signals.map(event => event.product.asin), [product.asin]);
  release.resolve();
  await scan;
  assert.equal(f.signals.length, 1);
});

test('later read failure preserves delivered observations and sends their notification, without replay', async t => {
  const f = fixture(t);
  f.monitor.verifyOffer = async product => {
    if (product.asin === products[1].asin) throw Object.assign(new Error('fake busy'), { code: 'AMAZON_RATE_LIMITED' });
    return { ...product };
  };
  await assert.rejects(f.monitor.scan(), /fake busy/);
  assert.equal(f.storage.products[products[0].asin].available, true);
  assert.equal(f.signals.length, 1);
  assert.equal(f.notifications.length, 1);
  f.monitor.verifyOffer = async product => ({ ...product });
  await f.monitor.scan();
  assert.equal(f.signals.filter(event => event.product.asin === products[0].asin).length, 1);
});

test('notification failure retries delivery next round without replaying purchase signals', async t => {
  let failed = false, delivered = 0;
  const f = fixture(t, { notify: async () => {
    if (!failed) { failed = true; throw new Error('fake Discord timeout'); }
    delivered += 1;
  } });
  await assert.rejects(f.monitor.scan(), /fake Discord timeout/);
  assert.equal(f.signals.length, 3);
  assert.equal(Object.keys(f.storage.pendingAvailabilityNotifications).length, 3);
  await f.monitor.scan();
  assert.equal(delivered, 3);
  assert.equal(f.signals.length, 3);
  assert.deepEqual(f.storage.pendingAvailabilityNotifications, {});
});

test('automatic purchase polls and completes while broad monitoring is stalled', { timeout: 5000 }, async t => {
  const searchStarted = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t);
  f.monitor.loadPage = async () => { searchStarted.resolve(); await release.promise; return searchHtml; };
  const scan = f.monitor.scan();
  await searchStarted.promise;
  const order = purchaseFixture(t, f.state);
  await order.start();
  await pollNow(order);
  assert.equal(order.storage().completedCount, 1);
  assert.equal(f.monitor.running, true);
  release.resolve();
  await scan;
});

test('monitoring completes while checkout is stalled; duplicate signals cannot start another purchase', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t);
  let submits = 0;
  const order = purchaseFixture(t, f.state, async () => {
    submits += 1; entered.resolve(); await release.promise;
    return { status: 'ordered', snapshot: { orderId: 'FAKE-OFFLINE-ORDER', url: 'https://www.amazon.co.jp/thankyou' } };
  });
  f.monitor.onAvailabilitySignal = (product, signal) => order.requestPurchaseFromSignal(product, signal);
  await order.start();
  const purchase = pollNow(order);
  await entered.promise;
  assert.equal((await f.monitor.scan()).restocked, 3);
  assert.equal(order.running, true);
  assert.equal(order.pendingSignal, null);
  assert.equal(submits, 1);
  release.resolve();
  await purchase;
  assert.equal(order.storage().completedCount, 1);
});
