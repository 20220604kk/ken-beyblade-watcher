import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShopeeTitle, shopeeModelCodes, shopeeProductIdentity, classifyShopeeAccess,
  parseShopeeObservation, createShopeeState, reduceShopeeObservation, previewShopeeNotification
} from '../src/shopee-observations.js';

// SYNTHETIC data only. Known URL IDs are seeds, not live availability evidence.
const source = { id: 'shopee-funbox', shopId: '285705541', shopIdVerified: true };
const product = (patch = {}) => ({ productUrl: 'https://shopee.tw/product/285705541/50417252581',
  title: 'BEYBLADE X戰鬥陀螺XUX-21惡魔冥界改造組', ...patch });
const input = (seconds, items = [product()], patch = {}) => ({
  httpStatus: 200, finalUrl: 'https://shopee.tw/mall/search?keyword=beyblade&shop=285705541',
  observedAt: new Date(Date.UTC(2026, 8, 3, 0, 0, seconds)).toISOString(),
  scopeId: 'search:beyblade', coverage: 'complete', items, ...patch
});
const parsed = (...args) => parseShopeeObservation(input(...args), source);
const unavailable = () => product({ availability: 'unavailable', availabilityEvidence: 'unlisted-label' });
const available = () => product({ availability: 'available', availabilityEvidence: 'product-control' });
const advance = (state, ...args) => reduceShopeeObservation(state, parsed(...args), source);

test('canonical URL separates shop and item; strips tracking', () => {
  assert.deepEqual(shopeeProductIdentity('https://shopee.tw/product/285705541/50417252581?x=1'), {
    shopId: '285705541', itemId: '50417252581', productUrl: 'https://shopee.tw/product/285705541/50417252581'
  });
  assert.equal(shopeeProductIdentity('https://shopee.tw/UX-21-i.285705541.50417252581').itemId, '50417252581');
});
test('rejects non-Taiwan/host spoofing/credentials/short and listing URLs', () => {
  for (const url of ['https://shopee.tw.evil.test/product/1/2', 'https://evil.test/?url=https://shopee.tw/product/1/2',
    'http://shopee.tw/product/1/2', 'https://a:b@shopee.tw/product/1/2', 'https://shopee.tw/renmao',
    'https://tw.shp.ee/tbvV7Fbf', 'https://shopee.sg/product/1/2']) assert.equal(shopeeProductIdentity(url), null);
});
test('normalizes fullwidth and XUX adjacency without merging BX-00 variants', () => {
  assert.equal(normalizeShopeeTitle(' ＵＸ－０３　魔導神杖 '), 'UX-03 魔導神杖');
  assert.deepEqual(shopeeModelCodes('戰鬥陀螺XUX-03 BXG-04 UX–21 BX-001'), ['UX-03', 'BXG-04', 'UX-21']);
  assert.notEqual(shopeeProductIdentity('https://shopee.tw/product/1/2').itemId, shopeeProductIdentity('https://shopee.tw/product/1/3').itemId);
});
test('200 does not mean parsed; challenge path/text recognized', () => {
  assert.equal(classifyShopeeAccess({ httpStatus: 200 }), 'unverified-content');
  assert.equal(classifyShopeeAccess({ httpStatus: 200, finalUrl: 'https://shopee.tw/verify/traffic/error' }), 'blocked');
  assert.equal(classifyShopeeAccess({ httpStatus: 200, visibleText: '頁面無法顯示' }), 'blocked');
  assert.equal(classifyShopeeAccess({ httpStatus: 429 }), 'rate-limited');
  assert.equal(classifyShopeeAccess({ httpStatus: 401 }), 'auth-required');
  assert.equal(classifyShopeeAccess({ httpStatus: 403 }), 'blocked');
  assert.equal(classifyShopeeAccess({}), 'read-error');
});
test('unverified MM store identity cannot build baseline', () => {
  assert.equal(parseShopeeObservation(input(0), { id: 'shopee-mm', shopId: '11664018' }).health, 'configuration-error');
});
test('empty shell rejected, explicitly confirmed complete empty result accepted', () => {
  assert.equal(parsed(0, []).health, 'parse-error');
  assert.equal(parsed(0, [], { emptyResultVerified: true, coverage: 'partial' }).health, 'parse-error');
  assert.equal(parsed(0, [], { emptyResultVerified: true }).health, 'ready');
});
test('wrong-shop recommendations and inconsistent IDs reject snapshot', () => {
  assert.equal(parsed(0, [product({ productUrl: 'https://shopee.tw/product/999/123' })]).reason, 'wrong-shop-or-url');
  assert.equal(parsed(0, [product({ itemId: '1' })]).reason, 'identity-conflict');
});
test('unknown quantities and availability never become zero/true', () => {
  const p = parsed(0).products[0];
  assert.equal(p.availability, 'unknown'); assert.equal(p.quantity, null);
  assert.equal(parsed(1, [product({ availability: 'available', sold: 299, quantity: 299 })]).products[0].availability, 'unknown');
});
test('numeric stock needs evidence and scope; contradictory state degraded', () => {
  const raw = product({ availability: 'available', availabilityEvidence: 'variant-data', modelId: '123',
    quantity: 2, quantityEvidence: 'observed-count', quantityScope: 'selected-model' });
  assert.equal(parsed(0, [raw]).products[0].quantity, 2);
  assert.equal(parsed(0, [{ ...raw, quantity: 0 }]).products[0].availability, 'unknown');
  assert.equal(parsed(0, [{ ...raw, modelId: null }]).products[0].quantity, null);
  assert.equal(parsed(0, [product({ availability: 'available', availabilityEvidence: 'unlisted-label' })]).products[0].availability, 'unknown');
});
test('no fake model IDs, minimum range prices or unrelated FUNKO cards', () => {
  assert.equal(parsed(0, [product({ modelId: 'UX-21' })]).health, 'parse-error');
  assert.equal(parsed(0, [product({ priceTwd: 1, priceKind: 'range' })]).products[0].priceTwd, null);
  assert.equal(parsed(0, [product({ title: 'FUNKO POP 公仔' })]).products.length, 0);
});
test('duplicate candidates rejected rather than overwriting arbitrary stock', () => {
  assert.equal(parsed(0, [available(), unavailable()]).reason, 'duplicate-product-key');
});
test('first complete baseline is quiet; initial partial baseline not called complete', () => {
  let result = advance(createShopeeState(source), 0, [available()], { coverage: 'partial' });
  assert.equal(result.state.initialized, false); assert.equal(result.events.length, 0);
  result = advance(result.state, 1, [available()]);
  assert.equal(result.state.initialized, true); assert.equal(result.events.length, 0);
});
test('missing -> reappeared records visibility but waits for stock confirmation before notifying', () => {
  let s = advance(createShopeeState(source), 0).state;
  s = advance(s, 1, [], { emptyResultVerified: true }).state;
  const r = advance(s, 2);
  assert.equal(r.events[0].kind, 'reappeared');
  assert.equal(r.events[0].product.availability, 'unknown');
  assert.equal(previewShopeeNotification(r.events[0]), null);
});
test('fresh unavailable listing is announced as discovery without pretending it is a restock', () => {
  const s = advance(createShopeeState(source), 0, [], { emptyResultVerified: true }).state;
  const r = advance(s, 1, [unavailable()]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'first-seen');
  const preview = previewShopeeNotification(r.events[0], { test: false });
  assert.equal(preview.audience, 'public');
  assert.match(preview.content, /首次發現商品/);
  assert.match(preview.content, /目前不可購/);
  assert.doesNotMatch(preview.content, /恢復可購/);
});
test('failures never rewrite state or cause phantom disappearance/reappearance', () => {
  let s = advance(createShopeeState(source), 0, [available()]).state;
  for (const patch of [{ httpStatus: 403 }, { httpStatus: 429 }, { httpStatus: 200, visibleText: '頁面無法顯示' }, { httpStatus: null }]) {
    const r = advance(s, 1, [], patch); assert.strictEqual(r.state, s); assert.equal(r.events.length, 0);
  }
  const r = advance(s, 2, [available()]); assert.equal(r.events.length, 0);
});
test('partial/secondary search omission never marks primary product missing', () => {
  const s = advance(createShopeeState(source), 0, [available()]).state;
  const other = product({ productUrl: 'https://shopee.tw/product/285705541/24620298578', title: 'XUX-03 魔導神杖' });
  for (const patch of [{ coverage: 'partial' }, { scopeId: 'search:戰鬥陀螺' }]) {
    const r = advance(s, 1, [other], patch);
    assert.equal(Object.values(r.state.records).find(p => p.itemId === '50417252581').primaryVisibility, 'visible');
  }
});
test('same listing from two searches is not announced twice', () => {
  let s = advance(createShopeeState(source), 0, [], { emptyResultVerified: true }).state;
  const first = advance(s, 1, [available()]); assert.equal(first.events.length, 1);
  const second = advance(first.state, 2, [available()], { scopeId: 'search:戰鬥陀螺' }); assert.equal(second.events.length, 0);
});
test('two distinct 0->1 restocks survive unknown scans and no cooldown', () => {
  let s = advance(createShopeeState(source), 0, [unavailable()]).state;
  let r = advance(s, 1, [available()]); assert.equal(r.events[0].kind, 'restock'); const id = r.events[0].eventId;
  r = advance(r.state, 2, [unavailable()]); assert.equal(r.events.length, 0);
  r = advance(r.state, 3, [product()]); assert.equal(r.events.length, 0);
  r = advance(r.state, 4, [available()]); assert.equal(r.events[0].kind, 'restock'); assert.notEqual(r.events[0].eventId, id);
});
test('fresh listing with verified availability produces only one event', () => {
  const s = advance(createShopeeState(source), 0, [], { emptyResultVerified: true }).state;
  assert.equal(advance(s, 1, [available()]).events.length, 1);
});
test('out-of-order results and replays cannot overwrite fresh state', () => {
  const s = advance(createShopeeState(source), 10, [available()]).state;
  for (const time of [9, 10]) assert.strictEqual(advance(s, time, [unavailable()]).state, s);
});
test('JSON state roundtrip preserves dedup and does not mutate caller state', () => {
  const initial = createShopeeState(source); const before = JSON.stringify(initial);
  const s = advance(initial, 0, [unavailable()]).state; assert.equal(JSON.stringify(initial), before);
  const restored = JSON.parse(JSON.stringify(advance(s, 1, [available()]).state));
  assert.equal(advance(restored, 2, [available()]).events.length, 0);
});
test('state/source mismatch is rejected', () => {
  assert.throws(() => reduceShopeeObservation(createShopeeState(source), parsed(1), { ...source, id: 'shopee-mm' }), /mismatch/);
});
test('explicit routes, private test default, MM unavailable and soldout suppressed', () => {
  const e = advance(advance(createShopeeState(source), 0, [unavailable()]).state, 1, [available()]).events[0];
  assert.equal(previewShopeeNotification(e).audience, 'private');
  assert.equal(previewShopeeNotification(e, { test: false }).audience, 'public');
  assert.equal(previewShopeeNotification({ ...e, sourceId: 'shopee-mm' }, { test: false }).audience, 'mmtoy');
  assert.equal(previewShopeeNotification({ ...e, sourceId: 'shopee-mm', product: { ...e.product, availability: 'unknown' } }), null);
  assert.equal(previewShopeeNotification({ ...e, kind: 'sold-out' }), null);
  assert.throws(() => previewShopeeNotification({ ...e, sourceId: 'typo' }), /Unknown notification source/);
});
test('variant recovery identifies correct variant and unknown quantity is explicit', () => {
  const model = (id, state) => product({ modelId: id, modelName: `規格 ${id}`, availability: state, availabilityEvidence: 'variant-data' });
  const s = advance(createShopeeState(source), 0, [model('1', 'unavailable'), model('2', 'unavailable')]).state;
  const r = advance(s, 1, [model('1', 'unavailable'), model('2', 'available')]);
  assert.equal(r.events.length, 1); assert.equal(r.events[0].product.modelId, '2');
  assert.match(previewShopeeNotification(r.events[0]).content, /規格 2/);
  assert.match(previewShopeeNotification(r.events[0]).content, /數量未公開/);
});

test('aggregate stock is not falsely attached to one variant', () => {
  const raw = product({ modelId: '1', quantity: 12, quantityScope: 'product-total', quantityEvidence: 'observed-count' });
  assert.equal(parsed(0, [raw]).products[0].quantity, null);
});
test('off-origin or missing final URL never counts as valid scan', () => {
  for (const finalUrl of ['', 'https://other.test/search', 'http://shopee.tw/search']) {
    assert.equal(parsed(0, [available()], { finalUrl }).reason, 'unexpected-final-origin');
  }
});
test('reappearance awaiting availability can confirm once without repeated detail spam', () => {
  let s = advance(createShopeeState(source), 0, [available()]).state;
  s = advance(s, 1, [], { emptyResultVerified: true }).state;
  const reappearance = advance(s, 2, [product()]);
  assert.equal(reappearance.events[0].kind, 'reappeared');
  const confirmed = advance(reappearance.state, 3, [available()], { scopeId: 'detail:50417252581' });
  assert.equal(confirmed.events[0].kind, 'availability-confirmed');
  s = advance(confirmed.state, 4, [product()]).state;
  assert.equal(advance(s, 5, [available()], { scopeId: 'detail:50417252581' }).events.length, 0);
});
test('list without variant breakdown does not remove model membership', () => {
  const variant = product({ modelId: '123', availability: 'unavailable', availabilityEvidence: 'variant-data' });
  const s = advance(createShopeeState(source), 0, [variant]).state;
  const r = advance(s, 1, [product()]);
  assert.equal(Object.values(r.state.records).find(p => p.modelId === '123').primaryVisibility, 'visible');
});

// Visible labels/paths observed on 2026-09-04; HTTP values below are synthetic.
// These are regression inputs, not evidence of a successful live collector.
test('explicit login-required traffic page is distinguished from CAPTCHA without needing HTTP status', () => {
  const gate = { finalUrl: 'https://shopee.tw/verify/traffic/error',
    visibleText: '請登入\n看起來您尚未登入。請登入以繼續，或返回首頁。' };
  assert.equal(classifyShopeeAccess(gate), 'auth-required');
  assert.equal(classifyShopeeAccess({ ...gate, httpStatus: 200 }), 'auth-required');
});

test('logged-in traffic error is still blocked, never ready based on URL login flag', () => {
  assert.equal(classifyShopeeAccess({
    finalUrl: 'https://shopee.tw/verify/traffic/error?is_logged_in=true',
    visibleText: '頁面無法顯示\n發生錯誤！請返回再試一次或回到主頁。'
  }), 'blocked');
});

test('challenge evidence and rate limits take precedence over login labels', () => {
  const gate = { finalUrl: 'https://shopee.tw/verify/traffic/error',
    visibleText: '看起來您尚未登入。請登入以繼續' };
  assert.equal(classifyShopeeAccess({ ...gate, httpStatus: 429 }), 'rate-limited');
  assert.equal(classifyShopeeAccess({ ...gate, httpStatus: 403 }), 'blocked');
  assert.equal(classifyShopeeAccess({ ...gate, finalUrl: 'https://shopee.tw/verify/captcha' }), 'blocked');
  assert.equal(classifyShopeeAccess({ ...gate, visibleText: `${gate.visibleText}\n驗證目前無法完成` }), 'blocked');
});

test('login link in normal search header does not itself reject accessible product content', () => {
  assert.equal(classifyShopeeAccess({ httpStatus: 200,
    finalUrl: 'https://shopee.tw/mall/search?keyword=beyblade&shop=285705541',
    visibleText: '註冊 登入 在此賣場搜尋 beyblade'
  }), 'unverified-content');
});

test('both observed access failures preserve baseline even if stale product cards are supplied', () => {
  const initial = advance(createShopeeState(source), 0, [available()]).state;
  for (const visibleText of ['看起來您尚未登入。請登入以繼續，或返回首頁。', '頁面無法顯示']) {
    const observation = parsed(1, [unavailable()], {
      httpStatus: undefined, finalUrl: 'https://shopee.tw/verify/traffic/error', visibleText
    });
    assert.equal(observation.baselineWritable, false);
    const r = reduceShopeeObservation(initial, observation, source);
    assert.strictEqual(r.state, initial);
    assert.deepEqual(r.events, []);
  }
});

test('non-Beyblade card from the observed FUNBOX result cannot trigger a restock notification', () => {
  const s = advance(createShopeeState(source), 0, [], { emptyResultVerified: true }).state;
  const observation = parsed(1, [{
    productUrl: 'https://shopee.tw/product/285705541/58013449584',
    title: 'T-SPARK QV-04 回到未來 DXセット TC99728'
  }], { coverage: 'partial' });
  assert.equal(observation.ignored, 1);
  assert.deepEqual(observation.products, []);
  assert.deepEqual(reduceShopeeObservation(s, observation, source).events, []);
});
