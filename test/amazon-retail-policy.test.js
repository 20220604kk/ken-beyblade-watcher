import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonJapanMonitor } from '../src/amazon-jp-monitor.js';
import { AmazonJpProductOrderMonitor, evaluateAmazonJpProductOrder, matchesAmazonJpPurchaseSignal, validateAmazonJpProductCheckout } from '../src/amazon-jp-product-order.js';
import { retailAsin as asin, retailAod } from './fixtures/amazon-aod-fixtures.js';
import { product, review, completion } from './fixtures/amazon-race-fixtures.js';

function fixture(t) {
  const calls = [], signals = [], notifications = [], catalog = [{ code: 'CX-99', msrpYen: 1 }];
  const product = { asin, code: 'CX-99', title: 'BEYBLADE X CX-99 Fixture', available: false };
  const storage = { initialized: true, searchDiscoveryVersion: 1, catalog, catalogCheckedAt: '2020-01-01', products: { [asin]: product } };
  let html = retailAod(), status = 200, headers = {};
  const monitor = new AmazonJapanMonitor({ dataDir: '.', state: { data: { commerce: { amazonJp: storage } }, save: async () => {} },
    getConfig: () => ({ enabled: true, watchProducts: [product], watchBatchSize: 1 }),
    fetcher: async () => assert.fail('TT fetch must never run'),
    notify: async message => { notifications.push(message); }, onAvailabilitySignal: (p, e) => signals.push({ p, e }) });
  monitor.ensureSeedSignals = async () => {};
  monitor.refreshCatalog = async () => assert.fail('catalog refresh is disconnected');
  monitor.refreshBrandProducts = async () => assert.fail('brand refresh is disconnected');
  monitor.browserPage = async () => ({}); monitor.ensureJapanLocation = async () => {};
  monitor.ensureContext = async () => ({ request: { fetch: async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(new URL(url).origin, 'https://www.amazon.co.jp');
    assert.match(url, /aodAjaxMain/); calls.push({ url, method: options.method });
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} };
  } } });
  t.after(() => monitor.close());
  return { monitor, storage, catalog, calls, signals, notifications,
    set: (value, httpStatus = 200, h = {}) => { html = value; status = httpStatus; headers = h; },
    scan: () => monitor.scan({ lane: 'background', forceCatalog: true }) };
}

test('TT outage/empty/stale catalog cannot block AOD; unknown model and price above historical MSRP qualify', async t => {
  const f = fixture(t); await f.scan();
  assert.equal(f.storage.products[asin].available, true); assert.equal(f.storage.products[asin].priceYen, 9900);
  assert.equal(f.storage.products[asin].msrpYen, null); assert.equal(f.storage.products[asin].pricingSource, 'amazon_retail_aod');
  assert.equal(f.storage.catalog, f.catalog); assert.equal(f.storage.catalogCheckedAt, '2020-01-01');
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0].e.source, '日亞自營AOD');
  assert.equal(f.calls.length, 1); assert.equal(f.monitor.status().lastBackgroundDiagnostic.transport, 'aod_http');
  await f.scan(); assert.equal(f.signals.length, 1, 'unchanged stock cannot replay purchase signal');
  f.storage.catalog = []; f.set(retailAod({ available: false })); await f.scan();
  assert.equal(f.storage.products[asin].available, false);
  f.set(retailAod()); await f.scan(); assert.equal(f.signals.length, 2);
});

for (const options of [{ seller: 'OTHER' }, { condition: '中古品' }]) test(`AOD excludes third-party FBA and used retail ${JSON.stringify(options)}`, async t => {
  const f = fixture(t); f.set(retailAod(options)); await f.scan();
  assert.equal(f.storage.products[asin].available, false); assert.equal(f.signals.length, 0);
});

for (const page of ['<h1>Temporary empty response</h1>', retailAod({ malformed: true })]) test('incomplete AOD preserves known stock and cannot emit false sold-out/restock', async t => {
  const f = fixture(t); await f.scan(); const old = f.storage.products[asin];
  f.set(page); await f.scan(); assert.equal(f.storage.products[asin], old); assert.equal(f.signals.length, 1);
  assert.match(f.storage.lastBackgroundRejected[0].reason, /不完整/);
});

for (const status of [429, 503]) test(`AOD HTTP ${status} retains baseline and honors real Retry-After`, async t => {
  const f = fixture(t); const old = f.storage.products[asin]; f.set('', status, { 'retry-after': '180' });
  await assert.rejects(f.scan(), e => e.code === 'AMAZON_RATE_LIMITED' && e.retryAfterMs === 180000);
  assert.equal(f.storage.products[asin], old); assert.equal(f.calls.length, 1); assert.equal(f.signals.length, 0);
});

test('new ASIN discovery still uses search; AOD alone provides stock/seller/price without TT', async t => {
  const f = fixture(t); f.storage.products = {}; f.storage.catalog = [];
  f.monitor.loadPage = async url => { assert.match(url, /\/s\?/); return `<div data-component-type="s-search-result" data-asin="${asin}"><h2>BEYBLADE X CX-99 Fixture</h2><span class="a-price"><span class="a-offscreen">￥1</span></span></div>`; };
  await f.monitor.scan({ lane: 'search' });
  assert.equal(f.storage.products[asin].priceYen, 9900); assert.equal(f.storage.products[asin].available, true);
  assert.equal(f.signals.length, 1); assert.equal(f.calls.length, 1);
});

test('single product/signal has no MSRP gate; checkout stays bound to actual quote and existing shipping/identity checks', () => {
  const snapshot = { asin, code: 'CX-99', sellerConfirmed: true, priceYen: 9900, addCartAvailable: true, available: true };
  assert.equal(evaluateAmazonJpProductOrder(snapshot, null).eligible, true);
  assert.equal(matchesAmazonJpPurchaseSignal({ enabled: true, targetUrl: 'https://www.amazon.co.jp/dp/' + asin }, snapshot, { source: '日亞自營AOD', kind: 'restock' }), true);
  const checkout = { url: 'https://www.amazon.co.jp/checkout/p/fixture/spc', itemCount: 1, quantity: 1, asin, code: 'CX-99', sellerConfirmed: true,
    deliveryConfirmed: true, shippingYen: 500, totalYen: 10400 };
  assert.equal(validateAmazonJpProductCheckout(checkout, { asin, code: 'CX-99', quotePriceYen: 9900 }).totalYen, 10400);
  assert.throws(() => validateAmazonJpProductCheckout({ ...checkout, totalYen: 11000 }, { asin, quotePriceYen: 9900 }), /本輪自營報價/);
  for (const patch of [{ sellerConfirmed: false }, { quantity: 2 }, { shippingYen: 501 }]) assert.throws(() => validateAmazonJpProductCheckout({ ...checkout, ...patch }, { asin, quotePriceYen: 9900 }));
});

test('real single HTTP chain accepts retail quote above old catalog/manual price without resolving TT, and posts final once', async t => {
  const calls = [], records = [], state = { data: { commerce: { amazonJp: {
    catalog: [{ code: 'BX-40', msrpYen: 1 }], manualProducts: { [asin]: { manualMsrpYen: 1 } }
  } } }, save: async () => {}, writeSnapshot: async () => {} };
  const config = { enabled: true, fastLane: true, checkoutTransport: 'api', mode: 'hybrid', targetSuccessCount: 1,
    targetUrl: 'https://www.amazon.co.jp/dp/' + asin, maxShippingYen: 500 };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config,
    orderHistory: { status: () => ({}), begin: async r => { records.push(r); return r; }, step: async () => {}, finish: async () => {}, notification: async () => {} } });
  t.after(() => monitor.close()); monitor.resolveMsrp = () => assert.fail('runtime must not resolve TT or manual MSRP');
  monitor.contextFor = async () => ({ request: { fetch: async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method });
    let html, status = 200, headers = {};
    if (path.startsWith('/dp/')) html = product({ target: asin, price: 9900 });
    else if (path === '/checkout/entry/buynow') html = review({ target: asin, total: 10400 }).replace('商品: JPY 880', '商品: JPY 9900');
    else if (path.endsWith('/place-order')) { html = ''; status = 302; headers.location = '/gp/buy/thankyou/handlers/display.html'; }
    else if (path.includes('/thankyou/')) html = completion();
    else assert.fail('unexpected network path ' + path);
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} };
  } } });
  assert.equal((await monitor.scanOnce({ purchase: true, trigger: 'poll' })).status, 'ordered');
  assert.equal(monitor.storage().completedCount, 1); assert.equal(records[0].msrpYen, null);
  assert.equal(calls.filter(c => c.path.endsWith('/place-order')).length, 1);
});
