import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const product = (index, available = false, code = `BX-${String(index).padStart(2, '0')}`) => ({
  id: String(10042014802683000000n + BigInt(index)),
  title: `BEYBLADE X戰鬥陀螺 ${code}`,
  url: `https://www.eslite.com/product/${10042014802683000000n + BigInt(index)}`,
  available, variants: [], status: available ? 'add_to_shopping_cart' : 'unavailable',
  availabilitySource: 'eslite-purchase-status'
});
function fixture(products, settings = {}, options = {}) {
  const target = { id: 'eslite-test', name: '誠品測試', enabled: true, sourceType: 'eslite-keywords',
    url: 'https://www.eslite.com/Search?keyword=BEYBLADE', keywords: [], discoveryUrls: [] };
  const state = { data: { commerce: { shoppingSites: { targets: { [target.id]: {
    initialized: true, seen: Object.fromEntries(products.map(item => [item.id, item]))
  } } } } }, async save() {} };
  const events = [], notices = [], calls = [];
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target],
    getEslitePurchaseSettings: () => ({ buyMode: 'whitelist', buyKeywords: ['BX', 'UX', 'CX'], ...settings }),
    fetcher: async () => { throw new Error('測試禁止連線'); },
    notify: async text => { notices.push(text); }, onPurchaseCandidate: item => events.push(item.id), ...options });
  monitor.verifyEsliteProduct = async item => { calls.push(item.id); return { ...item }; };
  const trigger = (item = products[0]) => monitor.applyImmediateEsliteObservations(target,
    [{ ...item, available: true, status: 'add_to_shopping_cart' }], { source: 'exhibition-page->官方可購狀態' });
  return { monitor, target, state, events, notices, calls, trigger,
    saved: () => state.data.commerce.shoppingSites.targets[target.id],
    finish: () => Promise.all([...monitor.esliteBaselineSweeps.values()]) };
}

test('第一拍先派送，背景補查找到索引外舊款；缺貨和原有現貨不假報補貨', async () => {
  const items = [product(1), product(2), product(3), product(4, true)];
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.monitor.verifyEsliteProduct = async (item, options) => {
    assert.equal(options.apiOnly, true);
    f.calls.push(item.id);
    await gate;
    return { ...item, available: item.id !== items[2].id };
  };
  try {
    f.trigger();
    assert.deepEqual(f.events, [items[0].id]);
    assert.deepEqual(f.calls, []);
    await tick();
    assert.equal(f.calls.length, 2);
    release();
    await f.finish();
    assert.deepEqual(f.events, [items[0].id, items[1].id]);
    assert.equal(f.saved().esliteBaselineSweep.newlyAvailable, 1);
    assert.equal(f.saved().esliteBaselineSweep.checked, 3);
    assert.equal(f.notices.length, 2);
  } finally { release(); await f.monitor.close(); }
});

test('補查依白名單、黑名單與優先詞排序；冷卻合併訊號，不被自身結果遞迴觸發', async () => {
  const items = [product(1), product(2), product(3), product(4), product(5)];
  const f = fixture(items, { buyKeywords: ['BX-02', 'BX-03', 'BX-04'], skipBuyKeywords: ['BX-03'], priorityKeywords: ['BX-04'] });
  try {
    f.trigger();
    await f.finish();
    assert.deepEqual(f.calls, [items[3].id, items[1].id]);
    f.trigger(items[4]);
    await tick();
    assert.equal(f.calls.length, 2);
    f.monitor.esliteBaselineLastStarted.set(f.target.id, Date.now() - 60_001);
    for (const item of Object.values(f.saved().seen)) item.lastObservationAt = '2020-01-01T00:00:00.000Z';
    assert.equal(f.monitor.startEsliteBaselineSweep(f.target, items[0]), true);
    await f.finish();
    assert.equal(f.calls.length, 4);
  } finally { await f.monitor.close(); }
});

test('補查最多兩路，總驗證最多四路，策展新商品不必等待補查', async () => {
  const items = Array.from({ length: 9 }, (_, index) => product(index + 1));
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0, maxActive = 0, maxBaseline = 0;
  f.monitor.verifyEsliteProduct = async (item, options) => {
    active++;
    maxActive = Math.max(maxActive, active);
    maxBaseline = Math.max(maxBaseline, f.monitor.esliteBaselineVerificationActive);
    f.calls.push(item.id);
    if (options.apiOnly) await gate;
    active--;
    return { ...item };
  };
  try {
    f.trigger();
    await tick();
    assert.equal(active, 2);
    const fresh = product(90);
    await f.monitor.queueEsliteVerification(f.target, fresh, 'exhibition-page');
    assert.ok(f.calls.includes(fresh.id));
    assert.equal(active, 2);
    release();
    await f.finish();
    assert.ok(maxActive <= 4);
    assert.ok(maxBaseline <= 2);
  } finally { release(); await f.monitor.close(); }
});

test('四路忙碌時等待中的驗證按照策展、搜尋、基線優先，不超出四路', async () => {
  const f = fixture([product(1)]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  f.monitor.verifyEsliteProduct = async item => {
    active++;
    maximum = Math.max(maximum, active);
    f.calls.push(item.id);
    if (Number(BigInt(item.id) - 10042014802683000000n) < 10) await gate;
    active--;
    return { ...item };
  };
  try {
    const running = [2, 3, 4, 5].map(index => f.monitor.queueEsliteVerification(f.target, product(index), 'search-page'));
    const baseline = f.monitor.queueEsliteVerification(f.target, product(80), 'baseline-sweep', () => {},
      { baselineSweep: { deadline: Date.now() + 30_000 } });
    const search = f.monitor.queueEsliteVerification(f.target, product(81), 'search-page');
    const exhibit = f.monitor.queueEsliteVerification(f.target, product(82), 'exhibition-page');
    release();
    await Promise.all([...running, baseline, search, exhibit]);
    assert.deepEqual(f.calls.slice(4), [product(82).id, product(81).id, product(80).id]);
    assert.equal(maximum, 4);
  } finally { release(); await f.monitor.close(); }
});

test('未初始化／缺貨／穩定現貨不觸發補查，沒有白名單也不額外發請求', async () => {
  const items = [product(1), product(2)];
  const f = fixture(items, { buyKeywords: [] });
  try {
    f.saved().initialized = false;
    f.trigger();
    assert.equal(f.monitor.esliteBaselineSweeps.size, 0);
    f.saved().initialized = true;
    f.trigger();
    assert.equal(f.monitor.esliteBaselineSweeps.size, 0);
    f.monitor.applyImmediateEsliteObservations(f.target, [items[1]], { source: 'exhibition-page' });
    assert.equal(f.monitor.esliteBaselineSweeps.size, 0);
    assert.deepEqual(f.calls, []);
  } finally { await f.monitor.close(); }
});

test('API 逾時／回傳 429／404 保留基線，不開瀏覽器、不產生購買候選', async () => {
  const items = [product(1), product(2, true), product(3), product(4)];
  const f = fixture(items);
  f.monitor.verifyEsliteProduct = ShoppingSiteMonitor.prototype.verifyEsliteProduct.bind(f.monitor);
  let browsers = 0;
  f.monitor.browserLauncher = async () => { browsers++; throw new Error('不可啟動'); };
  f.monitor.requestEslitePurchaseStatus = async (_url, item) => {
    if (item.id === items[1].id) throw new Error('read timeout');
    return { ok: false, status: item.id === items[2].id ? 429 : 404, async dispose() {} };
  };
  try {
    f.trigger();
    await f.finish();
    assert.equal(f.saved().seen[items[1].id].available, true);
    assert.equal(f.saved().seen[items[2].id].available, false);
    assert.equal(f.saved().esliteBaselineSweep.unknown, 3);
    assert.deepEqual(f.events, [items[0].id]);
    assert.equal(browsers, 0);
  } finally { await f.monitor.close(); }
});

test('時間上限阻止後續請求，但已送出的唯讀回應仍可完成核對', async () => {
  const items = [product(1), product(2), product(3), product(4)];
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.monitor.verifyEsliteProduct = async item => { f.calls.push(item.id); await gate; return { ...item }; };
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  try {
    f.trigger();
    await tick();
    clock += 30_001;
    release();
    await f.finish();
    assert.equal(f.calls.length, 2);
    assert.equal(f.saved().esliteBaselineSweep.skipped, 1);
    assert.equal(f.saved().esliteBaselineSweep.status, 'time_limit');
    assert.deepEqual(f.events, [items[0].id]);
  } finally { Date.now = originalNow; release(); await f.monitor.close(); }
});

test('來源僅顯示待確認不跳過補查，已取得的官方新觀測則不重查', async () => {
  const items = [product(1), product(2), product(3)];
  const f = fixture(items);
  try {
    f.trigger();
    f.monitor.applyImmediateEsliteObservations(f.target,
      [{ ...items[1], available: null, variants: [], status: 'verification_pending' }], { source: 'search-page' });
    f.monitor.applyImmediateEsliteObservations(f.target,
      [{ ...items[2], available: true, status: 'add_to_shopping_cart' }], { source: 'exhibition-page->官方可購狀態' });
    await f.finish();
    assert.deepEqual(f.calls, [items[1].id]);
    assert.equal(f.saved().esliteBaselineSweep.skipped, 1);
  } finally { await f.monitor.close(); }
});

test('搜尋／策展同時確認同一商品時共用驗證結果，不重複派單', async () => {
  const items = [product(1), product(2)];
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.monitor.verifyEsliteProduct = async item => { f.calls.push(item.id); await gate; return { ...item, available: true }; };
  try {
    f.trigger();
    await tick();
    const joined = f.monitor.queueEsliteVerification(f.target, items[1], 'search-page');
    release();
    await joined;
    await f.finish();
    assert.deepEqual(f.calls, [items[1].id]);
    assert.deepEqual(f.events, items.map(item => item.id));
    assert.equal(f.monitor.esliteBaselineSweeps.size, 0);
  } finally { release(); await f.monitor.close(); }
});

test('完整掃描返回舊基線時不能覆蓋背景補查新證據', async () => {
  const items = [product(1), product(2)];
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.monitor.verifyEsliteProduct = async item => ({ ...item, available: true });
  f.monitor.loadEsliteKeywordProducts = async () => {
    f.trigger();
    await f.finish();
    await gate;
    return items;
  };
  try {
    const scan = f.monitor.scan();
    await tick();
    release();
    await scan;
    assert.equal(f.saved().seen[items[1].id].available, true);
    assert.equal(f.saved().esliteBaselineSweep.newlyAvailable, 1);
    assert.deepEqual(f.events, items.map(item => item.id));
  } finally { release(); await f.monitor.close(); }
});

test('停止時不再補查剩餘基線，已在途回應也不再交接派單', async () => {
  const items = Array.from({ length: 6 }, (_, index) => product(index + 1));
  const f = fixture(items);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.monitor.verifyEsliteProduct = async item => { f.calls.push(item.id); await gate; return { ...item, available: true }; };
  f.trigger();
  await tick();
  const closing = f.monitor.close();
  release();
  await closing;
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.events, [items[0].id]);
  assert.equal(f.saved().esliteBaselineSweep.status, 'stopped');
});

test('補查拒絕非官方網址及 ID 不符，手動基線可補入且依 ID 去重', async () => {
  const items = [product(1), product(2)];
  const forged = { ...product(3), url: product(3).url.replace('www.eslite.com', 'evil-eslite.com') };
  const mismatch = { ...product(4), url: product(5).url };
  const f = fixture([...items, forged, mismatch]);
  f.state.data.commerce.shoppingSites.esliteManualProducts = { [items[1].id]: items[1], [product(6).id]: product(6) };
  try {
    f.trigger();
    await f.finish();
    assert.deepEqual(f.calls, [items[1].id, product(6).id]);
  } finally { await f.monitor.close(); }
});
