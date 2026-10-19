import assert from 'node:assert/strict';
import test from 'node:test';

import { FunboxMonitor } from '../src/funbox.js';

const SOURCES = [
  { id: 'category', label: '分類 API', url: 'https://funbox.test/category.json' },
  { id: 'collection', label: '集合頁 API', url: 'https://funbox.test/collection.json' }
];

const SEARCH_SOURCE = {
  id: 'search',
  label: '搜尋頁新品線',
  url: 'https://funbox.test/search?q=beyblade',
  hydrateProductDetails: true
};

function searchCard({ slug = 'bb08064', title = 'BEYBLADE X 戰鬥陀螺 CX-00 迪卡狂怒 FT3-60T' } = {}) {
  return `<!doctype html><div class="product">
    <a class="productClick" href="/products/${slug}" data-id="71618742" data-name="${title}" data-price="595">
      <img src="//cdn.example/${slug}.jpg" alt="${title}">
    </a>
    <div class="product_btn"><button>加入購物車</button></div>
  </div>`;
}

function cx00Detail(stock = 46) {
  return {
    id: 71618742,
    url: '/products/bb08064',
    title: 'BEYBLADE X 戰鬥陀螺 CX-00 迪卡狂怒 FT3-60T',
    price: 595,
    photo: '//cdn.example/bb08064.jpg',
    variants: [{ id: 880064, inventory_quantity: stock, inventory_policy: 'deny' }]
  };
}

function ux21(stock = 216) {
  return [{
    id: 8521,
    url: '/products/bb08554',
    title: 'BEYBLADE X 戰鬥陀螺 UX-21 惡魔冥界改造組',
    price: 895,
    photo: '//cdn.example/ux-21.jpg',
    variants: [{ id: 21001, inventory_quantity: stock, inventory_policy: 'deny' }]
  }];
}

test('分類 API 尚未更新時，集合頁 API 先看到 UX-21 就立即派工', async () => {
  const state = { data: {}, async save() {} };
  let round = 0;
  let releaseSlow;
  let purchaseResolve;
  const purchaseStarted = new Promise((resolve) => { purchaseResolve = resolve; });
  const monitor = new FunboxMonitor({
    state,
    sources: SOURCES,
    sourceTimeoutMs: 500,
    fetcher: async (url) => {
      if (round === 0) return Response.json([]);
      if (url.includes('category')) {
        await new Promise((resolve) => { releaseSlow = resolve; });
        return Response.json([]);
      }
      return Response.json(ux21());
    },
    notify: async () => 'discord-ux21',
    onPurchaseCandidate: (candidate) => purchaseResolve(candidate)
  });

  await monitor.scan();
  round = 1;
  const scanTask = monitor.scan();
  const candidate = await Promise.race([
    purchaseStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('未在慢速資料源完成前派工')), 100))
  ]);

  assert.equal(candidate.id, 'bb08554');
  assert.equal(candidate.stock, 216);
  assert.equal(candidate.detectionSource, '集合頁 API');
  releaseSlow();
  const result = await scanTask;
  assert.equal(result.discovered, 1);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(result.purchaseCandidates[0].id, 'bb08554');
  await monitor.close();
});

test('兩個 API 同時回傳同商品時只購買與通知一次', async () => {
  const state = { data: {}, async save() {} };
  let stocked = false;
  const purchases = [];
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    sources: SOURCES,
    fetcher: async () => Response.json(stocked ? ux21() : []),
    notify: async (text) => { notifications.push(text); return 'discord-dedup'; },
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });

  await monitor.scan();
  stocked = true;
  const result = await monitor.scan();
  await monitor.close();

  assert.equal(result.checked, 1);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(purchases.length, 1);
  assert.equal(notifications.length, 1);
});

test('其中一個 Funbox API 故障時仍以健康資料源完成偵測', async () => {
  const state = { data: {}, async save() {} };
  let stocked = false;
  const purchases = [];
  const monitor = new FunboxMonitor({
    state,
    sources: SOURCES,
    fetcher: async (url) => {
      if (url.includes('category')) return new Response('upstream error', { status: 503 });
      return Response.json(stocked ? ux21() : []);
    },
    notify: async () => 'discord-fallback',
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });

  await monitor.scan();
  stocked = true;
  const result = await monitor.scan();
  await monitor.close();

  assert.equal(result.discovered, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /分類 API：HTTP 503/);
  assert.equal(purchases.length, 1);
  assert.equal(result.sources.find((source) => source.id === 'collection').ok, true);
});

test('UX-21 雙資料源時序重播 100 次全部命中且不重複派工', async () => {
  const state = { data: {}, async save() {} };
  let round = 0;
  let callInRound = 0;
  const purchases = [];
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    sources: SOURCES,
    fetcher: async (url) => {
      const currentRound = round;
      callInRound += 1;
      const product = ux21(216).map((item) => ({
        ...item,
        id: 852100 + currentRound,
        url: `/products/ux-21-replay-${currentRound}`,
        variants: item.variants.map((variant) => ({ ...variant, id: 2100100 + currentRound }))
      }));
      if (currentRound === 0) return Response.json([]);
      if (currentRound % 3 === 0) return Response.json(product);
      const freshSource = currentRound % 2 === 0 ? 'category' : 'collection';
      return Response.json(url.includes(freshSource) ? product : []);
    },
    notify: async (text) => { notifications.push(text); return `discord-${notifications.length}`; },
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });

  await monitor.scan();
  for (round = 1; round <= 100; round += 1) {
    callInRound = 0;
    const result = await monitor.scan();
    assert.equal(callInRound, 2);
    assert.equal(result.discovered, 1);
    assert.equal(result.purchaseCandidates.length, 1);
  }
  await monitor.close();

  assert.equal(purchases.length, 100);
  assert.equal(new Set(purchases.map((product) => String(product.id))).size, 100);
  assert.equal(notifications.length, 100);
});

test('搜尋頁先看到新品時會用單品 JSON 補齊庫存，且不等待較慢 API 就推播與派工', async () => {
  const state = { data: {}, async save() {} };
  let round = 0;
  let releaseSlow;
  const slowSources = new Promise((resolve) => { releaseSlow = resolve; });
  let notificationResolve;
  let purchaseResolve;
  const notificationStarted = new Promise((resolve) => { notificationResolve = resolve; });
  const purchaseStarted = new Promise((resolve) => { purchaseResolve = resolve; });
  const monitor = new FunboxMonitor({
    state,
    sources: [...SOURCES, SEARCH_SOURCE],
    sourceTimeoutMs: 500,
    productHydrationTimeoutMs: 200,
    fetcher: async (url) => {
      if (round === 0) {
        return url.includes('/search') ? new Response('<html></html>') : Response.json([]);
      }
      if (url.endsWith('/products/bb08064.json')) return Response.json(cx00Detail());
      if (url.includes('/search')) return new Response(searchCard());
      await slowSources;
      return Response.json([]);
    },
    notify: async (text) => {
      notificationResolve(text);
      return 'discord-cx00';
    },
    onPurchaseCandidate: (candidate) => purchaseResolve(candidate)
  });

  await monitor.scan();
  round = 1;
  const scanTask = monitor.scan();
  const [notification, candidate] = await Promise.race([
    Promise.all([notificationStarted, purchaseStarted]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('搜尋新品線未先於慢速 API 觸發')), 100))
  ]);

  assert.match(notification, /CX-00 迪卡狂怒/);
  assert.equal(candidate.id, 'bb08064');
  assert.equal(candidate.stock, 46);
  assert.equal(candidate.variantId, '880064');
  assert.equal(candidate.detectionSource, '搜尋頁新品線');
  releaseSlow();
  const result = await scanTask;
  assert.equal(result.notified, 1);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(result.sources.find((source) => source.id === 'search').hydratedCount, 1);
  await monitor.close();
});

test('搜尋頁首次單品補資料失敗時仍先通知，下一輪補成功再派送購買', async () => {
  const state = { data: {}, async save() {} };
  let round = 0;
  let detailAttempts = 0;
  const notifications = [];
  const purchases = [];
  const monitor = new FunboxMonitor({
    state,
    sources: [SEARCH_SOURCE],
    productHydrationTimeoutMs: 200,
    fetcher: async (url) => {
      if (round === 0) return new Response('<html></html>');
      if (url.endsWith('/products/bb08064.json')) {
        detailAttempts += 1;
        return detailAttempts === 1
          ? new Response('busy', { status: 503 })
          : Response.json(cx00Detail());
      }
      return new Response(searchCard());
    },
    notify: async (text) => { notifications.push(text); return 'discord-cx00'; },
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });

  await monitor.scan();
  round = 1;
  const discovered = await monitor.scan();
  assert.equal(discovered.notified, 1);
  assert.equal(discovered.purchaseCandidates.length, 0);
  assert.equal(state.data.commerce.funbox.seen.bb08064.purchaseReady, false);

  const hydrated = await monitor.scan();
  assert.equal(hydrated.purchaseCandidates.length, 1);
  assert.equal(hydrated.purchaseCandidates[0].reason, 'purchase_ready');
  assert.equal(purchases.length, 1);
  assert.equal(notifications.length, 1);
  await monitor.close();
});

test('高速來源依自己的週期重用快取，備援來源不會每輪重複請求', async () => {
  const state = { data: {}, async save() {} };
  const calls = [];
  const monitor = new FunboxMonitor({
    state,
    sources: [{
      id: 'backup', label: '備援 API', url: 'https://funbox.test/backup.json', intervalMs: 9000
    }],
    fetcher: async (url) => {
      calls.push(url);
      return Response.json([]);
    },
    notify: async () => ''
  });

  const first = await monitor.scan();
  const second = await monitor.scan();
  assert.equal(calls.length, 1);
  assert.equal(first.sources[0].fresh, true);
  assert.equal(second.sources[0].fresh, false);
  assert.equal(second.sources[0].skipped, true);
  await monitor.close();
});

test('cached inventory never renews a purchase lease or emits a new purchase candidate', async () => {
  const state = { data: {}, async save() {} }, snapshots = [], candidates = [];
  const monitor = new FunboxMonitor({ state, sources: SOURCES, notify: async () => '',
    onInventorySnapshot: products => snapshots.push(products), onPurchaseCandidate: product => candidates.push(product) });
  let cached = false;
  monitor.fetchSource = async source => ({ ...source, ok: true, fresh: !cached, durationMs: 1,
    products: cached ? [{ id: 'cached', url: 'https://shop.funbox.com.tw/products/cached', title: 'BEYBLADE X cached', available: true, stock: 50, variantId: 'v' }] : [] });
  try { await monitor.scan(); cached = true; await monitor.scan(); assert.deepEqual(snapshots.at(-1), []); assert.equal(candidates.length, 0); }
  finally { await monitor.close(); }
});
