import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AutoPurchaseCoordinator, EslitePurchaseAdapter, FunboxPurchaseAdapter,
  MultiAccountEslitePurchaseAdapter, MultiAccountFunboxPurchaseAdapter,
  CART_MAINTENANCE_TIMES, ESLITE_SKIP_BUY_KEYWORDS, SHARED_SKIP_BUY_KEYWORDS, FUNBOX_BUY_KEYWORDS, FUNBOX_PURCHASE_STATUS_MESSAGES, FUNBOX_SKIP_BUY_KEYWORDS,
  detectOrderConfirmation,
  formatFunboxAccountBatchNotification, formatFunboxAccountPurchaseNotification, formatPlatformPurchaseNotification,
  funboxPurchaseResultStatus, funboxPurchaseStrategy, normalizeAutoPurchaseConfig, chooseFunboxVirtualAtmOptions,
  purchaseEsliteViaApi
} from '../src/auto-purchase.js';

function passiveLoginPage({ url, present = [], visible = [] }) {
  const presentSet = new Set([...present, ...visible]);
  const visibleSet = new Set(visible);
  let navigations = 0;
  return {
    page: {
      url: () => url,
      isClosed: () => false,
      async goto() { navigations += 1; },
      locator(selector) {
        const locator = {
          first: () => locator,
          count: async () => presentSet.has(selector) ? 1 : 0,
          isVisible: async () => visibleSet.has(selector)
        };
        return locator;
      }
    },
    navigations: () => navigations
  };
}

function funboxAtmLayoutPage({ legacy = false } = {}) {
  const generalSelector = 'button:has-text("一般宅配")';
  const legacySelector = 'a#homeDelivery-shipping-tab';
  const atmSelector = 'button:has-text("虛擬ATM")';
  let generalVisible = !legacy;
  const clicked = [];
  const page = {
    locator(selector) {
      const visible = () => selector === atmSelector
        || (selector === generalSelector && generalVisible)
        || (selector === legacySelector && legacy);
      const locator = {
        first: () => locator,
        count: async () => visible() ? 1 : 0,
        isVisible: async () => visible(),
        isEnabled: async () => true,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {
          clicked.push(selector);
          if (selector === legacySelector) generalVisible = true;
        },
        evaluate: async () => {
          clicked.push(selector);
          if (selector === legacySelector) generalVisible = true;
        }
      };
      return locator;
    },
    async waitForTimeout() {},
    async waitForFunction() {}
  };
  return { page, clicked, generalSelector, legacySelector, atmSelector };
}

test('Funbox ATM 支援新版直接顯示一般宅配，也相容舊版宅配分頁', async () => {
  const direct = funboxAtmLayoutPage();
  const directResult = await chooseFunboxVirtualAtmOptions(direct.page);
  assert.equal(directResult.homeDelivery, null);
  assert.deepEqual(direct.clicked, [direct.generalSelector, direct.atmSelector]);

  const legacy = funboxAtmLayoutPage({ legacy: true });
  const legacyResult = await chooseFunboxVirtualAtmOptions(legacy.page);
  assert.ok(legacyResult.homeDelivery);
  assert.deepEqual(legacy.clicked, [legacy.legacySelector, legacy.generalSelector, legacy.atmSelector]);
});

function fixture({ enabled = true, adapterResult, adapterError, notifyError } = {}) {
  const state = { data: {}, saves: 0, async save() { this.saves += 1; } };
  const calls = [];
  const notifications = [];
  const config = normalizeAutoPurchaseConfig({
    enabled,
    funbox: { enabled: true, action: 'cart', quantity: 1 }
  });
  const adapter = {
    credentialsStatus: () => ({ ready: true, account: 'k***@example.com', realOrderReady: false }),
    async purchase(product, settings) {
      calls.push({ product, settings });
      if (adapterError) throw adapterError;
      return adapterResult || { status: 'carted', quantity: 1, detail: '模擬加入成功' };
    },
    async testLogin() { return { ok: true }; },
    async close() {}
  };
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: { funbox: adapter },
    notifyPrivate: async (message, options) => {
      notifications.push({ message, options });
      if (notifyError) throw notifyError;
    }
  });
  return { state, calls, notifications, coordinator };
}

const product = {
  id: 'ux-15', title: 'UX-15 測試陀螺', url: 'https://shop.funbox.com.tw/products/ux-15',
  stock: 20, reason: 'new_product'
};

test('設定預設關閉並限制數量範圍', () => {
  assert.equal(normalizeAutoPurchaseConfig({}).enabled, false);
  assert.equal(normalizeAutoPurchaseConfig({ funbox: { quantity: 99 } }).funbox.quantity, 3);
  assert.equal(normalizeAutoPurchaseConfig({ eslite: { quantity: 0 } }).eslite.quantity, 1);
  assert.equal('mmtoy' in normalizeAutoPurchaseConfig({ mmtoy: { enabled: true } }), false);
  assert.equal(normalizeAutoPurchaseConfig({ funbox: { payment: 'virtual_atm_home' } }).funbox.payment, 'virtual_atm_home');
  assert.deepEqual(
    normalizeAutoPurchaseConfig({ funbox: { payment: 'virtual_atm_home' } }).funbox.accountPayments,
    { A: 'virtual_atm_home', B: 'virtual_atm_home', C: 'virtual_atm_home' }
  );
  assert.deepEqual(
    normalizeAutoPurchaseConfig({ funbox: {
      payment: 'seven_cod', accountPayments: { A: 'virtual_atm_home', B: 'seven_cod' }
    } }).funbox.accountPayments,
    { A: 'virtual_atm_home', B: 'seven_cod', C: 'seven_cod' }
  );
  assert.equal(normalizeAutoPurchaseConfig({ funbox: { maxAttempts: 99 } }).funbox.maxAttempts, 3);
  assert.equal(normalizeAutoPurchaseConfig({ funbox: { payment: 'unknown' } }).funbox.payment, 'virtual_atm_home');
});

test('訂單成功只接受完成頁、成功文字或訂單編號，不把結帳頁誤判成功', () => {
  assert.equal(detectOrderConfirmation({
    platform: 'eslite', url: 'https://www.eslite.com/cart/step2', bodyText: '確認結帳'
  }).confirmed, false);
  assert.equal(detectOrderConfirmation({
    platform: 'eslite', url: 'https://www.eslite.com/cart/step3?orderid=20260824001234', bodyText: ''
  }).confirmed, true);
  assert.equal(detectOrderConfirmation({
    platform: 'momo', url: 'https://example.com/checkout', bodyText: '訂單已成立 訂單編號：ABCD-123456'
  }).orderId, 'ABCD-123456');
  assert.deepEqual([...CART_MAINTENANCE_TIMES], ['08:50', '13:20']);
});

test('每日購物車保養只處理已啟用且已登入的平台', async () => {
  const state = { data: {}, saves: 0, async save() { this.saves += 1; } };
  const calls = [];
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true, action: 'checkout' },
    eslite: { enabled: false, action: 'checkout' }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: {
      funbox: {
        credentialsStatus: () => ({ ready: true }),
        async maintainSession(options) { calls.push(options); return { ok: true, removed: 2 }; },
        async close() {}
      },
      eslite: {
        credentialsStatus: () => ({ ready: true }),
        async maintainSession() { throw new Error('停用平台不應執行'); },
        async close() {}
      }
    },
    notifyPrivate: async () => {}
  });
  const result = await coordinator.runMaintenance({ clearCart: true, reason: '測試' });
  assert.equal(result.deferred, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].platform, 'funbox');
  assert.equal(result.results[0].result.removed, 2);
  assert.deepEqual(calls, [{ clearCart: true }]);
  assert.equal(state.data.commerce.autoPurchase.maintenance.lastRun.reason, '測試');
  await coordinator.close();
});

test('購買工作執行時每日保養必須延後，避免清空正在結帳的購物車', async () => {
  const { coordinator } = fixture();
  coordinator.activeWorkers = 1;
  const result = await coordinator.runMaintenance({ clearCart: true });
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'purchase_in_progress');
  coordinator.activeWorkers = 0;
  await coordinator.close();
});

test('登入心跳必須同時符合自動下單與平台監控開關，並隨監控切換', async () => {
  const state = { data: {}, async save() {} };
  const monitoring = { funbox: false, eslite: true };
  const calls = { funbox: [], eslite: [] };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true },
    eslite: { enabled: true }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    isPlatformMonitoringEnabled: (platform) => monitoring[platform] === true,
    adapters: {
      funbox: {
        credentialsStatus: () => ({ ready: true }),
        async setWarmPoolEnabled(enabled) { calls.funbox.push(enabled); },
        async close() {}
      },
      eslite: {
        credentialsStatus: () => ({ ready: true }),
        async setWarmPoolEnabled(enabled) { calls.eslite.push(enabled); },
        async close() {}
      }
    },
    notifyPrivate: async () => {}
  });
  try {
    await coordinator.applyRuntimeConfig();
    assert.deepEqual(calls, { funbox: [false], eslite: [true] });

    monitoring.funbox = true;
    monitoring.eslite = false;
    await coordinator.applyRuntimeConfig();
    assert.deepEqual(calls, { funbox: [false, true], eslite: [true, false] });

    config.enabled = false;
    await coordinator.applyRuntimeConfig();
    assert.equal(calls.funbox.at(-1), false);
    assert.equal(calls.eslite.at(-1), false);
  } finally {
    await coordinator.close();
  }
});

test('平台監控關閉時每日保養不會觸發登入', async () => {
  const state = { data: {}, async save() {} };
  let maintenanceCalls = 0;
  const config = normalizeAutoPurchaseConfig({ enabled: true, eslite: { enabled: true } });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    isPlatformMonitoringEnabled: () => false,
    adapters: {
      eslite: {
        credentialsStatus: () => ({ ready: true }),
        async maintainSession() { maintenanceCalls += 1; return { ok: true }; },
        async close() {}
      }
    },
    notifyPrivate: async () => {}
  });
  try {
    const result = await coordinator.runMaintenance({ clearCart: true });
    assert.equal(result.results.length, 0);
    assert.equal(maintenanceCalls, 0);
  } finally {
    await coordinator.close();
  }
});

test('全部停止會清空待處理工作、關閉各平台並拒絕新工作，恢復後重新套用執行設定', async () => {
  const state = { data: {}, async save() {} };
  const calls = { close: 0, warm: [] };
  const config = normalizeAutoPurchaseConfig({ enabled: true, funbox: { enabled: true } });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: {
      funbox: {
        credentialsStatus: () => ({ ready: true }),
        async setWarmPoolEnabled(enabled) { calls.warm.push(enabled); },
        async close() { calls.close += 1; }
      }
    },
    notifyPrivate: async () => {}
  });
  coordinator.queue.push({ platform: 'funbox', product });
  coordinator.queuedKeys.add('funbox:ux-15');
  coordinator.funboxPendingWave.set('ux-15', product);

  const paused = await coordinator.suspend();
  assert.equal(paused.paused, true);
  assert.equal(paused.queued, 0);
  assert.equal(calls.close, 1);
  assert.equal((await coordinator.enqueue('funbox', [product])).reason, 'system_paused');

  const resumed = await coordinator.resume();
  assert.equal(resumed.paused, false);
  assert.equal(calls.warm.at(-1), true);
  await coordinator.close();
});

test('誠品手動驗收固定為 verifyOnly 並留下送單前紀錄', async () => {
  const state = { data: {}, saves: 0, async save() { this.saves += 1; } };
  const calls = [];
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    eslite: { enabled: true, action: 'checkout', quantity: 1 }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: {
      eslite: {
        credentialsStatus: () => ({ ready: true }),
        async purchase(item, settings) {
          calls.push({ item, settings });
          return { status: 'checkout_ready', quantity: 1, detail: '送單前就緒' };
        },
        async close() {}
      }
    },
    notifyPrivate: async () => {}
  });
  try {
    const result = await coordinator.runPlatformPreflight('eslite', {
      id: '1001', title: '誠品測試商品', url: 'https://www.eslite.com/product/1001', stock: 1
    }, { evidencePath: 'evidence.png' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].settings.verifyOnly, true);
    assert.equal(calls[0].settings.action, 'checkout');
    assert.equal(state.data.commerce.autoPurchase.recent[0].manualPreflight, true);
    assert.equal(state.data.commerce.autoPurchase.recent[0].status, 'checkout_ready');
  } finally {
    await coordinator.close();
  }
});

test('誠品五品項以可用帳號獨立並行，空白 C 不參與且各自套用付款策略', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-multi-'));
  try {
    const accounts = [
      { slot: 'A', account: 'a', password: 'a', enabled: true },
      { slot: 'B', account: 'b', password: 'b', enabled: true },
      { slot: 'C', account: '', password: '', enabled: true }
    ];
    const adapter = new MultiAccountEslitePurchaseAdapter({ dataDir: directory, getAccounts: () => accounts });
    let active = 0;
    let peak = 0;
    const calls = [];
    for (const slot of ['A', 'B', 'C']) {
      adapter.adapters[slot] = {
        credentialsStatus: () => ({ ready: slot !== 'C' }),
        purchase: async (product, settings) => {
          active += 1;
          peak = Math.max(peak, active);
          calls.push({ slot, id: product.id, payment: settings.payment });
          // Keep the mocked checkout alive beyond the intentional B-lane 350 ms
          // start stagger so the test still proves real A/B overlap.
          await new Promise((resolve) => setTimeout(resolve, 500));
          active -= 1;
          return { status: 'checkout_ready', detail: '模擬到最終送出前' };
        },
        close: async () => {}
      };
    }
    const products = Array.from({ length: 5 }, (_, index) => ({ id: `P${index + 1}`, title: `誠品商品 ${index + 1}`, url: `https://www.eslite.com/product/${index + 1}` }));
    const results = await Promise.all(products.map((product) => adapter.purchase(product, {
      payment: 'seven_cod', accountPayments: { A: 'seven_cod', B: 'virtual_atm_home' }
    })));
    assert.equal(results.length, 5);
    assert.equal(peak, 2);
    assert.deepEqual([...new Set(calls.map((call) => call.slot))].sort(), ['A', 'B']);
    assert.ok(calls.filter((call) => call.slot === 'A').every((call) => call.payment === 'seven_cod'));
    assert.ok(calls.filter((call) => call.slot === 'B').every((call) => call.payment === 'virtual_atm_home'));
    assert.equal(calls.some((call) => call.slot === 'C'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Funbox 黑名單優先、白名單決定是否購買，並保留一般一組與隨機三組', () => {
  const normal = funboxPurchaseStrategy({ title: 'BEYBLADE X UX-21 惡魔冥界改造組' });
  assert.equal(normal.eligible, true);
  assert.equal(normal.quantity, 1);
  assert.equal(normal.matchedKeyword, 'UX-21');
  assert.equal(normal.priority, FUNBOX_BUY_KEYWORDS.indexOf('UX-21'));

  const random = funboxPurchaseStrategy({ title: 'BEYBLADE X BX-35 隨機強化組 Vol.04' });
  assert.equal(random.eligible, true);
  assert.equal(random.quantity, 3);
  assert.equal(random.rule, 'random_booster');

  const skipped = funboxPurchaseStrategy({ title: 'BEYBLADE X BXG-33 路克天行者' });
  assert.equal(skipped.eligible, false);
  assert.equal(skipped.rule, 'skip_keyword');
  assert.equal(skipped.matchedKeyword, 'BXG-33');

  const allowedBxg = funboxPurchaseStrategy({ title: 'BEYBLADE X BXG-22 測試商品' });
  assert.equal(allowedBxg.eligible, true);
  assert.equal(allowedBxg.matchedKeyword, 'BXG-22');

  const unknown = funboxPurchaseStrategy({ title: 'BEYBLADE X BX-99 未列入品項' });
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.rule, 'not_whitelisted');
});

test('Funbox UI 規則可儲存自訂黑白名單且保留輸入順序', () => {
  const config = normalizeAutoPurchaseConfig({ funbox: {
    skipBuyKeywords: ['測試跳過', 'BX-09'],
    buyKeywords: ['UX-21', 'BX-35', 'UX-21']
  } });
  assert.deepEqual(config.funbox.skipBuyKeywords, ['測試跳過', 'BX-09']);
  assert.deepEqual(config.funbox.buyKeywords, ['UX-21', 'BX-35']);
  assert.ok(FUNBOX_SKIP_BUY_KEYWORDS.includes('暴風天馬'));
});

test('誠品預設排除 BX-10 且可儲存自訂黑名單', () => {
  assert.deepEqual(normalizeAutoPurchaseConfig({}).eslite.skipBuyKeywords, [...ESLITE_SKIP_BUY_KEYWORDS, ...SHARED_SKIP_BUY_KEYWORDS]);
  const config = normalizeAutoPurchaseConfig({ eslite: { skipBuyKeywords: ['BX-10', '戰鬥盤', 'BX-10'] } });
  assert.deepEqual(config.eslite.skipBuyKeywords, ['BX-10', '戰鬥盤']);
});

test('誠品黑名單不進佇列且其餘商品保持先到先處理', async () => {
  const state = { data: {}, async save() {} };
  const calls = [];
  const adapter = {
    maxConcurrency: 3,
    credentialsStatus: () => ({ ready: true, account: '3/3 組已設定' }),
    async purchase(product) {
      calls.push(product.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 'ordered', quantity: 1, detail: '完成' };
    },
    async close() {}
  };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    eslite: { enabled: true, action: 'checkout', quantity: 1, skipBuyKeywords: ['BX-10'] }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state, getConfig: () => config, adapters: { eslite: adapter }, notifyPrivate: async () => {}
  });
  const products = [
    ['ux20', 'UX-20 榮耀武神 LF'],
    ['bx10', 'BX-10 極限衝擊戰鬥盤'],
    ['ux15', 'UX-15 鮫鯊狂鱗改造組'],
    ['cx19', 'CX-19 鱷魚裂甲'],
    ['cx11', 'CX-11 帝王威能']
  ].map(([id, title]) => ({ id, title, url: `https://www.eslite.com/product/${id}` }));
  const queued = await coordinator.enqueue('eslite', products);
  await coordinator.whenIdle();
  assert.equal(queued.accepted, 4);
  assert.equal(queued.excluded, 1);
  assert.deepEqual(calls, ['ux20', 'ux15', 'cx19', 'cx11']);
  await coordinator.close();
});

test('Funbox 購買結果會轉成清楚的終止狀態', () => {
  assert.equal(funboxPurchaseResultStatus({ status: 'ordered' }), 'success');
  assert.equal(funboxPurchaseResultStatus({ resultUrl: 'https://shop.funbox.com.tw/orders/1?show_failed=yes' }), 'payment_failed');
  assert.equal(funboxPurchaseResultStatus({ detail: '等待銀行 3DS 驗證' }), '3ds_pending');
  assert.equal(funboxPurchaseResultStatus({ error: 'CYBERBIZ 每人限購一組' }), 'checkout_limited');
  assert.equal(funboxPurchaseResultStatus({ error: '加入購物車 HTTP 409' }), 'inventory_conflict');
  assert.equal(funboxPurchaseResultStatus({ status: 'failed', error: '加入購物車 HTTP 409' }), 'inventory_conflict');
  assert.equal(funboxPurchaseResultStatus({ status: 'carted' }), 'cart');
  assert.equal(funboxPurchaseResultStatus({ error: '未知錯誤' }), 'failed');
  assert.equal(Object.keys(FUNBOX_PURCHASE_STATUS_MESSAGES).length, 11);
  assert.equal(funboxPurchaseResultStatus({ status: 'submitted_unconfirmed' }), 'submitted_unconfirmed');
});

test('Funbox 私人通知依帳號清楚顯示成功單號或失敗原因', () => {
  const success = formatFunboxAccountPurchaseNotification(product, {
    slot: 'A', ok: true, status: 'ordered', quantity: 1,
    orderNumber: 'ORDER-A123456', durationMs: 9329,
    payment: 'seven_cod'
  });
  assert.match(success.text, /^自動購買成功｜FUNBOX官網/m);
  assert.match(success.text, /帳號A｜7-11 貨到付款/);
  assert.match(success.text, /購物車內容：\n• \[UX-15 測試陀螺\]\(https:\/\/shop\.funbox\.com\.tw\/products\/ux-15\) ×1/);
  assert.match(success.text, /成功單號：ORDER-A123456/);
  assert.match(success.text, /耗時：9\.33 秒/);

  const atm = formatFunboxAccountPurchaseNotification(product, {
    slot: 'C', ok: true, status: 'ordered', quantity: 1,
    payment: 'virtual_atm_home',
    orderNumber: 'ATM-C123456', paymentDeadline: '2026/08/27 23:59',
    paymentUrl: 'https://shop.funbox.com.tw/orders/ATM-C123456',
    productResults: [{ product, quantity: 1, status: 'ordered' }]
  });
  assert.match(atm.text, /帳號C｜虛擬 ATM/);
  assert.match(atm.text, /付款期限：2026\/08\/27 23:59/);
  assert.match(atm.text, /結帳連結：https:\/\/shop\.funbox\.com\.tw\/orders\/ATM-C123456/);
  assert.match(atm.text, /購物車內容：\n• \[UX-15 測試陀螺\].* ×1/);

  const failure = formatFunboxAccountPurchaseNotification(product, {
    slot: 'B', ok: false, status: 'failed', error: '加入購物車 HTTP 409'
  });
  assert.match(failure.text, /^自動購買失敗｜FUNBOX官網/m);
  assert.match(failure.text, /帳號B｜FUNBOX官網/);
  assert.match(failure.text, /購買品項：\[UX-15 測試陀螺\]/);
  assert.match(failure.text, /失敗原因：加入購物車 HTTP 409/);
});

test('Funbox ATM 合單通知逐張列出單號、購物車內容與結帳連結', () => {
  const secondProduct = {
    id: 'cx-11', title: 'CX-11 測試陀螺',
    url: 'https://shop.funbox.com.tw/products/cx-11'
  };
  const message = formatFunboxAccountBatchNotification([product, secondProduct], {
    slot: 'B', ok: true, payment: 'virtual_atm_home',
    products: [product, secondProduct], deferredProducts: [],
    waves: [{
      status: 'ordered', orderNumber: 'ATM-B654321',
      paymentUrl: 'https://shop.funbox.com.tw/orders/ATM-B654321',
      paymentDeadline: '2026/10/03 23:59',
      products: [product, secondProduct],
      productResults: [
        { product, quantity: 1, status: 'ordered' },
        { product: secondProduct, quantity: 2, status: 'ordered' }
      ]
    }]
  });
  assert.match(message.text, /帳號B｜虛擬 ATM/);
  assert.match(message.text, /成功單號：ATM-B654321/);
  assert.match(message.text, /UX-15 測試陀螺.* ×1/);
  assert.match(message.text, /CX-11 測試陀螺.* ×2/);
  assert.match(message.text, /結帳連結：https:\/\/shop\.funbox\.com\.tw\/orders\/ATM-B654321/);
  assert.match(message.text, /付款期限：2026\/10\/03 23:59/);
});

test('誠品、momo 與墊腳石自動下單都統一顯示成功單號或失敗原因', () => {
  const samples = [
    ['eslite', '誠品線上', 'ESLITE-63097'],
    ['momo', 'momo購物網', 'MOMO-15462753'],
    ['kingstone', '墊腳石購物網', 'TCSB-778899']
  ];
  for (const [platform, label, orderNumber] of samples) {
    const success = formatPlatformPurchaseNotification(platform, product, {
      status: 'ordered', quantity: 1, orderNumber
    });
    assert.match(success.text, new RegExp(`^自動購買成功｜${label}`, 'm'));
    assert.match(success.text, /帳號A｜［UX-15 測試陀螺］/);
    assert.match(success.text, new RegExp(`成功單號：${orderNumber}`));

    const failure = formatPlatformPurchaseNotification(platform, product, {
      status: 'failed', error: '商品已售完'
    });
    assert.match(failure.text, new RegExp(`^自動購買失敗｜${label}`, 'm'));
    assert.match(failure.text, /失敗原因：商品已售完/);
  }
});

test('未確認成立與只加入購物車都不會誤報為購買成功', () => {
  const unconfirmed = formatPlatformPurchaseNotification('eslite', product, {
    status: 'submitted_unconfirmed', detail: '已按下確認結帳，但未讀到完成頁'
  });
  const carted = formatPlatformPurchaseNotification('momo', product, {
    status: 'carted', detail: '已加入購物車'
  });
  assert.match(unconfirmed.text, /^訂單結果待核對｜誠品線上/m);
  assert.match(carted.text, /^自動購買失敗｜momo購物網/m);
});

test('Funbox BXG 只保留公開通知候選，不會排入私人購買佇列', async () => {
  const { coordinator, calls } = fixture();
  const result = await coordinator.enqueue('funbox', [{
    id: 'bxg-33', title: 'BEYBLADE X BXG-33 路克天行者',
    url: 'https://shop.funbox.com.tw/products/bxg-33'
  }]);
  await coordinator.whenIdle();
  assert.equal(result.accepted, 0);
  assert.equal(result.excluded, 1);
  assert.equal(calls.length, 0);
});

test('購物平台使用固定專用瀏覽器資料夾並一次性移轉舊 session', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-browser-profile-'));
  const sessionFile = path.join(dataDir, 'auto-purchase', 'funbox-session.json');
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, JSON.stringify({ cookies: [{ name: 'sid', value: 'old', domain: '.funbox.com.tw', path: '/' }] }));
  const launched = [];
  const imported = [];
  const context = {
    async addInitScript() {},
    async addCookies(cookies) { imported.push(...cookies); }
  };
  try {
    const adapter = new FunboxPurchaseAdapter({
      dataDir,
      persistentContextLauncher: async (directory, options) => {
        launched.push({ directory, options });
        return context;
      }
    });
    assert.equal(await adapter._context(sessionFile), context);
    assert.equal(await adapter._context(sessionFile), context);
    assert.equal(launched.length, 2);
    assert.match(launched[0].directory, /browser-profiles[\\/]funbox$/);
    assert.equal(launched[0].options.channel, 'chrome');
    assert.equal('userAgent' in launched[0].options, false);
    assert.equal(imported.length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('互動登入失敗時保留視窗，使用者完成後才儲存並關閉', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-interactive-login-'));
  let contextClosed = 0;
  let storageSaved = 0;
  let pageClosedHandler = () => {};
  const page = {
    url: () => 'https://www.eslite.com/login',
    once(event, handler) { if (event === 'close') pageClosedHandler = handler; },
    isClosed: () => false
  };
  const context = {
    async newPage() { return page; },
    async storageState() { storageSaved += 1; },
    async close() { contextClosed += 1; pageClosedHandler(); }
  };
  const adapter = new FunboxPurchaseAdapter({ dataDir });
  adapter._context = async () => context;
  adapter._login = async () => { throw new Error('需要圖形驗證'); };
  adapter._loggedIn = async () => true;
  try {
    const pending = await adapter.testLogin({ interactive: true });
    assert.equal(pending.pending, true);
    assert.equal(contextClosed, 0);
    assert.match(pending.message, /視窗會保持開啟/);

    const completed = await adapter.completeLogin();
    assert.equal(completed.ok, true);
    assert.equal(storageSaved, 1);
    assert.equal(contextClosed, 1);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品登入心跳可辨識 session 失效並回報重新登入', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-heartbeat-'));
  const adapter = new EslitePurchaseAdapter({
    dataDir,
    getCredentials: () => ({ account: 'member', password: 'secret' }),
    apiSessionVerifier: async () => ({
      ok: false, loggedIn: false, status: 401,
      reason: '誠品登入已失效，請重新完成官方登入驗證'
    })
  });
  try {
    const result = await adapter.verifyStoredSession();
    assert.equal(result.loggedIn, false);
    assert.equal(adapter.runtimeStatus().loginState, 'needs_login');
    assert.match(adapter.runtimeStatus().lastVerifyError, /登入已失效/);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品 A B C API 登入心跳輕量錯開，不開啟工作瀏覽器', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-heartbeat-lanes-'));
  const adapters = ['A', 'B', 'C'].map((slot) => new EslitePurchaseAdapter({
    dataDir,
    accountSlot: slot,
    getCredentials: () => ({ account: `member-${slot}`, password: 'secret' })
  }));
  try {
    const before = Date.now();
    await Promise.all(adapters.map((adapter) => adapter.setWarmPoolEnabled(true)));
    const delays = adapters.map((adapter) => Date.parse(adapter.runtimeStatus().nextVerifyAt) - before);
    assert.ok(delays[0] >= 2400 && delays[0] < 5000);
    assert.ok(delays[1] - delays[0] >= 1400);
    assert.ok(delays[2] - delays[1] >= 1400);
  } finally {
    await Promise.all(adapters.map((adapter) => adapter.close()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品心跳平常十分鐘，掃描出現變化後暫時切為九十秒', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-adaptive-heartbeat-'));
  const adapter = new EslitePurchaseAdapter({
    dataDir,
    getCredentials: () => ({ account: 'member', password: 'secret' })
  });
  try {
    adapter.sessionHeartbeatEnabled = true;
    adapter.apiContext = { async dispose() {} };
    adapter.apiCartKnownEmpty = true;
    adapter.apiReadyAtMs = Date.now();
    adapter.nextVerifyAt = new Date(Date.now() + 10 * 60_000).toISOString();
    assert.equal(adapter.runtimeStatus().heartbeatMode, 'normal');
    assert.equal(adapter.runtimeStatus().heartbeatIntervalSeconds, 600);
    const before = Date.now();
    adapter.noteActivity({ durationMs: 5 * 60_000 });
    const status = adapter.runtimeStatus();
    assert.equal(status.heartbeatMode, 'accelerated');
    assert.equal(status.heartbeatIntervalSeconds, 90);
    const nextDelayMs = Date.parse(status.nextVerifyAt) - before;
    assert.ok(nextDelayMs >= 89_000 && nextDelayMs <= 91_000);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品背景心跳被 Cloudflare 擋下時保留已確認的登入狀態', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-heartbeat-blocked-'));
  const adapter = new EslitePurchaseAdapter({
    dataDir,
    getCredentials: () => ({ account: 'member', password: 'secret' }),
    apiSessionVerifier: async () => ({
      ok: false, loggedIn: null, status: 403,
      reason: '誠品會員 API 暫時受限（HTTP 403），保留既有登入狀態'
    })
  });
  adapter._markLoginReady();
  try {
    const result = await adapter.verifyStoredSession();
    assert.equal(result.loggedIn, null);
    assert.equal(adapter.runtimeStatus().loginState, 'ready');
    assert.match(adapter.runtimeStatus().lastVerifyError, /Cloudflare|HTTP 403/);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品會員 API 回傳身分時可在不開瀏覽器下確認登入', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-member-shell-'));
  const adapter = new EslitePurchaseAdapter({
    dataDir,
    getCredentials: () => ({ account: 'member', password: 'secret' }),
    apiSessionVerifier: async () => ({ ok: true, loggedIn: true, status: 200, durationMs: 123 })
  });
  try {
    const result = await adapter.verifyStoredSession();
    assert.equal(result.loggedIn, true);
    assert.equal(adapter.runtimeStatus().loginState, 'ready');
    assert.match(adapter.runtimeStatus().lastHeartbeatResult, /登入正常（API 123ms）/);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品 API 下單會先核對會員與獨立購物車，再送出一次訂單', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-api-order-'));
  const sessionFile = path.join(dataDir, 'session.json');
  await fs.writeFile(sessionFile, JSON.stringify({
    cookies: [],
    origins: [{
      origin: 'https://www.eslite.com',
      localStorage: [{ name: 'auth._token.prd', value: 'Bearer%20test-token' }]
    }]
  }));
  const calls = [];
  const response = (status, body) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => body });
  const requestFactory = {
    async newContext() {
      return {
        async get(url) {
          calls.push(['GET', url]);
          if (url.startsWith('/api/v2/member?')) return response(200, { id: 1 });
          return response(200, { cart: { cart_items: [] } });
        },
        async post(url) {
          calls.push(['POST', url]);
          if (url === '/api/v2/cart/items') {
            return response(200, { product_guid: 'target', request_quantity: 1, response_quantity: 1 });
          }
          return response(200, { order_id: 'ORDER-123456' });
        },
        async delete() { throw new Error('空購物車不應執行刪除'); },
        async dispose() {}
      };
    }
  };
  try {
    const result = await purchaseEsliteViaApi({
      sessionFile,
      product: { id: 'target', stock: 1 },
      settings: { action: 'checkout', quantity: 1 },
      checkoutTemplate: { checkout: { payment: '8', delivery: '5' } },
      requestFactory
    });
    assert.equal(result.status, 'ordered');
    assert.equal(result.orderId, 'ORDER-123456');
    assert.equal(calls.filter(([, url]) => url === '/api/v1/orders/checkout').length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品 API 送單逾時視為結果不明並禁止自動重送', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-api-uncertain-'));
  const sessionFile = path.join(dataDir, 'session.json');
  await fs.writeFile(sessionFile, JSON.stringify({
    cookies: [], origins: [{ origin: 'https://www.eslite.com', localStorage: [{ name: 'auth._token.prd', value: 'Bearer test' }] }]
  }));
  let checkoutCalls = 0;
  const response = (body) => ({ status: () => 200, ok: () => true, json: async () => body });
  const requestFactory = {
    async newContext() {
      return {
        async get(url) {
          return url.startsWith('/api/v2/member?') ? response({ id: 1 }) : response({ cart: { cart_items: [] } });
        },
        async post(url) {
          if (url === '/api/v2/cart/items') return response({ product_guid: 'target', response_quantity: 1 });
          checkoutCalls += 1;
          throw new Error('timeout');
        },
        async dispose() {}
      };
    }
  };
  try {
    const result = await purchaseEsliteViaApi({
      sessionFile,
      product: { id: 'target', stock: 1 },
      settings: { action: 'checkout', quantity: 1 },
      checkoutTemplate: { checkout: { payment: '8', delivery: '5' } },
      requestFactory
    });
    assert.equal(result.status, 'submitted_unconfirmed');
    assert.equal(checkoutCalls, 1);
    assert.match(result.detail, /禁止自動重送/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品預熱快線仍先 API 核對空車，再加車結帳，且不重建用戶端', async () => {
  const calls = [];
  const response = (body) => ({ status: () => 200, ok: () => true, json: async () => body });
  const apiContext = {
    async get(url, options) { calls.push({url,timeout:options.timeout}); return response({cart:{cart_items:[]}}); },
    async post(url, options) {
      calls.push({ url, timeout: options.timeout });
      if (url === '/api/v2/cart/items') {
        return response({ product_guid: 'fast-target', response_quantity: 1 });
      }
      return response({ order_id: 'FAST-ORDER-1' });
    }
  };
  const result = await purchaseEsliteViaApi({
    sessionFile: '不應讀取.json',
    product: { id: 'fast-target', stock: 1 },
    settings: { action: 'checkout', quantity: 1 },
    checkoutTemplate: { checkout: { payment: '8', delivery: '5' } },
    apiContext,
    prevalidated: true
  });
  assert.equal(result.status, 'ordered');
  assert.ok(calls[0].url.startsWith('/api/v2/cart/items?'));
  assert.deepEqual(calls.slice(1).map((call) => call.url), ['/api/v2/cart/items', '/api/v1/orders/checkout']);
  assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 15000));
  assert.ok(calls[0].timeout <= 5000); // Add stays bounded; checkout can wait without resubmitting.
  assert.equal(result.timings.prevalidated, true);
});

test('誠品六秒期限用完時不會再送出結帳請求', async () => {
  let clock = 0;
  const calls = [];
  const response = (body) => ({ status: () => 200, ok: () => true, json: async () => body });
  const apiContext = {
    async get() { return response({cart:{cart_items:[]}}); },
    async post(url) {
      calls.push(url);
      if (url === '/api/v2/cart/items') {
        clock = 6001;
        return response({ product_guid: 'slow-target', response_quantity: 1 });
      }
      return response({ order_id: 'SHOULD-NOT-EXIST' });
    }
  };
  await assert.rejects(purchaseEsliteViaApi({
    sessionFile: '不應讀取.json',
    product: { id: 'slow-target', stock: 1 },
    settings: { action: 'checkout', quantity: 1 },
    checkoutTemplate: { checkout: { payment: '8', delivery: '5' } },
    apiContext,
    prevalidated: true,
    deadlineMs: 6000,
    now: () => clock
  }), (error) => error.purchaseStatus === 'deadline_exceeded');
  assert.deepEqual(calls, ['/api/v2/cart/items']);
});

test('誠品冷帳號直接在交易內確認會員與空車，不重複暖機；成功後沿用登入', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-fast-ready-'));
  const sessionFile = path.join(dataDir, 'auto-purchase', 'eslite-session.json');
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, '{}');
  const apiContext = { async dispose() {} };
  let purchases = 0;
  const adapter = new EslitePurchaseAdapter({
    dataDir,
    getCredentials: () => ({ account: 'member', password: 'secret' }),
    getCheckoutTemplate: () => ({ paymentMode: 'seven_cod', checkout: { payment: '8' } }),
    apiContextFactory: async () => ({ api: apiContext, expiresAtMs: Date.now() + 60_000 }),
    apiMaintenanceRunner: async () => assert.fail('購買不再先跑預熱清車'),
    apiPurchaseRunner: async (options) => {
      assert.equal(options.apiContext, apiContext);
      assert.equal(options.prevalidated, purchases++ > 0);
      assert.ok(options.deadlineMs > 3000 && options.deadlineMs <= 30000);
      return { status: 'ordered', orderId: 'READY-ORDER-1', timings: {} };
    }
  });
  try {
    const first = await adapter.purchase({ id: 'target', stock: 1 }, {
      action: 'checkout', quantity: 1, payment: 'seven_cod'
    });
    assert.equal(first.status, 'ordered');
    assert.equal(adapter.runtimeStatus().apiReady, true);
    const result = await adapter.purchase({ id: 'target', stock: 1 }, {
      action: 'checkout', quantity: 1, payment: 'seven_cod'
    });
    assert.equal(result.status, 'ordered');
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品購物車核對會阻止混入其他商品或數量錯誤', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-cart-isolation-'));
  const adapter = new EslitePurchaseAdapter({ dataDir });
  const target = { id: '1001', url: 'https://www.eslite.com/product/1001' };
  try {
    adapter._readCartSnapshot = async () => ({
      expectedPresent: true, expectedQuantity: 1, itemCount: 1,
      itemUrls: [target.url]
    });
    assert.equal((await adapter._verifyOwnCart({}, target, 1)).itemCount, 1);

    adapter._readCartSnapshot = async () => ({
      expectedPresent: true, expectedQuantity: 1, itemCount: 2,
      itemUrls: [target.url, 'https://www.eslite.com/product/other']
    });
    await assert.rejects(adapter._verifyOwnCart({}, target, 1),
      (error) => error.purchaseStatus === 'cart_conflict' && /混入其他商品/.test(error.message));

    adapter._readCartSnapshot = async () => ({
      expectedPresent: true, expectedQuantity: 2, itemCount: 1,
      itemUrls: [target.url]
    });
    await assert.rejects(adapter._verifyOwnCart({}, target, 1),
      (error) => error.purchaseStatus === 'cart_conflict' && /數量不符/.test(error.message));
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('誠品登入保養與下單共用單一帳號鎖，不會互相清車', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-eslite-account-lock-'));
  const adapter = new EslitePurchaseAdapter({ dataDir });
  const events = [];
  try {
    let releaseFirst;
    const first = adapter._withAccountLock(async () => {
      events.push('first-start');
      await new Promise((resolve) => { releaseFirst = resolve; });
      events.push('first-end');
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = adapter._withAccountLock(async () => { events.push('second'); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('主開關關閉時不執行任何購買', async () => {
  const { coordinator, calls } = fixture({ enabled: false });
  const result = await coordinator.enqueue('funbox', [product]);
  await coordinator.whenIdle();
  assert.equal(result.accepted, 0);
  assert.equal(calls.length, 0);
});

test('候選商品只處理一次，完成結果只送私人通知', async () => {
  const { coordinator, calls, notifications, state } = fixture();
  assert.equal((await coordinator.enqueue('funbox', [product])).accepted, 1);
  await coordinator.whenIdle();
  assert.equal(calls.length, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /^自動購買失敗｜FUNBOX官網/m);
  assert.match(notifications[0].message, /失敗原因：模擬加入成功/);
  assert.equal(notifications[0].options.discordAudience, 'private');
  assert.equal(state.data.commerce.autoPurchase.records['funbox:ux-15'].status, 'carted');

  assert.equal((await coordinator.enqueue('funbox', [product])).accepted, 0);
  await coordinator.whenIdle();
  assert.equal(calls.length, 1);
});

test('私人 Discord 失敗不會推翻已完成的購物結果', async () => {
  const { coordinator, state } = fixture({ notifyError: new Error('Discord 暫時無法連線') });
  await coordinator.enqueue('funbox', [product]);
  await coordinator.whenIdle();
  assert.equal(state.data.commerce.autoPurchase.records['funbox:ux-15'].status, 'carted');
});

test('Funbox 隨機強化組固定優先嘗試三組，且使用獨立工作器', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-random-booster-'));
  const quantities = [];
  let released = 0;
  const response = { ok: () => true, status: () => 200 };
  const page = {
    async close() {},
    async waitForTimeout() {}
  };
  const context = {
    async newPage() { return page; },
    request: {
      async get() { return { url: () => 'https://shop.funbox.com.tw/carts/test' }; }
    }
  };
  const worker = { context, busy: true, authenticatedAt: Date.now() };
  const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
  adapter._acquireWarmWorker = async () => worker;
  adapter._ensureWarmWorkerLogin = async () => {};
  let cleared = 0;
  adapter._clearCart = async () => { cleared += 1; return 0; };
  adapter._postCartAdd = async (_context, _variantId, quantity) => {
    quantities.push(quantity);
    return { response, body: '{}' };
  };
  adapter._releaseWarmWorker = async () => { released += 1; };
  try {
    const result = await adapter.purchase({
      id: 'bx-35',
      title: 'BEYBLADE X BX-35 隨機強化組 Vol.04',
      url: 'https://shop.funbox.com.tw/products/bx-35',
      variantId: 'variant-35',
      stock: 192
    }, { action: 'cart', quantity: 1 });
    assert.equal(result.status, 'carted');
    assert.equal(result.quantity, 3);
    assert.deepEqual(quantities, [3]);
    assert.equal(cleared, 1);
    assert.equal(released, 1);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 隨機強化組三組被拒絕時立即降為一組，不放棄商品', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-random-fallback-'));
  const quantities = [];
  const page = { async close() {}, async waitForTimeout() {} };
  const context = {
    async newPage() { return page; },
    request: { async get() { return { url: () => 'https://shop.funbox.com.tw/carts/test' }; } }
  };
  const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
  adapter._acquireWarmWorker = async () => ({ context, busy: true, authenticatedAt: Date.now() });
  adapter._ensureWarmWorkerLogin = async () => {};
  adapter._clearCart = async () => {};
  adapter._releaseWarmWorker = async () => {};
  adapter._postCartAdd = async (_context, _variantId, quantity) => {
    quantities.push(quantity);
    const ok = quantity === 1;
    return { response: { ok: () => ok, status: () => ok ? 200 : 409 }, body: ok ? '{}' : '超過可購買數量' };
  };
  try {
    const result = await adapter.purchase({
      id: 'bx-48', title: 'BX-48 隨機強化組 Vol.09',
      url: 'https://shop.funbox.com.tw/products/bx-48', variantId: 'variant-48', stock: 3
    }, { action: 'cart', quantity: 1 });
    assert.equal(result.quantity, 1);
    assert.deepEqual(quantities, [3, 1]);
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 409 且即時庫存仍存在時標記不同步，不誤報售罄', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-inventory-conflict-'));
  const page = { async close() {}, async waitForTimeout() {} };
  const context = {
    async newPage() { return page; },
    request: { async get() { return { url: () => 'https://shop.funbox.com.tw/carts/test' }; } }
  };
  const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
  adapter._acquireWarmWorker = async () => ({ context, busy: true, authenticatedAt: Date.now() });
  adapter._ensureWarmWorkerLogin = async () => {};
  adapter._clearCart = async () => 0;
  adapter._releaseWarmWorker = async () => {};
  adapter._refreshPurchasableVariant = async () => ({ available: true, variantId: 'variant-21', stock: 20, qtyCap: null });
  adapter._postCartAdd = async () => ({
    response: { ok: () => false, status: () => 409 },
    body: '部分商品超出庫存'
  });
  try {
    await assert.rejects(
      adapter.purchase({
        id: 'bb08554', title: 'UX-21 惡魔冥界改造組',
        url: 'https://shop.funbox.com.tw/products/bb08554', variantId: 'variant-21', stock: 20
      }, { action: 'cart', quantity: 1 }),
      (error) => error.purchaseStatus === 'inventory_conflict' && /無法配置庫存/.test(error.message)
    );
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 409 後單品即時庫存為零才標記售罄', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-stock-out-'));
  const page = { async close() {}, async waitForTimeout() {} };
  const context = { async newPage() { return page; } };
  const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
  adapter._acquireWarmWorker = async () => ({ context, busy: true, authenticatedAt: Date.now() });
  adapter._ensureWarmWorkerLogin = async () => {};
  adapter._clearCart = async () => 0;
  adapter._releaseWarmWorker = async () => {};
  adapter._refreshPurchasableVariant = async () => ({ available: false, variantId: null, stock: 0, qtyCap: null });
  adapter._postCartAdd = async () => ({
    response: { ok: () => false, status: () => 409 },
    body: '部分商品超出庫存'
  });
  try {
    await assert.rejects(
      adapter.purchase({
        id: 'bb08554', title: 'UX-21 惡魔冥界改造組',
        url: 'https://shop.funbox.com.tw/products/bb08554', variantId: 'variant-21', stock: 20
      }, { action: 'cart', quantity: 1 }),
      (error) => error.purchaseStatus === 'stock_out' && /庫存已為 0/.test(error.message)
    );
  } finally {
    await adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('購買失敗會留下失敗紀錄且不影響工作佇列', async () => {
  const { coordinator, state, notifications } = fixture({ adapterError: new Error('模擬網站改版') });
  await coordinator.enqueue('funbox', [product]);
  await coordinator.whenIdle();
  assert.equal(state.data.commerce.autoPurchase.records['funbox:ux-15'].status, 'failed');
  assert.equal(state.data.commerce.autoPurchase.records['funbox:ux-15'].error, '模擬網站改版');
  assert.match(notifications[0].message, /^自動購買失敗｜FUNBOX官網/m);
  assert.match(notifications[0].message, /失敗原因：模擬網站改版/);
  assert.equal(notifications[0].options.discordAudience, 'private');
});

test('Funbox 多帳號部分成功會按帳號分成成功與失敗兩則私人通知', async () => {
  const { coordinator, notifications } = fixture({
    adapterResult: {
      status: 'ordered',
      quantity: 1,
      detail: '帳號 A 成功、帳號 B 失敗',
      accountResults: [
        {
          slot: 'A', ok: true, status: 'ordered', quantity: 1,
          orderNumber: 'ORDER-A999999', durationMs: 8000
        },
        {
          slot: 'B', ok: false, status: 'failed', error: '商品已售完'
        }
      ]
    }
  });
  await coordinator.enqueue('funbox', [product]);
  await coordinator.whenIdle();
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message, /^自動購買成功｜FUNBOX官網/m);
  assert.match(notifications[0].message, /帳號A/);
  assert.match(notifications[0].message, /成功單號：ORDER-A999999/);
  assert.match(notifications[1].message, /^自動購買失敗｜FUNBOX官網/m);
  assert.match(notifications[1].message, /帳號B/);
  assert.match(notifications[1].message, /失敗原因：商品已售完/);
  assert.ok(notifications.every((item) => item.options.discordAudience === 'private'));
});

test('同時六款商品會各自結帳，單一失敗不會阻塞後續品項', async () => {
  const state = { data: {}, async save() {} };
  const calls = [];
  const adapter = {
    credentialsStatus: () => ({ ready: true, account: '09***82' }),
    async purchase(item) {
      calls.push(item.id);
      if (item.id === 'item-1') throw new Error('第一款售罄');
      return { status: 'ordered', quantity: 1, detail: '獨立訂單完成' };
    },
    async testLogin() { return { ok: true }; },
    async close() {}
  };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true, action: 'checkout', quantity: 1 }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: { funbox: adapter },
    notifyPrivate: async () => {}
  });
  const codes = ['BX-09', 'UX-17', 'UX-21', 'UX-15', 'UX-04', 'BX-46'];
  const products = Array.from({ length: 6 }, (_, index) => ({
    id: `item-${index + 1}`,
    title: `${codes[index]} 第 ${index + 1} 款陀螺`,
    url: `https://shop.funbox.com.tw/products/item-${index + 1}`
  }));
  assert.equal((await coordinator.enqueue('funbox', products)).accepted, 6);
  await coordinator.whenIdle();
  assert.deepEqual(calls, products.map((item) => item.id));
  assert.equal(state.data.commerce.autoPurchase.records['funbox:item-1'].status, 'stock_out');
  assert.equal(state.data.commerce.autoPurchase.records['funbox:item-6'].status, 'ordered');
});

test('Funbox 同批商品最多三條結帳線並行，不再逐款等待', async () => {
  const state = { data: {}, async save() {} };
  let active = 0;
  let peakActive = 0;
  const adapter = {
    maxConcurrency: 3,
    credentialsStatus: () => ({ ready: true, account: '09***82' }),
    async purchase() {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { status: 'ordered', quantity: 1, detail: '獨立訂單完成' };
    },
    async testLogin() { return { ok: true }; },
    async close() {}
  };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true, action: 'checkout', quantity: 1 }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state,
    getConfig: () => config,
    adapters: { funbox: adapter },
    notifyPrivate: async () => {}
  });
  const codes = ['BX-09', 'UX-17', 'UX-21', 'UX-15', 'UX-04', 'BX-46'];
  const products = Array.from({ length: 6 }, (_, index) => ({
    id: `parallel-${index + 1}`,
    title: `${codes[index]} 平行商品 ${index + 1}`,
    url: `https://shop.funbox.com.tw/products/parallel-${index + 1}`
  }));
  await coordinator.enqueue('funbox', products);
  await coordinator.whenIdle();
  assert.equal(peakActive, 3);
  assert.equal(state.data.commerce.autoPurchase.recent.length, 6);
});

test('Funbox 三組已啟用帳號會針對同一商品同步下單並分別回報', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-multi-account-'));
  const accounts = [
    { slot: 'A', account: '0958000000', password: 'a', enabled: true },
    { slot: 'B', account: '0913000000', password: 'b', enabled: true },
    { slot: 'C', account: '0922000000', password: 'c', enabled: false }
  ];
  try {
    const adapter = new MultiAccountFunboxPurchaseAdapter({ dataDir, getAccounts: () => accounts });
    let active = 0;
    let peak = 0;
    for (const [slot, child] of Object.entries(adapter.adapters)) {
      child.purchase = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { status: 'ordered', quantity: 1, detail: `帳號 ${slot} 完成`, resultUrl: `https://example.com/${slot}` };
      };
    }
    const result = await adapter.purchase(product, { action: 'checkout', quantity: 1 });
    assert.equal(peak, 2);
    assert.equal(result.status, 'ordered');
    assert.equal(result.quantity, 2);
    assert.deepEqual(result.accountResults.map((item) => item.slot), ['A', 'B']);
    assert.match(result.detail, /帳號 A/);
    assert.match(result.detail, /帳號 B/);
    assert.doesNotMatch(result.detail, /帳號 C/);
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 同帳號逐件結帳，不讓多工作器互相清空購物車', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-account-lock-'));
  const accounts = [{ slot: 'A', account: '0958000000', password: 'a', enabled: true }];
  try {
    const adapter = new MultiAccountFunboxPurchaseAdapter({ dataDir, getAccounts: () => accounts });
    let active = 0;
    let peak = 0;
    adapter.adapters.A.purchase = async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: 'ordered', quantity: 1, detail: `${item.id} 完成` };
    };
    const [first, second] = await Promise.all([
      adapter.purchase({ ...product, id: 'first' }, { action: 'checkout', quantity: 1 }),
      adapter.purchase({ ...product, id: 'second' }, { action: 'checkout', quantity: 1 })
    ]);
    assert.equal(peak, 1);
    assert.equal(first.status, 'ordered');
    assert.equal(second.status, 'ordered');
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 每帳號套用自己的結帳策略，暫時錯誤會重試但售罄立即停止', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-retry-'));
  const accounts = [
    { slot: 'A', account: '0958000000', password: 'a', enabled: true },
    { slot: 'B', account: '0913000000', password: 'b', enabled: true }
  ];
  try {
    const adapter = new MultiAccountFunboxPurchaseAdapter({ dataDir, getAccounts: () => accounts });
    let aCalls = 0;
    let bCalls = 0;
    const payments = {};
    adapter.adapters.A.purchase = async (_item, settings) => {
      aCalls += 1;
      payments.A = settings.payment;
      if (aCalls < 3) throw new Error('apiRequestContext.post: Timeout 10000ms exceeded');
      return { status: 'ordered', quantity: 1, detail: 'A 完成' };
    };
    adapter.adapters.B.purchase = async (_item, settings) => {
      bCalls += 1;
      payments.B = settings.payment;
      const error = new Error('加入購物車 HTTP 409：商品已售完');
      error.purchaseStatus = 'stock_out';
      throw error;
    };
    const result = await adapter.purchase(product, {
      action: 'checkout', quantity: 1, maxAttempts: 3,
      accountPayments: { A: 'virtual_atm_home', B: 'seven_cod' }
    });
    assert.equal(aCalls, 3);
    assert.equal(bCalls, 1);
    assert.deepEqual(payments, { A: 'virtual_atm_home', B: 'seven_cod' });
    const accountA = result.accountResults.find((item) => item.slot === 'A');
    const accountB = result.accountResults.find((item) => item.slot === 'B');
    assert.equal(accountA.attempts, 3);
    assert.equal(accountA.retryHistory.length, 2);
    assert.equal(accountB.purchaseStatus, 'stock_out');
    assert.equal(accountB.attempts, 1);
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 250ms 內的四款商品合成一輪，不再建立四個商品任務', async () => {
  const state = { data: {}, async save() {} };
  const calls = [];
  const products = [
    ['cx13', 'CX-13 龍王閃擊'],
    ['bx50', 'BX-50 天堂日輪 隨機強化組'],
    ['ux20', 'UX-20 榮耀武神LF'],
    ['bx00', 'BX-00 蒼龍神劍3-60F V2']
  ].map(([id, title]) => ({ id, title, url: `https://shop.funbox.com.tw/products/${id}`, variantId: `${id}-variant` }));
  const adapter = {
    maxConcurrency: 1,
    credentialsStatus: () => ({
      ready: true,
      accounts: ['A', 'B', 'C'].map((slot) => ({ slot, ready: true, enabled: true }))
    }),
    async purchaseBatch(batch) {
      calls.push(batch);
      return {
        status: 'carted', quantity: batch.length, products: batch,
        accountResults: ['A', 'B', 'C'].map((slot) => ({
          slot, ok: true, status: 'carted', quantity: batch.length, products: batch,
          deferredProducts: [], waves: [{ status: 'carted', products: batch }], payment: slot === 'A' ? 'seven_cod' : 'virtual_atm_home'
        })),
        detail: '三帳號各自完成同一批購物車'
      };
    },
    async close() {}
  };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true, action: 'cart', buyKeywords: ['CX-13', 'BX-50', 'UX-20', 'BX-00'] }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state, getConfig: () => config, adapters: { funbox: adapter }, notifyPrivate: async () => {}
  });
  for (const item of products) await coordinator.enqueue('funbox', [item]);
  await coordinator.whenIdle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((item) => item.id), ['cx13', 'bx50', 'ux20', 'bx00']);
  await coordinator.close();
});

test('Funbox 購物車確認售罄後，同一批官方庫存資料不再反覆下單，資料變化才解鎖', async () => {
  const state = { data: {}, async save() {} };
  let calls = 0;
  const adapter = {
    maxConcurrency: 1,
    credentialsStatus: () => ({
      ready: true,
      accounts: ['A', 'B', 'C'].map((slot) => ({ slot, ready: true, enabled: true }))
    }),
    async purchaseBatch() {
      calls += 1;
      const accountResults = ['A', 'B', 'C'].map((slot) => ({
        slot, ok: false, status: 'stock_out', purchaseStatus: 'stock_out',
        error: '單品即時庫存已為 0', products: [], deferredProducts: []
      }));
      const error = new Error('三個帳號皆確認單品即時庫存已為 0');
      error.purchaseStatus = 'stock_out';
      error.accountResults = accountResults;
      throw error;
    },
    async close() {}
  };
  const config = normalizeAutoPurchaseConfig({
    enabled: true,
    funbox: { enabled: true, action: 'checkout', buyKeywords: ['CX-16'] }
  });
  const coordinator = new AutoPurchaseCoordinator({
    state, getConfig: () => config, adapters: { funbox: adapter }, notifyPrivate: async () => {}
  });
  const product = {
    id: 'legacy-id', title: 'BEYBLADE X CX-16 測試商品',
    url: 'https://shop.funbox.com.tw/products/cx16-test',
    variantId: 'variant-1', stock: 194
  };
  assert.equal((await coordinator.enqueue('funbox', [product])).accepted, 1);
  await coordinator.whenIdle();
  assert.equal(calls, 1);
  assert.equal((await coordinator.enqueue('funbox', [product])).accepted, 0);
  assert.equal(calls, 1);
  assert.equal((await coordinator.enqueue('funbox', [{ ...product, stock: 193 }])).accepted, 1);
  await coordinator.whenIdle();
  assert.equal(calls, 2);
  await coordinator.close();
});

test('Funbox A B C 各自購買完整清單，缺貨只由原帳號建立下一張單', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-account-waves-'));
  const accounts = ['A', 'B', 'C'].map((slot) => ({ slot, account: `${slot}-account`, password: 'secret', enabled: true }));
  const products = ['CX-13', 'BX-50', 'UX-20', 'BX-00'].map((code) => ({
    id: code.toLowerCase(), title: `${code} 測試陀螺`, url: `https://shop.funbox.com.tw/products/${code.toLowerCase()}`
  }));
  const calls = { A: [], B: [], C: [] };
  const payments = { A: [], B: [], C: [] };
  try {
    const adapter = new MultiAccountFunboxPurchaseAdapter({ dataDir, getAccounts: () => accounts });
    for (const [slot, child] of Object.entries(adapter.adapters)) {
      child.purchaseBatch = async (batch, settings) => {
        calls[slot].push(batch.map((item) => item.id));
        payments[slot].push(settings.payment);
        const firstAWave = slot === 'A' && calls.A.length === 1;
        const obtained = firstAWave ? batch.slice(0, 3) : batch;
        const deferred = firstAWave ? batch.slice(3) : [];
        return {
          status: 'ordered', purchaseStatus: 'success', quantity: obtained.length,
          products: obtained, deferredProducts: deferred,
          orderNumber: `${slot}-${calls[slot].length}`, detail: `${slot} 完成`, resultUrl: `https://example.com/${slot}`
        };
      };
    }
    const result = await adapter.purchaseBatch(products, {
      action: 'checkout', payment: 'seven_cod',
      accountPayments: { A: 'seven_cod', B: 'virtual_atm_home', C: 'virtual_atm_home' }
    });
    assert.deepEqual(calls.A, [products.map((item) => item.id), [products[3].id]]);
    assert.deepEqual(calls.B, [products.map((item) => item.id)]);
    assert.deepEqual(calls.C, [products.map((item) => item.id)]);
    assert.deepEqual(payments, { A: ['seven_cod', 'seven_cod'], B: ['virtual_atm_home'], C: ['virtual_atm_home'] });
    assert.equal(result.accountResults.find((item) => item.slot === 'A').waves.length, 2);
    assert.equal(result.accountResults.find((item) => item.slot === 'B').waves.length, 1);
    assert.equal(result.accountResults.find((item) => item.slot === 'C').waves.length, 1);
    assert.ok(result.accountResults.every((item) => item.products.length === 4));
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 合單加入最後一款逾時時保住車上商品並把未完成品延後', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-protect-cart-'));
  const products = ['CX-13', 'BX-50', 'UX-20', 'BX-00'].map((code) => ({
    id: code.toLowerCase(), title: `${code} 測試陀螺`, url: `https://shop.funbox.com.tw/products/${code.toLowerCase()}`,
    variantId: `${code}-variant`, stock: 20
  }));
  const page = { async close() {}, async waitForTimeout() {} };
  const context = {
    async newPage() { return page; },
    request: { async get() { return { url: () => 'https://shop.funbox.com.tw/carts/protected' }; } }
  };
  let cleared = 0;
  let addCalls = 0;
  try {
    const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
    adapter._acquireWarmWorker = async () => ({ context, busy: true, authenticatedAt: Date.now() });
    adapter._ensureWarmWorkerLogin = async () => {};
    adapter._clearCart = async () => { cleared += 1; return 0; };
    adapter._releaseWarmWorker = async () => {};
    adapter._cartContainsProduct = async () => ({ present: false, cartUrl: 'https://shop.funbox.com.tw/carts/protected' });
    adapter._addProductToCart = async (_context, item) => {
      addCalls += 1;
      if (item.id === 'bx-00') throw new Error('apiRequestContext.post: Timeout 2500ms exceeded');
      return { product: item, quantity: 1, variantId: item.variantId };
    };
    const result = await adapter.purchaseBatch(products, {
      action: 'cart', buyKeywords: ['CX-13', 'BX-50', 'UX-20', 'BX-00']
    });
    assert.equal(cleared, 1);
    assert.equal(addCalls, 4);
    assert.deepEqual(result.products.map((item) => item.id), ['cx-13', 'bx-50', 'ux-20']);
    assert.deepEqual(result.deferredProducts.map((item) => item.id), ['bx-00']);
    assert.match(result.detail, /3 款.*1 款等待下一張/);
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Funbox 組車期間收到既有商品缺貨訊號會提前結帳並延後剩餘品項', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-funbox-live-risk-'));
  const products = ['CX-13', 'BX-50', 'UX-20', 'BX-00'].map((code) => ({
    id: code.toLowerCase(), title: `${code} 測試陀螺`, url: `https://shop.funbox.com.tw/products/${code.toLowerCase()}`,
    variantId: `${code}-variant`, stock: 20
  }));
  const page = { async close() {}, async waitForTimeout() {} };
  const context = {
    async newPage() { return page; },
    request: { async get() { return { url: () => 'https://shop.funbox.com.tw/carts/live-risk' }; } }
  };
  let addCalls = 0;
  try {
    const adapter = new FunboxPurchaseAdapter({ dataDir, getCredentials: () => ({ account: 'member', password: 'secret' }) });
    adapter._acquireWarmWorker = async () => ({ context, busy: true, authenticatedAt: Date.now() });
    adapter._ensureWarmWorkerLogin = async () => {};
    adapter._clearCart = async () => 0;
    adapter._releaseWarmWorker = async () => {};
    adapter._addProductToCart = async (_context, item) => {
      addCalls += 1;
      return { product: item, quantity: 1, variantId: item.variantId };
    };
    const result = await adapter.purchaseBatch(products, {
      action: 'cart',
      buyKeywords: ['CX-13', 'BX-50', 'UX-20', 'BX-00'],
      productRisk: (item) => addCalls >= 2 && item.id === 'cx-13' ? { reason: 'sold_out' } : null
    });
    assert.equal(addCalls, 2);
    assert.deepEqual(result.products.map((item) => item.id), ['cx-13', 'bx-50']);
    assert.deepEqual(result.deferredProducts.map((item) => item.id), ['ux-20', 'bx-00']);
    assert.match(result.detail, /2 款.*2 款等待下一張/);
    await adapter.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
