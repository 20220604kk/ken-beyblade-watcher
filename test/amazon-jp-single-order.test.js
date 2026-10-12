import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmazonJpSingleOrderMonitor,
  extractAmazonJpOrderId,
  normalizeAmazonJpCheckoutUrl,
  parseAmazonJpCheckoutSnapshot
} from '../src/amazon-jp-single-order.js';

test('日亞單品只接受真正的 Amazon.co.jp 購物車與結帳網址', () => {
  assert.match(normalizeAmazonJpCheckoutUrl('https://www.amazon.co.jp/checkout/p/test/itemselect?isBuyNow=1'), /amazon\.co\.jp\/checkout/);
  assert.match(normalizeAmazonJpCheckoutUrl('https://www.amazon.co.jp/gp/cart/view.html'), /gp\/cart/);
  assert.throws(() => normalizeAmazonJpCheckoutUrl('https://amazon.co.jp.example.com/checkout/test'), /只接受/);
  assert.throws(() => normalizeAmazonJpCheckoutUrl('https://www.amazon.co.jp/dp/B0HJ783F18'), /只接受/);
});

test('完成頁網址或頁面文字可抽出日亞訂單編號', () => {
  assert.equal(extractAmazonJpOrderId({
    url: 'https://www.amazon.co.jp/gp/buy/thankyou/handlers/display.html?purchaseId=251-1258218-1203829'
  }), '251-1258218-1203829');
  assert.equal(extractAmazonJpOrderId({
    bodyText: '订单已提交，谢谢！ 订单编号 251-1258218-1203829'
  }), '251-1258218-1203829');
});

test('缺貨紅字與數量 0 會被辨識為繼續刷新，不會送單', () => {
  const result = parseAmazonJpCheckoutSnapshot({
    url: 'https://www.amazon.co.jp/checkout/p/test/itemselect',
    titles: ['BX-52 ラスタードラグーン'],
    sellerConfirmed: true,
    bodyText: '数量： 0 抱歉，无法再提供您所请求的数量。我们已将您的数量更新为最大可提供数量。'
  });
  assert.equal(result.quantity, 0);
  assert.equal(result.stockLimited, true);
  assert.equal(result.itemCount, 1);
  assert.equal(result.sellerConfirmed, true);
  assert.equal(result.confirmed, false);
});

test('Amazon 新版 stepper 數量可以覆蓋沒有「數量」標籤的頁面文字', () => {
  const result = parseAmazonJpCheckoutSnapshot({
    url: 'https://www.amazon.co.jp/checkout/p/test/spc',
    titles: ['Sakura Craypas RAF60'],
    quantityText: '1',
    sellerConfirmed: true,
    bodyText: '现在有货。 卖家 Amazon.co.jp'
  });
  assert.equal(result.quantity, 1);
  assert.equal(result.itemCount, 1);
});

test('Amazon 新版重複渲染同一個可見商品標題時仍只算一項', () => {
  const result = parseAmazonJpCheckoutSnapshot({
    url: 'https://www.amazon.co.jp/checkout/p/test/itemselect?cartItemCount=1',
    titles: ['BEYBLADE X UX-20 グローリーワルキューレ', ' BEYBLADE X UX-20 グローリーワルキューレ '],
    quantityText: '1',
    sellerConfirmed: true
  });
  assert.equal(result.itemCount, 1);
  assert.deepEqual(result.itemTitles, ['BEYBLADE X UX-20 グローリーワルキューレ']);
});

test('兩個不同商品標題仍會被辨識成兩項並阻止單品送單', () => {
  const result = parseAmazonJpCheckoutSnapshot({
    url: 'https://www.amazon.co.jp/checkout/p/test/itemselect',
    titles: ['BEYBLADE X UX-20', 'BEYBLADE X BX-52'],
    quantityText: '1',
    sellerConfirmed: true
  });
  assert.equal(result.itemCount, 2);
});

test('補貨後的結帳流程可辨識最終送單按鈕與成功頁', async () => {
  let submitted = 0;
  const final = {
    first: () => final,
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { submitted += 1; }
  };
  const missing = {
    first: () => missing,
    count: async () => 0,
    isVisible: async () => false,
    isEnabled: async () => false
  };
  const page = {
    locator: (selector) => selector === '#submitOrderButtonId input[type="submit"]' ? final : missing,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {}
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '', state: { data: {} }, getConfig: () => ({}),
    persistentContextLauncher: async () => {}, log: () => {}
  });
  const snapshots = [
    { confirmed: false, url: 'https://www.amazon.co.jp/checkout/review' },
    { confirmed: true, url: 'https://www.amazon.co.jp/checkout/order-confirmation' }
  ];
  monitor.snapshot = async () => snapshots.shift();
  const result = await monitor.advanceCheckout(page, {});
  assert.equal(submitted, 1);
  assert.equal(result.status, 'ordered');
});

test('尚未偵測到 0→1 的頁面錯誤只記錄重試，不發購買失敗通知', async () => {
  const targetUrl = 'https://www.amazon.co.jp/checkout/p/test/itemselect?isBuyNow=1';
  const notifications = [];
  const visits = [];
  const state = { data: {}, save: async () => {} };
  const page = {
    url: () => targetUrl,
    reload: async () => {},
    goto: async (url) => { visits.push(url); },
    waitForTimeout: async () => {},
    isClosed: () => false
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '',
    state,
    getConfig: () => ({ enabled: true, targetUrl, targetSuccessCount: 2 }),
    notifyPrivate: async (message) => { notifications.push(message); },
    persistentContextLauncher: async () => {},
    log: () => {}
  });
  monitor.page = page;
  monitor.pageFor = async () => page;
  monitor.snapshot = async () => ({
    url: targetUrl,
    title: 'BX-52',
    itemCount: 1,
    quantity: 0,
    stockLimited: false,
    sellerConfirmed: true,
    loginRequired: true,
    confirmed: false
  });

  await assert.rejects(() => monitor.scanOnce(), /登入已失效/);
  await assert.rejects(() => monitor.scanOnce(), /登入已失效/);

  assert.equal(monitor.storage().status, 'retrying');
  assert.equal(monitor.storage().completedCount, 0);
  assert.equal(notifications.length, 0);
  assert.deepEqual(visits, [targetUrl, targetUrl]);
});

test('偵測到 0→1 後結帳失敗才通知原因，並返回目標頁繼續重試', async () => {
  const targetUrl = 'https://www.amazon.co.jp/checkout/p/test/itemselect?isBuyNow=1';
  const notifications = [];
  const visits = [];
  const state = { data: {}, save: async () => {} };
  const page = {
    url: () => targetUrl,
    reload: async () => {},
    goto: async (url) => { visits.push(url); },
    waitForTimeout: async () => {},
    isClosed: () => false
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '',
    state,
    getConfig: () => ({ enabled: true, targetUrl, targetSuccessCount: 2 }),
    notifyPrivate: async (message) => { notifications.push(message); },
    persistentContextLauncher: async () => {},
    log: () => {}
  });
  monitor.page = page;
  monitor.pageFor = async () => page;
  monitor.snapshot = async () => ({
    url: targetUrl,
    title: 'BX-52',
    itemCount: 1,
    quantity: 1,
    stockLimited: false,
    sellerConfirmed: true,
    loginRequired: false,
    confirmed: false
  });
  monitor.advanceCheckout = async () => { throw new Error('最終送單按鈕消失'); };

  await assert.rejects(() => monitor.scanOnce(), /最終送單按鈕消失/);

  assert.equal(monitor.storage().status, 'retrying');
  assert.equal(monitor.storage().completedCount, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /原因：最終送單按鈕消失.*自動返回購物車並繼續刷新/);
  assert.deepEqual(visits, [targetUrl]);
});

test('0→1 時會等待結帳頁補上賣家欄位，再決定是否送單', async () => {
  const targetUrl = 'https://www.amazon.co.jp/checkout/p/test/itemselect?isBuyNow=1';
  const state = { data: {}, save: async () => {} };
  const page = {
    url: () => targetUrl,
    reload: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '',
    state,
    getConfig: () => ({ enabled: true, targetUrl, targetSuccessCount: 1 }),
    persistentContextLauncher: async () => {},
    log: () => {}
  });
  monitor.page = page;
  monitor.pageFor = async () => page;
  let snapshots = 0;
  monitor.snapshot = async () => {
    snapshots += 1;
    return {
      url: targetUrl,
      title: 'BX-52',
      itemCount: 1,
      quantity: 1,
      stockLimited: false,
      sellerConfirmed: snapshots > 1,
      loginRequired: false,
      confirmed: false
    };
  };
  monitor.advanceCheckout = async () => ({
    status: 'ordered',
    snapshot: {
      url: 'https://www.amazon.co.jp/gp/buy/thankyou/handlers/display.html?purchaseId=251-1258218-1203829',
      confirmed: true,
      orderId: '251-1258218-1203829'
    }
  });

  const result = await monitor.scanOnce();

  assert.equal(result.status, 'ordered');
  assert.equal(snapshots, 2);
  assert.equal(monitor.storage().completedCount, 1);
  assert.equal(monitor.storage().status, 'completed');
  assert.equal(monitor.storage().lastNotificationStatus, 'sent');
});

test('已達目標成功次數時不再開頁或重複送單', async () => {
  const targetUrl = 'https://www.amazon.co.jp/checkout/p/test/itemselect?isBuyNow=1';
  let opened = 0;
  let terminal = 0;
  const state = {
    data: { commerce: { amazonJpSingleOrder: { completedCount: 1, status: 'waiting_stock' } } },
    save: async () => {}
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '', state,
    getConfig: () => ({ enabled: true, targetUrl, targetSuccessCount: 1 }),
    onTerminal: async () => { terminal += 1; },
    persistentContextLauncher: async () => { opened += 1; },
    log: () => {}
  });

  const result = await monitor.scanOnce();

  assert.deepEqual(result, { status: 'completed', skipped: true });
  assert.equal(opened, 0);
  assert.equal(terminal, 1);
  assert.equal(monitor.storage().status, 'completed');
});

test('重設新任務會清除上一筆訂單與通知殘影', async () => {
  const storage = {
    completedCount: 1, refreshCount: 99, status: 'completed',
    lastOrderStatus: 'ordered', resultUrl: 'https://example.test/old',
    completedAt: 'old', lastNotificationId: 'old-message'
  };
  const state = { data: { commerce: { amazonJpSingleOrder: storage } }, save: async () => {} };
  const monitor = new AmazonJpSingleOrderMonitor({ dataDir: '', state, getConfig: () => ({}), log: () => {} });

  await monitor.resetProgress();

  assert.equal(storage.completedCount, 0);
  assert.equal(storage.refreshCount, 0);
  assert.equal(storage.status, 'idle');
  assert.equal(storage.lastOrderStatus, undefined);
  assert.equal(storage.resultUrl, undefined);
  assert.equal(storage.lastNotificationId, undefined);
});

test('日本拍賣或日亞通知只有同型號才會立刻插隊 F5', async () => {
  const scheduled = [];
  const state = {
    data: { commerce: { amazonJpSingleOrder: {
      completedCount: 0,
      lastSnapshot: { title: 'BEYBLADE X BX-52 ラスタードラグーン', code: 'BX-52' }
    } } },
    save: async () => {}
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '', state,
    getConfig: () => ({ enabled: true, targetSuccessCount: 1 }),
    log: () => {}
  });
  monitor.scheduleNext = (delay, reason) => scheduled.push({ delay, reason });

  const different = await monitor.requestImmediateRefresh({ title: 'BEYBLADE X UX-21' }, { source: '樂天 Books', kind: 'new' });
  const same = await monitor.requestImmediateRefresh({ title: 'タカラトミー BX52 スターター' }, { source: '樂天 Books', kind: 'restock' });

  assert.equal(different.matched, false);
  assert.equal(same.matched, true);
  assert.deepEqual(scheduled, [{ delay: 0, reason: 'signal' }]);
  assert.equal(monitor.storage().lastSignalSource, '樂天 Books');
  assert.equal(monitor.storage().lastSignalRefreshStatus, 'scheduled_now');
});

test('同品項通知撞上既有刷新時會在一秒內搶占並立即 F5', async () => {
  const state = {
    data: { commerce: { amazonJpSingleOrder: {
      completedCount: 0,
      targetAsin: 'B0HJ783F18',
      lastSnapshot: { asin: 'B0HJ783F18', code: 'BX-52' }
    } } },
    save: async () => {}
  };
  const monitor = new AmazonJpSingleOrderMonitor({
    dataDir: '', state,
    getConfig: () => ({ enabled: true, targetSuccessCount: 1 }),
    log: () => {}
  });
  monitor.running = true;
  let reloadCount = 0;
  monitor.page = {
    isClosed: () => false,
    reload: async () => { reloadCount += 1; }
  };

  const result = await monitor.requestImmediateRefresh({ asin: 'B0HJ783F18', code: 'BX-52' }, { source: '日亞官方原價' });

  assert.equal(result.matched, true);
  assert.equal(result.queued, false);
  assert.equal(result.preempted, true);
  assert.equal(reloadCount, 1);
  assert.equal(monitor.signalRefreshRequested, true);
  assert.equal(monitor.signalPreemptRequested, true);
  assert.equal(monitor.storage().lastSignalRefreshStatus, 'preempting_active_scan');
  assert.ok(monitor.storage().lastSignalF5LatencyMs <= 1_000);
});
