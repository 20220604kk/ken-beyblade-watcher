import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AmazonJapanMonitor, parseAmazonSellerSearch, amazonJapanNotification } from '../src/amazon-jp-monitor.js';
import { AMAZON_INVENTORY_SEEDS, amazonInventoryNextDelay } from '../src/amazon-inventory.js';
import { retailAod } from './fixtures/amazon-aod-fixtures.js';

const rows = [1, 2, 3, 4].map(n => ({ asin: `B0TEST000${n}`, code: `BX-0${n}`, title: `BEYBLADE X BX-0${n} Fixture` }));
const card = (p, price = '') => `<div data-component-type="s-search-result" data-asin="${p.asin}"><h2>${p.title}</h2>${price ? `<span class="a-price"><span class="a-offscreen">${price}</span></span>` : ''}</div>`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const storage = options.storage || { initialized: true, searchDiscoveryVersion: 1, products: Object.fromEntries(rows.map(p => [p.asin, { ...p, available: false }])) };
  const state = { data: { commerce: { amazonJp: storage } }, save: async () => {}, writeSnapshot: async () => {} };
  const calls = [], signals = [], notifications = [], urls = [], delegated = new Set();
  const config = { enabled: true, watchProducts: [rows[0]], watchBatchSize: 5, backgroundBatchSize: 1 };
  const monitor = new AmazonJapanMonitor({ dataDir: '.', state, continuousInventory: true, inventorySeeds: [],
    getConfig: () => config, getDelegatedAsins: () => delegated,
    notify: options.notify || (async () => { notifications.push('sent'); }),
    onAvailabilitySignal: p => signals.push(p.asin) });
  monitor.ensureSeedSignals = async () => {};
  monitor.loadPage = async url => { urls.push(url); return card({ asin: 'B0OTHER001', title: 'Accessory' }, '￥1'); };
  monitor.verifyOffer = async p => { calls.push(p.asin); return { ...p, available: true, sellerConfirmed: true, priceYen: 1234, pricingSource: 'amazon_retail_aod' }; };
  t.after(() => monitor.close());
  return { monitor, storage, config, calls, signals, notifications, urls, delegated, scan: () => monitor.scan({ lane: 'background' }), search: () => monitor.scan({ lane: 'search' }) };
}

test('continuous full inventory visits every ASIN once per cycle; configured watch cannot monopolize it', async t => {
  const f = fixture(t); f.storage.inventoryAttempts = { [rows[0].asin]: { at: new Date().toISOString() } };
  for (let n = 0; n < rows.length; n++) await f.scan();
  assert.deepEqual(f.calls, [rows[1].asin, rows[2].asin, rows[3].asin, rows[0].asin]);
  assert.equal(f.storage.lastInventoryCycle.checked, 4); assert.equal(f.storage.lastInventoryCycle.successful, 4);
  assert.equal(f.storage.lastInventoryCycle.registryCount, 4); assert.ok(f.storage.lastInventoryCycle.durationMs >= 0);
  await f.scan(); assert.equal(f.calls[4], rows[1].asin); assert.equal(f.signals.length, 4);
});

test('search without price and with marketplace price grows persistent inventory, never trusts search stock or price', async t => {
  const f = fixture(t, { storage: { initialized: true, searchDiscoveryVersion: 1, products: {} } });
  f.config.watchProducts = []; f.monitor.loadPage = async () => rows.map((p, i) => card(p, i ? '￥999999' : '')).join('');
  assert.equal(parseAmazonSellerSearch(card(rows[0]))[0].available, false);
  await f.search(); assert.equal(Object.keys(f.storage.productRegistry).length, 4);
  assert.equal(f.calls.length, 2); assert.equal(f.storage.products[rows[0].asin].priceYen, 1234);
  assert.equal(f.storage.products[rows[2].asin], undefined); assert.equal(f.storage.productRegistry[rows[2].asin].priceYen, undefined);
  f.monitor.loadPage = async () => card({ asin: 'B0OTHER001', title: 'Accessory' }); await f.search();
  assert.equal(Object.keys(f.storage.productRegistry).length, 4); assert.match(f.storage.lastSearchWarning, /沒有/);
  const persisted = structuredClone(f.storage), restarted = fixture(t, { storage: persisted }); restarted.config.watchProducts = [];
  await restarted.scan(); assert.equal(restarted.calls[0], rows[2].asin);
  assert.equal(restarted.monitor.status().inventoryProducts.length, 4);
});

test('discovery always checks first page without seller filter and rotates deeper pages without losing partial discoveries', async t => {
  const f = fixture(t); let newer = 0;
  f.monitor.loadPage = async url => {
    f.urls.push(url); const page = new URL(url).searchParams.get('page');
    if (page === '2') return card({ ...rows[0], asin: 'B0NEW00001' });
    if (page === '3') throw Error('secondary page unavailable');
    return card({ ...rows[1], asin: 'B0NEW00002', title: `BEYBLADE X BX-02 ${++newer}` });
  };
  for (let n = 0; n < 5; n++) await f.search();
  await assert.rejects(f.search(), /secondary/);
  assert.equal(f.urls.filter(url => !new URL(url).searchParams.has('page')).length, 6);
  assert.ok(f.urls.every(url => !new URL(url).searchParams.has('rh')));
  assert.deepEqual(f.urls.map(url => new URL(url).searchParams.get('page')).filter(Boolean), ['2', '3']);
  assert.ok(f.storage.productRegistry.B0NEW00001); assert.match(f.storage.productRegistry.B0NEW00002.title, /6$/);
});

test('seed metadata adds all 12 supplied ASINs without stock assumptions, duplicates, or overwriting newer discovered names', async t => {
  const f = fixture(t, { storage: { products: {} } }); f.config.watchProducts = []; f.monitor.inventorySeeds = AMAZON_INVENTORY_SEEDS;
  const registry = f.monitor.inventoryRegistry(); assert.equal(registry.length, 12);
  assert.equal(Object.keys(f.storage.products).length, 0); assert.equal(f.signals.length, 0);
  for (const row of registry) { assert.equal(row.available, undefined); assert.equal(row.priceYen, undefined); }
  const p = AMAZON_INVENTORY_SEEDS[0]; f.monitor.registerInventoryProduct({ ...p, title: `${p.title} UPDATED` }, 'web_search');
  f.monitor.inventoryRegistry(); assert.match(f.storage.productRegistry[p.asin].title, /UPDATED$/);
  assert.equal(Object.keys(f.storage.productRegistry).length, 12); assert.equal(f.monitor.status().inventory.neverVerified, 12);
});

test('partial AOD and 404 defer only that ASIN, preserve stock baseline, and continue others', async t => {
  const f = fixture(t); const baseline = f.storage.products[rows[0].asin]; let first = true;
  f.monitor.verifyOffer = async p => { f.calls.push(p.asin); if (first) { first = false; throw Object.assign(Error('not found'), { code: 'AMAZON_PRODUCT_NOT_FOUND', httpStatus: 404 }); } throw Object.assign(Error('partial'), { code: 'AMAZON_PRODUCT_UNREADABLE', httpStatus: 200 }); };
  await f.scan(); assert.equal(f.storage.products[rows[0].asin], baseline);
  assert.ok(Date.parse(f.storage.inventoryAttempts[rows[0].asin].retryAt) - Date.now() > 299000);
  await f.scan(); await f.scan(); await f.scan();
  assert.equal(new Set(f.calls).size, 4); assert.equal(f.storage.lastInventoryCycle.failed, 4); assert.equal(f.signals.length, 0);
  await f.scan(); assert.equal(f.calls.length, 4, 'no eligible ASIN: no HTTP burst during per-product cooldown');
  assert.equal(f.storage.lastInventoryCycle.failed, 4, 'idle heartbeat must not replace the last real sweep with an empty success');
  assert.equal(f.monitor.status().inventory.failedCount, 4); assert.equal(f.monitor.status().inventory.deferredCount, 4);
});

for (const status of [429, 503]) test(`real AOD HTTP ${status} stops the turn and respects Retry-After without erasing data`, async t => {
  const f = fixture(t), old = f.storage.products[rows[0].asin]; let reads = 0;
  f.monitor.browserPage = async () => ({}); f.monitor.ensureJapanLocation = async () => {};
  f.monitor.verifyOffer = AmazonJapanMonitor.prototype.verifyOffer;
  f.monitor.ensureContext = async () => ({ request: { fetch: async () => { reads++; return { status: () => status, headers: () => ({ 'retry-after': '180' }), text: async () => '', dispose: async () => {} }; } } });
  await assert.rejects(f.scan(), e => e.code === 'AMAZON_RATE_LIMITED' && amazonInventoryNextDelay(0, 20, e) === 180000);
  assert.equal(reads, 1); assert.equal(f.storage.products[rows[0].asin], old); assert.equal(f.storage.inventoryCycle.checked, 0);
});

for (const options of [{ seller: 'OTHER' }, { condition: '中古品' }, { available: false }, {}]) test(`production inventory enforces actual AOD contract ${JSON.stringify(options)}`, async t => {
  const f = fixture(t); f.monitor.browserPage = async () => ({}); f.monitor.ensureJapanLocation = async () => {};
  f.monitor.verifyOffer = AmazonJapanMonitor.prototype.verifyOffer;
  f.monitor.ensureContext = async () => ({ request: { fetch: async (url, request) => {
    assert.equal(request.method, 'GET'); assert.match(url, /aodAjaxMain/);
    const asin = new URL(url).searchParams.get('asin'); return { status: () => 200, headers: () => ({}), text: async () => retailAod({ asin, ...options }), dispose: async () => {} };
  } } });
  await f.scan(); const available = !Object.keys(options).length;
  assert.equal(f.storage.products[rows[0].asin].available, available); assert.equal(f.signals.length, available ? 1 : 0);
  assert.equal(f.storage.inventoryAttempts[rows[0].asin].status, 'ok');
});

test('stalled discovery and Discord cannot block full-inventory polling or replay the same available observation', async t => {
  const searchGate = deferred(), discordGate = deferred(), started = deferred();
  t.after(() => { searchGate.resolve(card(rows[0])); discordGate.resolve(); });
  const f = fixture(t, { notify: () => discordGate.promise });
  f.monitor.loadPage = async () => { started.resolve(); return searchGate.promise; };
  const search = f.search(); await started.promise;
  for (let n = 0; n < 5; n++) await f.scan();
  assert.equal(f.signals.length, 4); assert.equal(f.storage.lastInventoryCycle.checked, 4);
  searchGate.resolve(card(rows[0])); await search; assert.equal(f.signals.length, 4);
  discordGate.resolve(); await f.monitor.notificationPromise;
  assert.equal(f.storage.notificationSentCount, 4); assert.equal(Object.keys(f.storage.pendingAvailabilityNotifications).length, 0);
});

test('cancel while AOD is in flight cannot overwrite inventory or deliver stale purchase signals', async t => {
  const gate = deferred(), started = deferred(), f = fixture(t);
  f.monitor.verifyOffer = async p => { started.resolve(); await gate.promise; return { ...p, available: true }; };
  const scan = f.scan(); await started.promise; await f.monitor.close(); gate.resolve();
  await assert.rejects(scan, e => e.code === 'AMAZON_READ_CANCELLED');
  assert.equal(f.storage.products[rows[0].asin].available, false); assert.equal(f.signals.length, 0);
});

test('healthy delegated single tasks are skipped temporarily, failed/stopped tasks return to fair full sweep', async t => {
  const f = fixture(t); f.delegated.add(rows[0].asin);
  for (let n = 0; n < 3; n++) await f.scan();
  assert.equal(f.storage.lastInventoryCycle.delegated, 1); assert.ok(!f.calls.includes(rows[0].asin));
  f.delegated.clear(); await f.scan(); assert.equal(f.calls[3], rows[0].asin);
});

test('notification removed explanation lines in both normal and test mode; scheduler measures one-second activity without parallel catch-up', async () => {
  for (const mock of [false, true]) {
    const msg = amazonJapanNotification({ ...rows[0], url: 'https://www.amazon.co.jp/dp/' + rows[0].asin, priceYen: 1000 }, { test: mock, xConfirmed: true });
    assert.doesNotMatch(JSON.stringify(msg), /價格依據：|販售者：|交叉驗證：/);
    assert.match(JSON.stringify(msg), /1,000/);
  }
  assert.equal(amazonInventoryNextDelay(0, 100), 900); assert.equal(amazonInventoryNextDelay(0, 1800), 100);
  assert.equal(amazonInventoryNextDelay(0, 10, Error('ordinary')), 1990);
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const scheduler = source.slice(source.indexOf('function scheduleAmazonJpBackground'), source.indexOf('async function runAmazonJpScan'));
  assert.doesNotMatch(scheduler, /RotationAt|rotateBackground|30_000/); assert.match(source, /continuousInventory: true/);
});

test('inventory UI exposes failures, real sweep timing and escaped public titles without treating an old quote as current', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderAmazonJp(s){'), source.indexOf('function renderAmazonProductOrderLegacy'));
  const elements = new Map(), document = { querySelector: key => { if (!elements.has(key)) elements.set(key, {}); return elements.get(key); } };
  vm.runInNewContext(render + ';renderAmazonJp(data);', { document, amazonJpDirty: false, esc: s => String(s).replaceAll('<', '&lt;'), fmt: s => s,
    data: { japanAuctions: { amazonJp: { continuousInventory: true, inventory: { trackedCount: 1, failedCount: 1, lastCycle: { checked: 1, durationMs: 12345 } },
      inventoryProducts: [{ ...rows[0], title: '<img onerror=bad>', available: true, priceYen: 1234, lastOfferCheckedAt: 'OLD', attempt: { status: 'failed', errorCode: 'AMAZON_HTTP_TIMEOUT', httpStatus: 0 } }] } } } });
  const html = elements.get('#amazon-jp-inventory-products').innerHTML;
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img onerror/); assert.match(html, /讀取失敗（保留前值）/); assert.match(html, /OLD/);
  assert.match(elements.get('#amazon-jp-summary').textContent, /12.3 秒/);
});
