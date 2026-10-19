import assert from 'node:assert/strict';
import test from 'node:test';
import { JAPAN_STORE_TARGETS, classifyJapanStoreUrl, ensureJapanStoreTargets, parseOcnList,
  parseOcnDetail, parseToysRUsProducts, parseNojimaProducts, readJapanStoreProducts, toysRUsDiscoveryUrls } from '../src/japan-stores.js';
import { JapanAuctionMonitor, japanAuctionFailureDelayMs } from '../src/japan-auctions.js';

const [ocn, nojima, toys] = JAPAN_STORE_TARGETS;
const json = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const empty = json({ '@type': 'ItemList', itemListElement: [] });
const response = (html, status = 200) => ({ status, text: async () => html });
const ocnList = (ids = ['TA1']) => `<span class="pager-total">全 ${ids.length}件</span>` + ids.map(id =>
  `<li class="block-thumbnail-t--item"><a href="/shop/g/g${id}/"><span class="block-thumbnail-t--goods-name">BEYBLADE X CX-20 ${id}</span><span class="block-thumbnail-t--price">6,600</span><img src="/img/${id}.jpg"></a></li>`).join('');
const ocnDetail = (id = 'TA1', availability = 'InStock', currency = 'JPY') => json({ '@type': 'Product', mpn: id,
  name: 'BEYBLADE X CX-20', offers: { price: 6600, priceCurrency: currency, availability: `https://schema.org/${availability}` } });
const tile = (stock = 'in_stock', enabled = true) => `<div class="product-tile" data-pid="12300" data-metadata='{"price":"6600","location_id":"${stock}"}'>
  <a itemprop="url" href="/ja-jp/123-12300.html"><span itemprop="name">BEYBLADE X CX-20</span></a>
  <div class="availability-container"></div>${enabled ? '<button class="add-to-cart-tile"></button>' : ''}</div>`;
function monitorFor(target, fetcher, saved = {}) {
  const notices = [];
  const state = { data: { commerce: { japanAuctions: { targets: { [target.id]: saved } } } }, save: async () => {} };
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [target], fetcher,
    notify: async (...args) => notices.push(args), log: () => {}, onAvailabilitySignal: () => { throw new Error('unexpected availability signal'); } });
  return { monitor, state, notices };
}

test('new store registration is idempotent and preserves disabled entries', () => {
  const targets = [{ ...ocn, enabled: false }];
  ensureJapanStoreTargets(targets); ensureJapanStoreTargets(targets);
  assert.equal(targets.length, 3); assert.equal(targets[0].enabled, false);
  assert.deepEqual(targets[2].focusKeywords, ['CX-20', 'BX-54']);
});
test('classification requires exact HTTPS official hosts and does not classify Amazon', () => {
  for (const target of JAPAN_STORE_TARGETS) assert.equal(classifyJapanStoreUrl(target.url).sourceType, target.sourceType);
  assert.equal(classifyJapanStoreUrl('https://www.amazon.co.jp/dp/B0HMGJCGVN'), null);
  assert.equal(classifyJapanStoreUrl(ocn.url.replace('https:', 'http:')), null);
  assert.equal(classifyJapanStoreUrl(ocn.url.replace('nttxstore.jp', 'nttxstore.jp.attacker.test')), null);
  assert.equal(classifyJapanStoreUrl(ocn.url.replace('https://', 'https://user:secret@')), null);
});
test('OCN listing is discovery only; detail confirms JPY stock and identity', () => {
  const [item] = parseOcnList(ocnList(), ocn.url);
  assert.equal(item.id, 'TA1'); assert.equal(item.available, null);
  assert.equal(parseOcnDetail(ocnDetail(), item).available, true);
  assert.equal(parseOcnDetail(ocnDetail('TA1', 'OutOfStock'), item).available, false);
  assert.throws(() => parseOcnDetail(ocnDetail('WRONG'), item));
  assert.throws(() => parseOcnDetail(ocnDetail('TA1', 'Unknown'), item));
  assert.throws(() => parseOcnDetail(ocnDetail('TA1', 'InStock', 'USD'), item));
  assert.throws(() => parseOcnList(ocnList().replace('全 1件', '全 2件'), ocn.url), /截斷/);
});
test('OCN detail reads have at most two workers and complete before returning', async () => {
  let active = 0, max = 0;
  const products = await readJapanStoreProducts(ocn, { fetcher: async url => {
    if (url === ocn.url) return response(ocnList(['TA1', 'TA2', 'TA3', 'TA4']));
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return response(ocnDetail(url.match(/g(TA\d+)\//)[1]));
  } });
  assert.equal(products.length, 4); assert.equal(max, 2); assert.equal(active, 0);
});
test('OCN incomplete batch never replaces persisted inventory baseline', async () => {
  const old = { initialized: true, products: { old: { title: 'BEYBLADE X BX-54', available: true } } };
  const { monitor } = monitorFor(ocn, async url => response(url === ocn.url ? ocnList(['TA1', 'TA2']) : '<html>broken</html>'), old);
  await assert.rejects(monitor.scanTarget(ocn));
  assert.deepEqual(monitor.status(ocn).products, old.products);
});
test('all three stores reject verification and redirects without browser fallback or alternate retry', async () => {
  for (const target of JAPAN_STORE_TARGETS) for (const [html, status] of [['Access Denied', 403], ['', 429], ['', 503], ['', 302], ['Just a moment', 200], ['', 200]]) {
    let calls = 0;
    await assert.rejects(readJapanStoreProducts(target, { fetcher: async () => { calls++; return response(html, status); } }));
    assert.equal(calls, 1);
  }
});
test('Toys cards distinguish unavailable and unknown from actual add-to-cart evidence', () => {
  assert.equal(parseToysRUsProducts(tile(), toys.url)[0].available, true);
  assert.equal(parseToysRUsProducts(tile('out_of_stock'), toys.url)[0].available, false);
  assert.equal(parseToysRUsProducts(tile('', false), toys.url)[0].available, null);
  assert.equal(parseToysRUsProducts(tile().replace('/ja-jp/123-12300.html', 'https://evil.test/123.html'), toys.url).length, 0);
});
test('Toys discovery prioritizes official CX-20 and BX-54 search, never guesses item IDs', () => {
  const urls = toysRUsDiscoveryUrls(toys);
  assert.deepEqual(urls.map(url => new URL(url).searchParams.get('q')), ['CX-20', 'BX-54', 'ベイブレード']);
});
test('Toys legitimate empty results are quiet, later discovery notifies; blank page preserves baseline', async () => {
  let html = empty;
  const state = { data: {}, save: async () => {} }, notices = [];
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [toys],
    fetcher: async () => response(html), log: () => {}, notify: async m => notices.push(m) });
  assert.equal((await monitor.scanTarget(toys)).checkedProducts, 0);
  assert.equal(notices.length, 0);
  html = tile(); assert.equal((await monitor.scanTarget(toys)).notified, 1);
  html = '<html>blank</html>'; await assert.rejects(monitor.scanTarget(toys));
  assert.equal(monitor.status(toys).products['12300'].available, true);
  assert.equal(notices.length, 1);
});
test('Toys keeps discovered official item URLs and directly checks missing search results', async () => {
  const old = { id: '12300', title: 'BEYBLADE X CX-20', url: 'https://www.toysrus.co.jp/ja-jp/123-12300.html', available: false };
  const urls = [];
  const rows = await readJapanStoreProducts(toys, { knownProducts: [old], fetcher: async url => {
    urls.push(url); return response(url === old.url ? json({ '@type': 'Product', sku: old.id, name: old.title,
      offers: { price: 6600, priceCurrency: 'JPY', availability: 'https://schema.org/InStock' } }) : empty);
  } });
  assert.equal(rows[0].available, true); assert.equal(urls.at(-1), old.url);
});
test('Nojima listing presence, lottery and secret sales cannot manufacture purchasable inventory', () => {
  const product = { '@type': 'Product', url: 'https://online.nojima.co.jp/commodity/1/4904810085553/', name: 'BEYBLADE X BX-52',
    offers: { price: 2300, priceCurrency: 'JPY', availability: 'https://schema.org/InStock' } };
  assert.equal(parseNojimaProducts(json(product), nojima.url)[0].available, true);
  assert.equal(parseNojimaProducts(json({ ...product, name: '【シークレット販売商品】BEYBLADE X BX-52' }), nojima.url)[0].available, false);
  assert.equal(parseNojimaProducts('<a>BEYBLADE X BX-52 ¥2300</a>', nojima.url).length, 0);
});
test('new stores back off instead of using Amazon cadence', () => {
  for (const target of JAPAN_STORE_TARGETS) {
    assert.ok(japanAuctionFailureDelayMs(target.sourceType, 1, 1) >= 60_000);
  }
});
