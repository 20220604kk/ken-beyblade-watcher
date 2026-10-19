import assert from 'node:assert/strict';
import test from 'node:test';
import { EsliteRestockTasks } from '../src/eslite-restock-tasks.js';
import { AutoPurchaseCoordinator } from '../src/auto-purchase.js';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ blocked = {}, purchase, slots = ['A', 'B', 'C'] } = {}) {
  let time = Date.now(), monitored = true;
  const calls = [], busy = new Set();
  const state = { data: {}, async save() {} };
  const config = { enabled: true, eslite: { enabled: true, buyMode: 'all', skipBuyKeywords: [] } };
  const adapter = { independentQueues: true, maxConcurrency: 3,
    queueSlots: () => slots, accountIdentity: slot => `identity-${slot}`,
    queueBlockReason: slot => blocked[slot] || '', credentialsStatus: () => ({ ready: true }),
    runtimeStatus: () => ({}), close: async () => {},
    async purchase(product, settings) {
      const slot = settings.accountSlot;
      assert.equal(busy.has(slot), false, 'same account cannot overlap');
      busy.add(slot); calls.push({ slot, id: product.id, at: time });
      try {
        await settings.onAccountAssigned(slot);
        return purchase ? await purchase(product, slot) : { status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot };
      } finally { busy.delete(slot); }
    }
  };
  const coordinator = new AutoPurchaseCoordinator({ state, getConfig: () => config,
    adapters: { eslite: adapter }, notifyPrivate: async () => {}, continuousEsliteTasks: true,
    esliteTaskClock: () => time, isPlatformMonitoringEnabled: () => monitored });
  const toy = (id, extra = {}) => ({ id, title: `BEYBLADE X ${id}`, url: `https://www.eslite.com/product/${id}`,
    stock: 50, available: true, status: 'add_to_shopping_cart', reason: 'restock',
    freshObservationAt: new Date(time).toISOString(), ...extra });
  return { coordinator, calls, state, config, toy, adapter,
    advance: ms => { time += ms; }, disable: () => { monitored = false; } };
}

test('22-minute replay: each confirmed order advances; later signals create new independent ABC tasks', async () => {
  const f = fixture();
  try {
    for (let minute = 0; minute <= 22; minute++) {
      if ([0, 13, 15, 17, 18, 21, 22].includes(minute)) {
        const result = await f.coordinator.enqueue('eslite', [f.toy(`product-${minute}`)]);
        assert.equal(result.accepted, 3);
      }
      for (const { product } of [...f.coordinator.esliteRestockTasks.products.values()]) {
        f.coordinator.observeEslitePurchaseProduct(f.toy(product.id));
      }
      await f.coordinator.whenIdle();
      f.advance(60_000);
    }
    assert.equal(f.calls.length, 21);
    for (const slot of ['A', 'B', 'C']) assert.equal(f.calls.filter(call => call.slot === slot).length, 7);
    assert.ok(f.calls.at(-1).at - f.calls[0].at >= 22 * 60_000);
    assert.equal(f.coordinator.getStatus().esliteWaitingTasks.length, 0);
  } finally { await f.coordinator.close(); }
});

test('steady fresh observations retry a known busy failure after cooldown, without a new restock edge', async () => {
  let count = 0;
  const f = fixture({ slots: ['B'], purchase: async () => {
    if (++count === 1) { const error = new Error('explicit rejection'); error.purchaseStatus = 'checkout_busy'; throw error; }
    return { status: 'ordered', orderId: 'mock-B-1', accountSlot: 'B' };
  } });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1')]); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 1);
    assert.equal(f.coordinator.getStatus().esliteWaitingTasks[0].blockedReason, '帳號忙碌冷卻中');
    f.advance(1000); f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.coordinator.getStatus().esliteWaitingTasks[0].blockedReason, '帳號忙碌冷卻中');
    f.advance(5000); f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 2);
    f.advance(60_000); f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await tick();
    assert.equal(f.calls.length, 2, 'confirmed purchase is never repeated');
  } finally { await f.coordinator.close(); }
});

test('bounded event retries stop B after three tries per product; A can log in later and C continues independently', async () => {
  let recovered = false;
  const blocked = { A: '登入待恢復' };
  const f = fixture({ blocked, purchase: async (product, slot) => {
    if (slot === 'B' && !recovered) { const error = new Error('busy'); error.purchaseStatus = 'checkout_busy'; throw error; }
    return { status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot };
  } });
  try {
    const ids = ['1', '2', '3', '4', '5'];
    await f.coordinator.enqueue('eslite', ids.map(id => f.toy(id)));
    for (let n = 0; n < 20; n++) await tick();
    assert.equal(f.calls.filter(call => call.slot === 'C').length, 5);
    for (let second = 20; second <= 22 * 60; second += 20) {
      f.advance(20_000);
      if (second === 22 * 60) { recovered = true; delete blocked.A; }
      for (const id of ids) f.coordinator.observeEslitePurchaseProduct(f.toy(id));
      for (let n = 0; n < 12; n++) await tick();
    }
    // A had no checkout attempts while login was blocked. B exhausted the
    // new explicit event retry cap; fresh polling alone must not reset it.
    for (let n = 0; n < 3; n++) {
      f.advance(20_000);
      for (const id of ids) f.coordinator.observeEslitePurchaseProduct(f.toy(id));
      for (let step = 0; step < 12; step++) await tick();
    }
    await f.coordinator.whenIdle();
    for (const slot of ['A', 'C']) {
      assert.equal(Object.keys(f.state.data.commerce.autoPurchase.eslitePurchased[`identity-${slot}`]).length, 5);
    }
    assert.equal(f.calls.filter(call => call.slot === 'A').length, 5);
    assert.equal(f.calls.filter(call => call.slot === 'C').length, 5);
    assert.equal(f.state.data.commerce.autoPurchase.eslitePurchased['identity-B'],undefined);
    for(const id of ids)assert.equal(f.calls.filter(call=>call.slot==='B'&&call.id===id).length,3);
    assert.equal(f.coordinator.getStatus().esliteWaitingTasks.length, 5);
  } finally { await f.coordinator.close(); }
});

test('fresh observations keep a blocked queue alive beyond two minutes; stale data cannot buy', async () => {
  const blocked = { A: '登入待恢復' };
  const f = fixture({ slots: ['A'], blocked });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1')]); await tick();
    for (let n = 0; n < 10; n++) { f.advance(20_000); f.coordinator.observeEslitePurchaseProduct(f.toy('1')); }
    assert.equal(f.coordinator.queue.length, 1);
    f.advance(31_000); delete blocked.A;
    await f.coordinator._schedule(); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.coordinator.getStatus().esliteWaitingTasks[0].blockedReason, '等待最新 API 觀測');
    f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 1);
  } finally { await f.coordinator.close(); }
});

test('inventory conflict requires a changed stock signature; sold-out to available also qualifies', async () => {
  let count = 0;
  const f = fixture({ slots: ['A'], purchase: async () => {
    if (++count <= 2) { const error = new Error('inventory conflict'); error.purchaseStatus = 'inventory_conflict'; throw error; }
    return { status: 'ordered', orderId: 'mock-A-1' };
  } });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1')]); await f.coordinator.whenIdle();
    f.advance(6000); f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await tick();
    assert.equal(f.calls.length, 1);
    f.coordinator.observeEslitePurchaseProduct(f.toy('1', { stock: 49 })); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 2);
    f.advance(11_000); f.coordinator.observeEslitePurchaseProduct(f.toy('1', { available: false, stock: 0 })); await tick();
    f.coordinator.observeEslitePurchaseProduct(f.toy('1', { stock: 49 })); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 3);
  } finally { await f.coordinator.close(); }
});

test('unknown checkout and purchase limits stop only the relevant identity; others finish subsequent products', async () => {
  const blocked = {};
  const f = fixture({ blocked, purchase: async (product, slot) => {
    if (slot === 'A') { blocked.A = '訂單待核對'; return { status: 'submitted_unconfirmed', accountSlot: slot }; }
    if (slot === 'B') { const error = new Error('limit'); error.purchaseStatus = 'purchase_limited'; throw error; }
    return { status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot };
  } });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1'), f.toy('2')]);
    for (let n = 0; n < 20; n++) await tick();
    f.advance(61_000);
    for (const id of ['1', '2']) f.coordinator.observeEslitePurchaseProduct(f.toy(id));
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(f.calls.filter(call => call.slot === 'A').length, 1);
    assert.equal(f.calls.filter(call => call.slot === 'B').length, 2);
    assert.equal(f.calls.filter(call => call.slot === 'C').length, 2);
  } finally { await f.coordinator.close(); }
});

test('historical baseline, stale/future/unknown observations, excluded products, stopped monitoring cannot create tasks', async () => {
  const f = fixture();
  try {
    f.coordinator.observeEslitePurchaseProduct(f.toy('baseline'));
    assert.equal(f.coordinator.getStatus().esliteRestockEvent.active, false);
    for (const extra of [{ freshObservationAt: '' }, { freshObservationAt: '2000-01-01T00:00:00Z' },
      { freshObservationAt: '2100-01-01T00:00:00Z' }, { available: null }, { verificationPending: true }]) {
      assert.equal((await f.coordinator.enqueue('eslite', [f.toy('invalid', extra)])).accepted, 0);
    }
    f.config.eslite.skipBuyKeywords = ['BX-37'];
    assert.equal((await f.coordinator.enqueue('eslite', [f.toy('BX-37')])).accepted, 0);
    assert.equal(f.calls.length, 0);
    f.disable(); assert.equal((await f.coordinator.enqueue('eslite', [f.toy('stopped')])).accepted, 0);
    assert.equal(f.coordinator.getStatus().esliteRestockEvent.active, false);
  } finally { await f.coordinator.close(); }
});

test('event expires after 30 minutes with no fresh sellable observations; steady baselines do not restart it', () => {
  let time = Date.now();
  const tasks = new EsliteRestockTasks({ now: () => time });
  const product = () => ({ id: '1', url: 'https://www.eslite.com/product/1', available: true, freshObservationAt: new Date(time).toISOString() });
  tasks.observe(product(), { activate: true });
  time += 30 * 60_000;
  assert.equal(tasks.status().active, false);
  assert.equal(tasks.observe(product()), false);
});

test('rate limiting cools the whole affected account, not only one product', async () => {
  let count = 0;
  const f = fixture({ slots: ['A'], purchase: async product => {
    if (++count === 1) { const error = new Error('429'); error.purchaseStatus = 'rate_limited'; throw error; }
    return { status: 'ordered', orderId: `mock-${product.id}` };
  } });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1'), f.toy('2')]);
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.coordinator.getStatus().queue[0].blockedReason, '帳號限流冷卻中');
    f.advance(30_000);
    for (const id of ['1', '2']) f.coordinator.observeEslitePurchaseProduct(f.toy(id));
    await tick(); assert.equal(f.calls.length, 1);
    f.advance(31_000);
    for (const id of ['1', '2']) f.coordinator.observeEslitePurchaseProduct(f.toy(id));
    await f.coordinator.whenIdle(); assert.equal(f.calls.length, 3);
  } finally { await f.coordinator.close(); }
});

test('stopping and resuming discards old event intent, and blacklist edits cancel pending purchases', async () => {
  const blocked = { A: '暫停' };
  const f = fixture({ slots: ['A'], blocked });
  try {
    await f.coordinator.enqueue('eslite', [f.toy('1')]); await tick();
    f.config.eslite.skipBuyKeywords = ['1']; delete blocked.A;
    await f.coordinator._schedule(); await f.coordinator.whenIdle();
    assert.equal(f.calls.length, 0);
    f.config.eslite.skipBuyKeywords = [];
    await f.coordinator.suspend();
    f.coordinator.paused = false;
    f.coordinator.observeEslitePurchaseProduct(f.toy('1')); await tick();
    assert.equal(f.coordinator.getStatus().esliteRestockEvent.active, false);
    assert.equal(f.calls.length, 0);
  } finally { await f.coordinator.close(); }
});

test('complete scanner-to-queue story: steady official updates replenish failed tasks with no duplicate notices', async () => {
  let attempts = 0;
  const f = fixture({ slots: ['B'], purchase: async product => {
    if (++attempts === 1) { const error = new Error('busy'); error.purchaseStatus = 'checkout_busy'; throw error; }
    return { status: 'ordered', orderId: `mock-${product.id}`, accountSlot: 'B' };
  } });
  const target = { id: 'e2e', name: 'e2e', url: 'https://www.eslite.com/Search', enabled: true };
  const notices = [];
  const state = { data: { commerce: { shoppingSites: { targets: { e2e: { initialized: true, seen: {} } } } } }, async save() {} };
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target], notify: async text => notices.push(text),
    onPurchaseCandidate: product => f.coordinator.enqueue('eslite', [product]),
    onEslitePurchaseObservation: product => f.coordinator.observeEslitePurchaseProduct(product) });
  try {
    // Scanner uses wall-clock timestamps; keep the injected coordinator clock
    // slightly ahead so these are not (correctly) rejected as future evidence.
    f.advance(100);
    monitor.applyImmediateEsliteObservations(target, [f.toy('1')], { source: 'exhibit-api' });
    await f.coordinator.whenIdle(); assert.equal(f.calls.length, 1);
    f.advance(6000);
    monitor.applyImmediateEsliteObservations(target, [f.toy('1')], { source: 'search-api' });
    await f.coordinator.whenIdle(); assert.equal(f.calls.length, 2);
    await tick(); assert.equal(notices.length, 1);
    assert.equal(f.coordinator.getStatus().recent[0].status, 'ordered');
    assert.equal(f.coordinator.getStatus().recent[0].orderId, 'mock-1');
  } finally { await monitor.close(); await f.coordinator.close(); }
});

test('scanner sends repeated official observations, keeps notices deduplicated, and never refreshes from unknown merged baseline', async () => {
  const observations = [], candidates = [], notices = [];
  const target = { id: 'test', name: 'test', url: 'https://www.eslite.com/Search', enabled: true };
  const state = { data: { commerce: { shoppingSites: { targets: { test: { initialized: true, seen: {} } } } } }, async save() {} };
  const monitor = new ShoppingSiteMonitor({ state, getTargets: () => [target],
    notify: async text => notices.push(text), onPurchaseCandidate: product => candidates.push(product),
    onEslitePurchaseObservation: product => observations.push(product) });
  const product = { id: '1', url: 'https://www.eslite.com/product/1', title: 'BEYBLADE X UX-03', available: true, status: 'add_to_shopping_cart' };
  try {
    monitor.applyImmediateEsliteObservations(target, [product], { source: 'exhibit-api' });
    monitor.applyImmediateEsliteObservations(target, [product], { source: 'search-api' });
    monitor.applyImmediateEsliteObservations(target, [{ ...product, available: null, status: 'verification_pending', verificationPending: true }]);
    assert.equal(observations.length, 2); assert.equal(candidates.length, 1);
    assert.ok(candidates[0].freshObservationAt);
    monitor.applyImmediateEsliteObservations(target, [{ ...product, available: false, status: 'can_not_buy' }], { authoritative: true });
    assert.equal(observations.at(-1).available, false);
    await tick(); assert.equal(notices.length, 1);
  } finally { await monitor.close(); }
});

test('BX-09 dispatches to ABC concurrently first; remaining complete lists have independent random order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ purchase: async (product, slot) => {
    if (product.id === '1') await gate;
    return { status: 'ordered', orderId: `${slot}-${product.id}`, accountSlot: slot };
  } });
  f.config.eslite.priorityKeywords = ['BX-09'];
  const randoms = [.1,.9,.4, .5,.5,.5, .9,.1,.2, .3,.3,.9, .5,.5,.1];
  f.coordinator.esliteQueueRandom = () => randoms.shift();
  try {
    await f.coordinator.enqueue('eslite', ['2','1','3','4','5'].map(id => f.toy(id, { title: id === '1' ? 'BEYBLADE X BX-09 通行證' : `BEYBLADE X 商品${id}` })));
    for (let n = 0; n < 8; n++) await tick();
    assert.deepEqual(f.calls.map(({ slot, id }) => [slot, id]), [['A','1'], ['B','1'], ['C','1']]);
    assert.equal(f.coordinator.getStatus().queue.length, 12);
    release(); await f.coordinator.whenIdle();
    const orders = slot => f.calls.filter(call => call.slot === slot).map(call => call.id).join('');
    assert.equal(orders('A'), '12453');
    assert.equal(orders('B'), '13452');
    assert.equal(orders('C'), '15324');
  } finally { release(); await f.coordinator.close(); }
});

test('one keyword matching three strengthening sets orders the same priority group first on every account', async () => {
  const f = fixture();
  f.config.eslite.priorityKeywords = ['強化組'];
  const names = ['商品4', 'CX-08 強化組', '商品5', 'BX-35 隨機強化組', 'CX-05 強化組'];
  try {
    await f.coordinator.enqueue('eslite', names.map((title, i) => f.toy(String(i), { title })));
    await f.coordinator.whenIdle();
    for (const slot of ['A', 'B', 'C']) {
      const ids = f.calls.filter(call => call.slot === slot).map(call => call.id);
      assert.deepEqual(ids.slice(0, 3), ['1','3','4']);
      assert.deepEqual(ids.slice(3).sort(), ['0','2']);
    }
  } finally { await f.coordinator.close(); }
});

test('priority keywords never override blacklist, whitelist or per-account purchased GUIDs', async () => {
  const f = fixture();
  Object.assign(f.config.eslite, { priorityKeywords: ['BX-09', '強化組'], buyMode: 'whitelist',
    buyKeywords: ['BX-09', 'CX-08', 'BX-35'], skipBuyKeywords: ['BX-35'] });
  f.state.data.commerce.autoPurchase.eslitePurchased = { 'identity-A': { '1': { orderId: 'old' } } };
  const names = ['BX-09 通行證', 'CX-08 強化組', 'BX-35 強化組', 'CX-05 強化組', 'BX-090'];
  try {
    await f.coordinator.enqueue('eslite', names.map((title, i) => f.toy(String(i + 1), { title })));
    await f.coordinator.whenIdle();
    assert.deepEqual(f.calls.filter(call => call.slot === 'A').map(call => call.id), ['2']);
    for (const slot of ['B', 'C']) assert.deepEqual(f.calls.filter(call => call.slot === slot).map(call => call.id), ['1','2']);
  } finally { await f.coordinator.close(); }
});

test('late priority item inserts before waiting tasks without interrupting the active checkout', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ slots: ['A'], purchase: async product => {
    if (product.id === '1') await gate;
    return { status: 'ordered', orderId: `mock-${product.id}` };
  } });
  let rank = 0; f.coordinator.esliteQueueRandom = () => ++rank / 10;
  try {
    await f.coordinator.enqueue('eslite', ['1','2','3'].map(id => f.toy(id)));
    for (let n = 0; n < 5; n++) await tick();
    f.config.eslite.priorityKeywords = ['BX-09'];
    await f.coordinator.enqueue('eslite', [f.toy('4', { title: 'BX-09 通行證' })]);
    await tick();
    assert.deepEqual(f.calls.map(call => call.id), ['1']);
    assert.equal(f.coordinator.getStatus().queue[0].priorityKeyword, 'BX-09');
    release(); await f.coordinator.whenIdle();
    assert.deepEqual(f.calls.map(call => call.id), ['1','4','2','3']);
  } finally { release(); await f.coordinator.close(); }
});
