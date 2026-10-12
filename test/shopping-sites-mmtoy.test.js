import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMmToyCategoryData, ShoppingSiteMonitor } from '../src/shopping-sites.js';

test('MM小舖只通知一般可購規格並排除限客訂', () => {
  const products = parseMmToyCategoryData({
    products: [
      {
        id: 1,
        route: 'public-item',
        title: 'BEYBLADE X UX-11 衝擊龍神',
        quantity: 1,
        shownPrice: 550,
        specs: [{ id: 11, size_name: '預購-1個(不可搭其他預購) #不補', quantity: 1 }]
      },
      {
        id: 2,
        route: 'private-item',
        title: 'BEYBLADE X UX-15 鮫鯊狂鱗改造組',
        quantity: 1,
        shownPrice: 795,
        specs: [{ id: 21, size_name: '預購-1個(限客訂 eddieliao31', quantity: 1 }]
      }
    ]
  });

  assert.equal(products[0].available, true);
  assert.equal(products[0].variants[0].stock, 1);
  assert.equal(products[1].available, false);
  assert.equal(products[1].variants.length, 0);
  assert.equal(products[1].restrictedVariantCount, 1);
});

test('MM小舖有規格時不使用延遲的商品總庫存製造假補貨', () => {
  const [product] = parseMmToyCategoryData({
    products: [{
      id: 3,
      route: 'stale-aggregate-item',
      title: 'BEYBLADE X CX-05 隨機強化組',
      quantity: 1,
      shownPrice: 350,
      specs: [
        { id: 31, size_name: '預購-1個(不可搭其他預購) #不補', quantity: 0 },
        { id: 32, size_name: '預購-1個(一般販售)', quantity: 0 }
      ]
    }]
  });

  assert.equal(product.available, false);
  assert.deepEqual(product.variants.map((variant) => variant.stock), [0, 0]);
  assert.ok(product.variants.every((variant) => variant.stockSource === 'mmtoy-category-spec'));
});

test('MM小舖合併分類與全站搜尋，能找到未被放入分類的陀螺', async () => {
  const responses = new Map([
    ['/category/query/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA?page=1', {
      lastPage: 1,
      products: [{ id: 705822, route: 'ux19', title: '戰鬥陀螺 UX-19 子彈獅鷲', specs: [] }]
    }],
    ['/category/query?keyword=%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA&page=1', {
      lastPage: 1,
      products: [{ id: 716314, route: 'ux03', title: '戰鬥陀螺 UX-03 魔導神杖', specs: [] }]
    }]
  ]);
  const page = {
    isClosed: () => false,
    goto: async () => {},
    close: async () => {},
    evaluate: async (_callback, { endpoint, pageNumber }) => {
      const separator = endpoint.includes('?') ? '&' : '?';
      return responses.get(`${endpoint}${separator}page=${pageNumber}`);
    }
  };
  const monitor = new ShoppingSiteMonitor({
    state: { save: async () => {}, data: {} },
    getTargets: () => [],
    notify: async () => {},
    browserLauncher: async () => ({ isConnected: () => true, newPage: async () => page, close: async () => {} })
  });

  const products = await monitor.loadMmToyCategoryProducts({
    url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA'
  });
  assert.deepEqual(products.map((product) => product.id).sort(), ['705822', '716314']);
  await monitor.close();
});

test('MM小舖熱點使用 limit=100 的單一關鍵字快照，避免增加 API 負載', async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    goto: async () => {},
    close: async () => {},
    evaluate: async (_callback, args) => {
      calls.push(args);
      return {
        lastPage: 1,
        total: 64,
        products: [{
          id: 705927,
          route: 'ux18',
          title: '戰鬥陀螺 UX-18 隨機強化組 Vol.8',
          specs: [{ id: 2437800, size_name: '預購-1個 #不補', quantity: 1 }]
        }]
      };
    }
  };
  const monitor = new ShoppingSiteMonitor({
    state: { save: async () => {}, data: {} },
    getTargets: () => [],
    notify: async () => {},
    browserLauncher: async () => ({ isConnected: () => true, newPage: async () => page, close: async () => {} })
  });
  monitor.mmToyLastDiscoveryAt = Date.now();

  const products = await monitor.loadMmToyCategoryProducts({
    url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA'
  }, { fast: true });

  assert.equal(products.length, 1);
  assert.equal(products[0].variants[0].stock, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].endpoint, /keyword=/);
  assert.equal(calls[0].limit, 100);
  await monitor.close();
});

test('MM小舖遇到 429 不立即關頁並重送整批查詢', async () => {
  let requests = 0;
  let closes = 0;
  const page = {
    isClosed: () => false,
    goto: async () => {},
    close: async () => { closes += 1; },
    evaluate: async () => {
      requests += 1;
      throw new Error('MM小舖商品 API HTTP 429');
    }
  };
  const monitor = new ShoppingSiteMonitor({
    state: { save: async () => {}, data: {} },
    getTargets: () => [],
    notify: async () => {},
    browserLauncher: async () => ({ isConnected: () => true, newPage: async () => page, close: async () => {} })
  });
  monitor.mmToyLastDiscoveryAt = Date.now();

  await assert.rejects(
    monitor.loadMmToyCategoryProducts({
      url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA'
    }, { fast: true }),
    /HTTP 429/
  );
  assert.equal(requests, 1);
  assert.equal(closes, 0);
  await monitor.close();
});

test('MM小舖大量補貨同一快照會逐項建立通知', async () => {
  const target = {
    id: 'mmtoy-beyblade',
    name: 'MM小舖戰鬥陀螺專區',
    siteName: 'MM小舖',
    url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA',
    sourceType: 'mmtoy-category',
    enabled: true
  };
  const names = [
    ['ux18', 'UX-18 隨機強化組 Vol.8'],
    ['bx23', 'BX-23 鳳凰飛翼 豪華組'],
    ['ux11', 'UX-11 衝擊龍神 豪華組']
  ];
  const seen = Object.fromEntries(names.map(([id, title]) => [id, {
    id,
    title,
    url: `https://mmtoyshop.com/item/${id}`,
    available: false,
    variants: [{ id: `${id}-public`, name: '預購-1個 #不補', stock: 0, available: false }]
  }]));
  const state = {
    data: { commerce: { shoppingSites: { targets: { [target.id]: { initialized: true, seen } } } } },
    async save() {}
  };
  const notifications = [];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options })
  });
  monitor.loadMmToyCategoryProducts = async () => names.map(([id, title]) => ({
    ...seen[id],
    title,
    available: true,
    variants: [{ id: `${id}-public`, name: '預購-1個 #不補', stock: 1, available: true }]
  }));

  const result = await monitor.scan({ targetIds: [target.id], mmToyFast: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.restocked, 3);
  assert.equal(result.notified, 3);
  assert.equal(notifications.length, 3);
  assert.ok(names.every(([, title]) => notifications.some(({ text }) => text.includes(title))));
});

test('MM小舖售罄只更新狀態，不推送 Discord 通知', async () => {
  const target = {
    id: 'mmtoy-beyblade',
    name: 'MM小舖戰鬥陀螺專區',
    siteName: 'MM小舖',
    url: 'https://mmtoyshop.com/category/%F0%9F%8C%80%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA',
    sourceType: 'mmtoy-category',
    enabled: true
  };
  const state = { data: {}, async save() {} };
  const notifications = [];
  const scans = [1, 0];
  const monitor = new ShoppingSiteMonitor({
    state,
    getTargets: () => [target],
    notify: async (text, options) => notifications.push({ text, options })
  });
  monitor.loadMmToyCategoryProducts = async () => [{
    id: 'ux16',
    title: '【M.M小舖】戰鬥陀螺 UX-16 時鐘幻象',
    url: 'https://mmtoyshop.com/item/ux16',
    price: 'NT$350',
    available: scans[0] > 0,
    stock: scans[0],
    variants: [{
      id: 'normal',
      name: '預購-1個(不可搭其他預購) #不補',
      stock: scans.shift(),
      available: scans.length === 1
    }]
  }];

  await monitor.scan();
  const soldOut = await monitor.scan();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(soldOut.stockChanged, 1);
  assert.equal(soldOut.notified, 0);
  assert.equal(notifications.length, 0);
  assert.equal(
    state.data.commerce.shoppingSites.targets[target.id].seen.ux16.variants[0].stock,
    0
  );
});
