import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FunboxMonitor, formatFunboxNotification, funboxDiscordPreview,
  canonicalFunboxProductId, migrateFunboxSeenRecords,
  funboxStockNotificationDecision,
  normalizeFunboxSimulationProduct,
  funboxStockDiscordPreview, parseFunboxProductData, parseFunboxProducts, parseFunboxSearchData,
  shouldSkipFunboxProduct, validateFunboxSourceBody
} from '../src/funbox.js';

test('Funbox 互動測試可自訂點擊網址與 Discord 商品縮圖', () => {
  const product = normalizeFunboxSimulationProduct({
    title: 'BEYBLADE X 戰鬥陀螺 CX-13 龍王閃擊',
    price: 'NT$495', stock: 77,
    targetUrl: 'https://www.youtube.com/watch?v=dMTy6C4UiQ4',
    imageUrl: 'https://cdn.example/cx-13.png'
  });
  assert.equal(product.url, 'https://www.youtube.com/watch?v=dMTy6C4UiQ4');
  assert.equal(product.imageUrl, 'https://cdn.example/cx-13.png');
  assert.equal(product.stock, 77);
  assert.equal(product.price, 'NT$495');
  assert.throws(
    () => normalizeFunboxSimulationProduct({ targetUrl: 'javascript:alert(1)' }),
    /只接受 http 或 https/
  );
});

function productCard({ id, slug, title, price = '350.0', soldOut = false }) {
  return `
    <div class="product">
      <div class="product_image">
        <a class="productClick img-flex" href="/products/${slug}"
          data-id="${id}" data-name="${title}" data-price="${price}">
          <img data-src="//cdn.example/${slug}.jpg" alt="${title}">
        </a>
      </div>
      <div class="product_title"><a>${title}</a></div>
      <div class="product_price"><span class="price">NT$${price}</span></div>
      <div class="product_btn"><button>${soldOut ? '商品已售完' : '加入購物車'}</button></div>
    </div>`;
}

function page(cards = []) {
  return `<!doctype html><html><body><h1>戰鬥陀螺</h1>${cards.join('')}</body></html>`;
}

test('解析 Funbox 商品 ID、標題、價格、圖片與售完狀態', () => {
  const products = parseFunboxProducts(page([
    productCard({ id: '101', slug: 'bx-101', title: 'BEYBLADE X BX-101 測試陀螺' }),
    productCard({ id: '102', slug: 'bx-102', title: 'BEYBLADE X BX-102', soldOut: true })
  ]));

  assert.equal(products.length, 2);
  assert.deepEqual(products[0], {
    id: 'bx-101',
    sourceProductId: '101',
    title: 'BEYBLADE X BX-101 測試陀螺',
    url: 'https://shop.funbox.com.tw/products/bx-101',
    price: '350.0',
    imageUrl: 'https://cdn.example/bx-101.jpg',
    stock: null,
    available: true,
    availabilityText: '加入購物車'
  });
  assert.equal(products[1].available, false);
});

test('解析 Funbox 正式分類 API 的前台可售庫存', () => {
  const products = parseFunboxProductData([{
    id: 69490235,
    url: '/products/ds08895',
    photo: '//cdn.example/ds08895.jpg',
    title: 'BEYBLADE X UX-15',
    price: 1995,
    variants: [
      { id: 1, inventory_quantity: 80, inventory_policy: 'deny' },
      { id: 2, inventory_quantity: 52, inventory_policy: 'deny' }
    ]
  }]);

  assert.equal(products.length, 1);
  assert.equal(products[0].stock, 132);
  assert.equal(products[0].id, 'ds08895');
  assert.equal(products[0].sourceProductId, '69490235');
  assert.equal(products[0].price, 'NT$1,995');
  assert.equal(products[0].url, 'https://shop.funbox.com.tw/products/ds08895');
  assert.equal(products[0].imageUrl, 'https://cdn.example/ds08895.jpg');
  assert.equal(products[0].stockSource, 'funbox_frontend_api');
  assert.match(formatFunboxNotification(products[0]), /目前庫存：132（官網前台可售量）/);
});

test('解析 Funbox 官方搜尋 API 的商品網址、規格與即時庫存', () => {
  const products = parseFunboxSearchData({
    products: {
      result: [{
        id: 71618742,
        handle: 'bb08064',
        title: 'BEYBLADE X 戰鬥陀螺 CX-00 迪卡狂怒 FT3-60T',
        featured_image: { medium: '//cdn.example/bb08064.jpg' },
        variants: [{ id: 880064, price: 595, inventory_quantity: 46, inventory_policy: 'deny' }]
      }]
    }
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].id, 'bb08064');
  assert.equal(products[0].url, 'https://shop.funbox.com.tw/products/bb08064');
  assert.equal(products[0].price, 'NT$595');
  assert.equal(products[0].stock, 46);
  assert.equal(products[0].variantId, '880064');
  assert.equal(products[0].available, true);
});

test('首次掃描建立基線，後續只通知新增商品', async () => {
  const state = {
    data: {},
    saves: 0,
    async save() { this.saves += 1; }
  };
  const responses = [
    page([productCard({ id: '101', slug: 'bx-101', title: 'BX-101' })]),
    page([
      productCard({ id: '102', slug: 'bx-102', title: 'BX-102' }),
      productCard({ id: '101', slug: 'bx-101', title: 'BX-101' })
    ])
  ];
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    url: 'https://shop.funbox.com.tw/categories/test',
    fetcher: async () => new Response(responses.shift(), { status: 200 }),
    notify: async (text, options) => {
      notifications.push({ text, options });
      return 'discord-1';
    }
  });

  const first = await monitor.scan();
  const second = await monitor.scan();

  assert.equal(first.firstRun, true);
  assert.equal(first.notified, 0);
  assert.equal(second.firstRun, false);
  assert.equal(second.discovered, 1);
  assert.equal(second.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /BX-102/);
  assert.equal(
    notifications[0].options.discordPreview,
    '🚨 Funbox 新品上架｜BX-102\nNT$350｜加入購物車'
  );
  assert.equal(notifications[0].options.embeds[0].title, '🚨 Funbox 新品上架｜BX-102');
  assert.match(notifications[0].options.embeds[0].description, /完整品名：\*\* BX-102/);
  assert.equal(state.data.commerce.funbox.seen['bx-102'].notificationId, 'discord-1');
});

test('空集合可作為基線，之後第一件商品會通知', async () => {
  const state = { data: {}, async save() {} };
  const responses = [
    page(),
    page([productCard({ id: '201', slug: 'cx-201', title: 'CX-201' })])
  ];
  let notified = 0;
  const monitor = new FunboxMonitor({
    state,
    url: 'https://shop.funbox.com.tw/categories/test',
    fetcher: async () => new Response(responses.shift(), { status: 200 }),
    notify: async () => {
      notified += 1;
      return 'message-201';
    }
  });

  assert.equal((await monitor.scan()).checked, 0);
  assert.equal((await monitor.scan()).notified, 1);
  assert.equal(notified, 1);
});

test('商品名稱含 APP 時略過所有 Funbox 監控動作', async () => {
  assert.equal(shouldSkipFunboxProduct({ title: '【預購截止日8/8】APP序號兌換 UX-00' }), true);
  assert.equal(shouldSkipFunboxProduct({ title: 'app 預約生產 UX-00' }), true);
  assert.equal(shouldSkipFunboxProduct({ title: 'BEYBLADE X UX-00 一般販售' }), false);

  const state = { data: {}, async save() {} };
  const payloads = [
    [],
    [{
      id: 3001,
      url: '/products/app-ux-00',
      title: '【預購截止日8/8】APP序號兌換 戰鬥陀螺 UX-00',
      price: 999,
      variants: [{ id: 31, inventory_quantity: 9889, inventory_policy: 'deny' }]
    }]
  ];
  let notified = 0;
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async () => { notified += 1; }
  });

  await monitor.scan({ notifyStockChanges: true });
  const result = await monitor.scan({ notifyStockChanges: true });

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.discovered, 0);
  assert.equal(result.notified, 0);
  assert.equal(result.purchaseCandidates.length, 0);
  assert.equal(result.excludedProducts.length, 1);
  assert.equal(result.excludedProducts[0].id, 'app-ux-00');
  assert.equal(notified, 0);
  assert.equal(state.data.commerce.funbox.seen['app-ux-00'], undefined);
  assert.equal(
    state.data.commerce.funbox.excluded['app-ux-00'].reason,
    '命中 APP 兌換商品排除規則'
  );
  assert.equal(state.data.commerce.funbox.excluded['app-ux-00'].title.includes('APP'), true);
});

test('APP 排除稽核只在首次出現或內容改變時寫入 LOG', async () => {
  const state = { data: {}, async save() {} };
  const logs = [];
  const payload = [{
    id: 69274375,
    url: '/products/bbpr07733',
    title: '【APP兌換】BEYBLADE X 戰鬥陀螺 CX-00',
    price: 350,
    variants: [{ id: 1, inventory_quantity: 1, inventory_policy: 'deny' }]
  }];
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payload),
    log: (message) => logs.push(message),
    notify: async () => { throw new Error('不應通知'); }
  });

  await monitor.scan();
  await monitor.scan();

  assert.equal(logs.filter((line) => line.includes('已掃描但排除')).length, 1);
  assert.equal(state.data.commerce.funbox.excluded.bbpr07733.url, 'https://shop.funbox.com.tw/products/bbpr07733');
});

test('Funbox JSON API 的 HTTP 200 驗證頁不得當成成功空清單', async () => {
  assert.throws(
    () => validateFunboxSourceBody(
      '<html><div class="toomany">請稍後再試</div></html>',
      'https://shop.funbox.com.tw/category_products/test.json'
    ),
    /驗證／等待頁/
  );
  assert.throws(
    () => validateFunboxSourceBody(
      '<html><body>一般錯誤頁</body></html>',
      'https://shop.funbox.com.tw/category_products/test.json'
    ),
    /回傳非商品資料/
  );
  assert.doesNotThrow(() => validateFunboxSourceBody(
    '[]',
    'https://shop.funbox.com.tw/category_products/test.json'
  ));
});

test('APP 商品改為一般販售後會重新視為正式新品', async () => {
  const state = {
    data: {
      commerce: {
        funbox: {
          initialized: true,
          seen: {
            3002: { title: '舊商品', stock: 100, available: true }
          }
        }
      }
    },
    async save() {}
  };
  const payloads = [
    [{
      id: 3002,
      url: '/products/ux-00',
      title: 'APP預約生產 UX-00',
      price: 999,
      variants: [{ id: 32, inventory_quantity: 100, inventory_policy: 'deny' }]
    }],
    [{
      id: 3002,
      url: '/products/ux-00',
      title: 'BEYBLADE X UX-00 一般販售',
      price: 999,
      variants: [{ id: 32, inventory_quantity: 100, inventory_policy: 'deny' }]
    }]
  ];
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async (text) => { notifications.push(text); }
  });

  const skipped = await monitor.scan({ notifyStockChanges: true });
  const released = await monitor.scan({ notifyStockChanges: true });

  assert.equal(skipped.skipped, 1);
  assert.equal(released.discovered, 1);
  assert.equal(released.notified, 1);
  assert.equal(released.purchaseCandidates.length, 1);
  assert.match(notifications[0], /UX-00 一般販售/);
});

test('正式分類 API 新品通知會帶入庫存與可點商品連結', async () => {
  const state = { data: {}, async save() {} };
  const payloads = [
    [],
    [{
      id: 9001,
      url: '/products/ux-15',
      title: 'BEYBLADE X UX-15',
      price: 699,
      photo: '//cdn.example/ux-15.jpg',
      variants: [{ id: 91, inventory_quantity: 57, inventory_policy: 'deny' }]
    }]
  ];
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async (text, options) => {
      notifications.push({ text, options });
      return 'discord-api-stock';
    }
  });

  await monitor.scan();
  const result = await monitor.scan();

  assert.equal(result.notified, 1);
  assert.match(notifications[0].text, /目前庫存：57/);
  assert.equal(
    notifications[0].options.discordPreview,
    '🚨 Funbox 新品上架｜UX-15\nNT$699｜庫存 57 組'
  );
  assert.match(notifications[0].options.embeds[0].description, /官網前台可售量/);
  assert.match(notifications[0].options.embeds[0].description, /https:\/\/shop\.funbox\.com\.tw\/products\/ux-15/);
  assert.equal(state.data.commerce.funbox.seen['ux-15'].stock, 57);
  assert.equal(state.data.commerce.funbox.seen['ux-15'].imageUrl, 'https://cdn.example/ux-15.jpg');
});

test('庫存追蹤會依序通知 100→50→20→10，10 件顯示即將銷售完畢', async () => {
  const state = { data: {}, async save() {} };
  const productAtStock = (stock) => [{
    id: 9015,
    url: '/products/ux-15',
    title: 'BEYBLADE X UX-15',
    price: 699,
    photo: '//cdn.example/ux-15.jpg',
    variants: [{ id: 915, inventory_quantity: stock, inventory_policy: 'deny' }]
  }];
  const payloads = [100, 50, 20, 10, 10].map(productAtStock);
  const notifications = [];
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async (text, options) => {
      notifications.push({ text, options });
      return `discord-stock-${notifications.length}`;
    }
  });

  const baseline = await monitor.scan({ notifyStockChanges: true });
  const fifty = await monitor.scan({ notifyStockChanges: true });
  const twenty = await monitor.scan({ notifyStockChanges: true });
  const ten = await monitor.scan({ notifyStockChanges: true });
  const unchanged = await monitor.scan({ notifyStockChanges: true });

  assert.equal(baseline.notified, 0);
  assert.equal(fifty.stockChanged, 1);
  assert.equal(twenty.stockNotified, 1);
  assert.equal(ten.notified, 1);
  assert.equal(unchanged.stockChanged, 0);
  assert.equal(unchanged.notified, 0);
  assert.equal(notifications.length, 3);
  assert.match(notifications[0].text, /庫存變化：100 → 50/);
  assert.match(notifications[1].text, /庫存變化：50 → 20/);
  assert.match(notifications[2].text, /庫存變化：20 → 10/);
  assert.match(notifications[2].text, /狀態：即將銷售完畢/);
  assert.equal(
    notifications[2].options.discordPreview,
    '⚠️ Funbox 低庫存｜UX-15\n庫存 20 → 10 組'
  );
  assert.equal(
    notifications[2].options.embeds[0].title,
    '⚠️ Funbox 庫存即將銷售完畢｜UX-15'
  );
  assert.equal(state.data.commerce.funbox.seen['ux-15'].stock, 10);
});

test('高速掃描只在跨過庫存門檻、售罄或補貨時通知', () => {
  assert.deepEqual(
    funboxStockNotificationDecision(132, 99),
    { notify: true, reason: 'threshold', threshold: 100 }
  );
  assert.deepEqual(
    funboxStockNotificationDecision(99, 80),
    { notify: false, reason: 'between_thresholds', threshold: null }
  );
  assert.deepEqual(
    funboxStockNotificationDecision(80, 8),
    { notify: true, reason: 'threshold', threshold: 10 }
  );
  assert.deepEqual(
    funboxStockNotificationDecision(8, 0),
    { notify: true, reason: 'sold_out', threshold: 0 }
  );
  assert.deepEqual(
    funboxStockNotificationDecision(0, 50),
    { notify: true, reason: 'restock', threshold: null }
  );
});

test('庫存追蹤關閉時仍更新基線但不推播', async () => {
  const state = { data: {}, async save() {} };
  const payloads = [100, 50].map((stock) => [{
    id: 9015,
    url: '/products/ux-15',
    title: 'BEYBLADE X UX-15',
    price: 699,
    variants: [{ inventory_quantity: stock, inventory_policy: 'deny' }]
  }]);
  let notified = 0;
  const monitor = new FunboxMonitor({
    state,
    fetcher: async () => Response.json(payloads.shift()),
    notify: async () => { notified += 1; }
  });

  await monitor.scan();
  const result = await monitor.scan({ notifyStockChanges: false });

  assert.equal(result.stockChanged, 0);
  assert.equal(result.notified, 0);
  assert.equal(notified, 0);
  assert.equal(state.data.commerce.funbox.seen['ux-15'].stock, 50);
});

test('Funbox 兩個來源即使回傳不同數字 ID，也會以商品網址合併成一件', async () => {
  const state = { data: {}, async save() {} };
  const notifications = [];
  const purchaseCandidates = [];
  const monitor = new FunboxMonitor({
    state,
    sources: [
      { id: 'category', label: '分類 API', url: 'https://shop.funbox.com.tw/category.json' },
      { id: 'collection', label: '集合頁 API', url: 'https://shop.funbox.com.tw/collection.json' }
    ],
    fetcher: async (url) => Response.json([{
      id: url.includes('category') ? 10001 : 90009,
      url: '/products/bb08417',
      title: 'BEYBLADE X BX-50 天堂日輪 隨機強化組',
      price: 350,
      variants: [{ id: 501, inventory_quantity: 83, inventory_policy: 'deny' }]
    }]),
    notify: async (text) => notifications.push(text),
    onPurchaseCandidate: (candidate) => purchaseCandidates.push(candidate)
  });

  await monitor.scan();
  state.data.commerce.funbox.seen = {};
  state.data.commerce.funbox.initialized = true;
  const result = await monitor.scan();

  assert.equal(result.checked, 1);
  assert.equal(result.discovered, 1);
  assert.equal(result.purchaseCandidates.length, 1);
  assert.equal(purchaseCandidates.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(result.products[0].id, 'bb08417');
});

test('舊數字 ID 基線會依網址安全遷移，不把現有商品誤報為新品', async () => {
  const seen = migrateFunboxSeenRecords({
    10001: { url: 'https://shop.funbox.com.tw/products/bb08417', stock: 96, firstSeenAt: '2026-09-04T08:41:17.000Z' },
    bb08417: { url: 'https://shop.funbox.com.tw/products/bb08417', stock: 83, lastSeenAt: '2026-09-04T08:41:48.000Z' }
  });
  assert.deepEqual(Object.keys(seen), ['bb08417']);
  assert.equal(seen.bb08417.stock, 83);
  assert.equal(canonicalFunboxProductId('https://shop.funbox.com.tw/products/BB08417?x=1', '10001'), 'bb08417');
});

test('商品必須在全部健康來源連續缺席兩輪，才結束本次可售狀態', async () => {
  const state = { data: {}, async save() {} };
  let payload = [{
    id: 10001,
    url: '/products/bb08417',
    title: 'BX-50 天堂日輪 隨機強化組',
    price: 350,
    variants: [{ id: 501, inventory_quantity: 20, inventory_policy: 'deny' }]
  }];
  const purchases = [];
  const monitor = new FunboxMonitor({
    state,
    sources: [
      { id: 'category', url: 'https://funbox.test/category.json' },
      { id: 'collection', url: 'https://funbox.test/collection.json' }
    ],
    fetcher: async () => Response.json(payload),
    notify: async () => 'discord-test',
    onPurchaseCandidate: (candidate) => purchases.push(candidate)
  });

  await monitor.scan();
  payload = [];
  await monitor.scan();
  assert.equal(state.data.commerce.funbox.seen.bb08417.available, true);
  await monitor.scan();
  assert.equal(state.data.commerce.funbox.seen.bb08417.available, false);
  payload = [{
    id: 99999,
    url: '/products/bb08417',
    title: 'BX-50 天堂日輪 隨機強化組',
    price: 350,
    variants: [{ id: 501, inventory_quantity: 10, inventory_policy: 'deny' }]
  }];
  const restock = await monitor.scan();
  assert.equal(restock.purchaseCandidates.length, 1);
  assert.equal(restock.purchaseCandidates[0].reason, 'restock');
  assert.equal(purchases.length, 1);
});

test('Funbox 手機摘要優先顯示型號、價格與庫存', () => {
  const product = {
    title: 'BEYBLADE X UX-19 子彈獅鷲H',
    price: 'NT$550',
    stock: 132
  };
  assert.equal(
    funboxDiscordPreview(product),
    '🚨 Funbox 新品上架｜UX-19 子彈獅鷲H\nNT$550｜庫存 132 組'
  );
  assert.equal(
    funboxStockDiscordPreview({ ...product, stock: 10 }, 20),
    '⚠️ Funbox 低庫存｜UX-19 子彈獅鷲H\n庫存 20 → 10 組'
  );
  assert.equal(
    funboxStockDiscordPreview({ ...product, stock: 0 }, 10),
    '🔴 Funbox 已售罄｜UX-19 子彈獅鷲H\n庫存 10 → 0 組'
  );
});
