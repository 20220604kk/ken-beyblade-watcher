import assert from 'node:assert/strict';
import test from 'node:test';
import { AmazonReadScheduler, amazonRetryAfterMs } from '../src/amazon-read-scheduler.js';
import { AmazonJapanMonitor } from '../src/amazon-jp-monitor.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('profile-scoped in-flight reads coalesce without sharing across accounts or retaining stale quotes', async t => {
  const scheduler = new AmazonReadScheduler({ spacingMs: 0 });
  t.after(() => scheduler.close());
  const release = deferred();
  let calls = 0;
  const read = () => { calls++; return release.promise; };
  const a = scheduler.run({ scope: 'A', key: 'ASIN' }, read);
  const duplicate = scheduler.run({ scope: 'A', key: 'ASIN' }, read);
  const b = scheduler.run({ scope: 'B', key: 'ASIN' }, read);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(a, duplicate);
  release.resolve({ price: 1000 });
  await Promise.all([a, duplicate, b]);
  await scheduler.run({ scope: 'A', key: 'ASIN' }, async () => { calls++; });
  assert.equal(calls, 3);
});

test('queued discovery wins over background work; concurrency stays bounded', async t => {
  const scheduler = new AmazonReadScheduler({ spacingMs: 0, maxConcurrent: 1 });
  t.after(() => scheduler.close());
  const release = deferred(), calls = [];
  const first = scheduler.run({ scope: 'A' }, () => release.promise);
  const background = scheduler.run({ scope: 'monitor', lane: 'background' }, async () => calls.push('background'));
  const search = scheduler.run({ scope: 'monitor', lane: 'search' }, async () => calls.push('search'));
  assert.equal(scheduler.status().active, 1);
  release.resolve();
  await Promise.all([first, background, search]);
  assert.deepEqual(calls, ['search', 'background']);
});

test('background reads wait near the discovery deadline while single reads remain eligible', async t => {
  const scheduler = new AmazonReadScheduler({ spacingMs: 0 });
  t.after(() => scheduler.close());
  scheduler.reserveSearch(Date.now() + 1000);
  let backgroundStarted = false;
  const background = scheduler.run({ scope: 'monitor', lane: 'background' }, async () => { backgroundStarted = true; });
  await scheduler.run({ scope: 'A', lane: 'single' }, async () => {});
  assert.equal(backgroundStarted, false);
  scheduler.reserveSearch(null);
  await background;
  assert.equal(backgroundStarted, true);
});

test('Retry-After blocks all queued reads for that profile without blocking another account or replaying requests', async t => {
  const scheduler = new AmazonReadScheduler({ spacingMs: 0, maxConcurrent: 1 });
  t.after(() => scheduler.close());
  let calls = 0;
  const limited = scheduler.run({ scope: 'monitor' }, async () => {
    calls++;
    throw Object.assign(new Error('busy'), { code: 'AMAZON_RATE_LIMITED', httpStatus: 429, retryAfterMs: 180_000 });
  });
  const queued = scheduler.run({ scope: 'monitor', lane: 'search' }, async () => { calls++; });
  const other = scheduler.run({ scope: 'A' }, async () => 'ok');
  const outcomes = await Promise.allSettled([limited, queued, other]);
  assert.equal(outcomes[0].reason.httpStatus, 429);
  assert.ok(outcomes[1].reason.retryAfterMs > 170_000);
  assert.equal(outcomes[2].value, 'ok');
  assert.equal(calls, 1);
  assert.equal(scheduler.status().recent.some(item => item.httpStatus === 429), true);
});

test('stopping cancels queued reads before network access', async () => {
  const scheduler = new AmazonReadScheduler({ spacingMs: 0 });
  scheduler.reserveSearch(Date.now());
  let calls = 0;
  const queued = scheduler.run({ scope: 'monitor', lane: 'background' }, async () => { calls++; });
  scheduler.close();
  await assert.rejects(queued, { code: 'AMAZON_READ_CANCELLED' });
  assert.equal(calls, 0);
});

test('Retry-After accepts seconds and HTTP dates without negative or NaN delays', () => {
  assert.equal(amazonRetryAfterMs('120', 0), 120_000);
  assert.equal(amazonRetryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120_000);
  assert.equal(amazonRetryAfterMs('broken', 0), 0);
  assert.equal(amazonRetryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 0);
});

const known = { asin: 'B0TEST0001', code: 'BX-52', title: 'BEYBLADE X BX-52 Fixture',
  available: true, sellerConfirmed: true, priceYen: 1000, msrpYen: 1000 };
const catalog = [{ code: known.code, name: 'Fixture', normalizedName: 'FIXTURE', msrpYen: 1000 }];
const searchHtml = '<div data-component-type="s-search-result" data-asin="B0OTHER001"><h2>Accessory</h2><span class="a-price"><span class="a-offscreen">￥100</span></span></div>';
function monitorFixture(t, extra = {}) {
  const storage = { initialized: true, searchDiscoveryVersion: 1, catalog,
    products: { [known.asin]: { ...known, available: false } }, brandProducts: {}, manualProducts: {}, xSignals: {} };
  const signals = [], notifications = [];
  const monitor = new AmazonJapanMonitor({ dataDir: '.',
    state: { data: { commerce: { amazonJp: storage } }, save: async () => {} },
    getConfig: () => ({ enabled: true, watchProducts: [known] }),
    onAvailabilitySignal: product => signals.push(product.asin),
    notify: async () => { notifications.push('sent'); }, ...extra });
  monitor.ensureSeedSignals = async () => {};
  monitor.refreshCatalog = async () => catalog;
  monitor.refreshBrandProducts = async () => ({});
  monitor.loadPage = async () => searchHtml;
  monitor.verifyOffer = async product => ({ ...product });
  t.after(() => monitor.close());
  return { monitor, storage, signals, notifications };
}

test('a stalled background product read cannot hold the next discovery scan or overwrite its observations', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = monitorFixture(t);
  f.monitor.verifyOffer = async product => { entered.resolve(); await release.promise; return { ...product }; };
  const background = f.monitor.scan({ lane: 'background' });
  await entered.promise;
  const discovery = await f.monitor.scan({ lane: 'search' });
  assert.equal(discovery.searchCount, 1);
  assert.equal(f.monitor.backgroundRunning, true);
  const searchAt = f.storage.lastScanAt;
  release.resolve();
  await background;
  assert.equal(f.storage.lastScanAt, searchAt);
  assert.equal(f.storage.products[known.asin].available, true);
  assert.equal(f.signals.length, 1);
});

test('background rotations skip actively delegated ASINs, and resume as soon as delegation expires', async t => {
  let delegated = new Set([known.asin]);
  const f = monitorFixture(t, { getDelegatedAsins: () => delegated });
  assert.equal((await f.monitor.scan({ lane: 'background' })).directCheckedCount, 0);
  assert.equal(f.signals.length, 0);
  delegated = new Set();
  assert.equal((await f.monitor.scan({ lane: 'background' })).directCheckedCount, 1);
  assert.equal(f.signals.length, 1);
});

test('slow notification delivery does not hold discovery; overlapping flushes send each entry once', async t => {
  const release = deferred(), entered = deferred();
  t.after(() => release.resolve());
  let sends = 0;
  const f = monitorFixture(t, { notify: async () => { sends++; entered.resolve(); await release.promise; } });
  await f.monitor.scan({ lane: 'background' });
  await entered.promise;
  await f.monitor.scan({ lane: 'search' });
  assert.equal(sends, 1);
  release.resolve();
  await f.monitor.flushNotifications();
  assert.equal(Object.keys(f.storage.pendingAvailabilityNotifications).length, 0);
});

test('HTTP background reads preserve the baseline on incomplete pages and honour Retry-After without browser fallback', async t => {
  const f = monitorFixture(t);
  delete f.monitor.loadPage;
  let status = 200, html = '<html>incomplete</html>', headers = {};
  let requests = 0, disposed = 0;
  f.monitor.browserPage = async () => ({});
  f.monitor.ensureJapanLocation = async () => {};
  f.monitor.ensureContext = async () => ({ request: { get: async () => {
    requests++;
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => { disposed++; } };
  } } });
  await assert.rejects(f.monitor.operations.run({ lane: 'background' }, () => f.monitor.loadPage('https://www.amazon.co.jp/dp/B0TEST0001')),
    { code: 'AMAZON_PRODUCT_UNREADABLE' });
  assert.equal(f.storage.products[known.asin].available, false);
  assert.ok(f.monitor.httpFallbacks.has('https://www.amazon.co.jp/dp/B0TEST0001'));
  status = 503; headers = { 'retry-after': '180' };
  await assert.rejects(f.monitor.operations.run({ lane: 'background' }, () => f.monitor.loadPage('https://www.amazon.co.jp/dp/B0TEST0002')),
    error => error.code === 'AMAZON_RATE_LIMITED' && error.retryAfterMs === 180_000 && error.httpStatus === 503);
  assert.equal(requests, 2);
  assert.equal(disposed, 2);
  assert.equal(f.storage.lastBackgroundDiagnostic.httpStatus, 503);
  assert.equal(f.monitor.httpFallbacks.has('https://www.amazon.co.jp/dp/B0TEST0002'), false);
});

test('a titled but incomplete HTTP page is not sold-out evidence, and HTTP 403 never triggers a rendering fallback', async t => {
  const f = monitorFixture(t);
  delete f.monitor.loadPage;
  let status = 200;
  f.monitor.browserPage = async () => ({});
  f.monitor.ensureJapanLocation = async () => {};
  f.monitor.ensureContext = async () => ({ request: { get: async () => ({
    status: () => status, headers: () => ({}),
    text: async () => `<html><body><span id="productTitle">${known.title}</span><div>loading</div></body></html>`,
    dispose: async () => {}
  }) } });
  await assert.rejects(f.monitor.loadProductHttp('https://www.amazon.co.jp/dp/B0TEST0001'), { code: 'AMAZON_PRODUCT_UNREADABLE' });
  assert.equal(f.storage.products[known.asin].available, false);
  status = 403;
  await assert.rejects(f.monitor.operations.run({ lane: 'background' }, () => f.monitor.loadPage('https://www.amazon.co.jp/dp/B0TEST0002')),
    { code: 'AMAZON_HTTP_REJECTED' });
  assert.equal(f.monitor.httpFallbacks.size, 0);
});

test('dedicated upcoming products retain their check even when old-product rotation is deferred', async t => {
  const f = monitorFixture(t);
  f.storage.manualProducts = { [known.asin]: { ...known, dedicatedUntilCatalog: true, manualMsrpYen: 1000 } };
  f.monitor.refreshCatalog = async () => [];
  const result = await f.monitor.scan({ lane: 'background', rotateBackground: false });
  assert.equal(result.dedicatedPendingCount, 1);
  assert.equal(result.directCheckedCount, 1);
  assert.equal(f.signals.length, 1);
});

test('concurrent discovery and background commits preserve both products and emit one signal per availability edge', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = monitorFixture(t);
  const newest = { ...known, asin: 'B0TEST0002', code: 'BX-53', title: 'BEYBLADE X BX-53 Fixture' };
  f.storage.catalog = [...catalog, { ...catalog[0], code: newest.code }];
  f.monitor.refreshCatalog = async () => f.storage.catalog;
  f.monitor.loadPage = async () => `<div data-component-type="s-search-result" data-asin="${newest.asin}"><h2>${newest.title}</h2><span class="a-price"><span class="a-offscreen">￥1000</span></span></div>`;
  f.monitor.verifyOffer = async product => {
    if (product.asin === known.asin) { entered.resolve(); await release.promise; }
    return { ...product, available: true, sellerConfirmed: true };
  };
  const background = f.monitor.scan({ lane: 'background' });
  await entered.promise;
  await f.monitor.scan({ lane: 'search' });
  assert.equal(f.storage.pendingDiscoveries[newest.asin].status, 'confirmed_available');
  release.resolve();
  await background;
  assert.equal(f.storage.products[newest.asin].available, true);
  assert.equal(f.storage.products[known.asin].available, true);
  assert.deepEqual(f.signals.sort(), [known.asin, newest.asin]);
  await f.monitor.scan({ lane: 'search' });
  assert.equal(f.signals.length, 2);
});

test('initial delivery-location setup respects real HTTP Retry-After before waiting for missing page controls', async t => {
  const f = monitorFixture(t);
  let waited = 0, requests = 0;
  const page = {
    goto: async () => { requests++; return { status: () => 503, headers: () => ({ 'retry-after': '180' }) }; },
    content: async () => '<html>busy</html>', title: async () => 'busy',
    locator: selector => selector === 'body' ? { innerText: async () => 'busy' }
      : { first: () => ({ waitFor: async () => { waited++; throw new Error('should not wait'); } }) }
  };
  await assert.rejects(f.monitor.ensureJapanLocation(page),
    error => error.code === 'AMAZON_RATE_LIMITED' && error.retryAfterMs === 180_000 && error.requestKind === 'location');
  assert.equal(requests, 1);
  assert.equal(waited, 0);
});
