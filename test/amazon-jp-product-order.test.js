import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmazonOrderHistory } from '../src/amazon-order-history.js';
import {
  AmazonJpProductOrderMonitor,
  evaluateAmazonJpProductOrder,
  matchesAmazonJpPurchaseSignal,
  normalizeAmazonJpProductMode,
  normalizeAmazonJpProductUrl,
  resolveAmazonJpMsrp
} from '../src/amazon-jp-product-order.js';

const targetUrl = 'https://www.amazon.co.jp/dp/B0DWSBHQWD';
const verifiedSignal = {
  asin: 'B0DWSBHQWD', available: true, sellerConfirmed: true, priceYen: 880, msrpYen: 880
};

function monitorForTest(config = { enabled: true, targetUrl, targetSuccessCount: 1 }) {
  const state = { data: { commerce: {} }, save: async () => {} };
  const orderHistory = { begin: async () => ({}), step: async () => {}, finish: async () => {}, notification: async () => {}, status: () => ({ recent: [], total: 0 }) };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config, orderHistory });
  return { monitor, state, config };
}

test('日亞商品頁網址正規化為官方賣家與 JPY 商品頁', () => {
  assert.equal(
    normalizeAmazonJpProductUrl('https://www.amazon.co.jp/任意商品/dp/B0H861Y9Y3?th=1'),
    'https://www.amazon.co.jp/dp/B0H861Y9Y3?m=AN1VRQENFRJN5&language=ja_JP&currency=JPY'
  );
  assert.throws(() => normalizeAmazonJpProductUrl('https://example.com/dp/B0H861Y9Y3'), /Amazon\.co\.jp/);
});

test('商品頁只在官方價、自營、可購且未達帳號限購時放行', () => {
  const base = {
    pageIssue: '', loginRequired: false, purchaseLimited: false, sellerConfirmed: true,
    priceText: '￥2,700', priceYen: 2700, buyNowAvailable: true, addCartAvailable: false
  };
  const msrp = { msrpYen: 2700 };
  assert.deepEqual(evaluateAmazonJpProductOrder(base, msrp), { eligible: true, reason: 'qualified' });
  assert.equal(evaluateAmazonJpProductOrder({ ...base, purchaseLimited: true }, msrp).reason, 'purchase_limited');
  assert.equal(evaluateAmazonJpProductOrder({ ...base, sellerConfirmed: false }, msrp).reason, 'seller_not_amazon');
  assert.equal(evaluateAmazonJpProductOrder({ ...base, priceText: 'TWD 590', priceYen: null }, msrp).reason, 'non_jpy_price');
  assert.equal(evaluateAmazonJpProductOrder({ ...base, priceYen: 2702 }, msrp).reason, 'above_msrp');
  assert.equal(evaluateAmazonJpProductOrder({ ...base, signedIn: null, pageIssue: 'product_unreadable' }, msrp).reason, 'product_unreadable');
  assert.equal(evaluateAmazonJpProductOrder({ ...base, signedIn: false, loginRequired: true }, msrp).reason, 'login_required');
});

test('官方定價先取同 ASIN 手動基線，否則精確對應官方型號', () => {
  const manual = resolveAmazonJpMsrp({
    asin: 'B0TEST0001', title: 'BEYBLADE X BX-99 TEST',
    manualProducts: { B0TEST0001: { code: 'BX-99', manualMsrpYen: 1234 } }
  });
  assert.deepEqual(manual, { code: 'BX-99', msrpYen: 1234, source: 'manual' });
  const catalog = resolveAmazonJpMsrp({
    asin: 'B0TEST0002', title: 'BEYBLADE X UX-20 グローリーワルキューレ LF',
    catalog: [{ code: 'UX-20', name: 'グローリーワルキューレ LF', normalizedName: 'グローリーワルキューレLF', msrpYen: 2700 }]
  });
  assert.equal(catalog.msrpYen, 2700);
  assert.equal(catalog.source, 'catalog');
});

test('商品頁任務只接受日亞掃描已核對的同 ASIN 原價自營新品或補貨', () => {
  const config = { enabled: true, targetUrl, priceToleranceYen: 1 };
  assert.equal(matchesAmazonJpPurchaseSignal(config, verifiedSignal, { source: '日亞官方原價', kind: 'restock' }), true);
  assert.equal(matchesAmazonJpPurchaseSignal(config, verifiedSignal, { source: '日亞官方原價', kind: 'new' }), true);
  assert.equal(matchesAmazonJpPurchaseSignal(config, { ...verifiedSignal, asin: 'B0H861Y9Y3' }, { source: '日亞官方原價', kind: 'restock' }), false);
  assert.equal(matchesAmazonJpPurchaseSignal(config, verifiedSignal, { source: '1999.co.jp', kind: 'restock' }), false);
  assert.equal(matchesAmazonJpPurchaseSignal(config, { ...verifiedSignal, sellerConfirmed: false }, { source: '日亞官方原價', kind: 'restock' }), false);
  assert.equal(matchesAmazonJpPurchaseSignal(config, { ...verifiedSignal, priceYen: 882 }, { source: '日亞官方原價', kind: 'restock' }), false);
});

test('啟用後沒有掃描訊號就不開商品頁、不排週期刷新', async () => {
  const { monitor } = monitorForTest();
  let scans = 0;
  monitor.scanOnce = async () => { scans += 1; };
  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(monitor.status().status, 'waiting_signal');
  assert.equal(monitor.status().nextAttemptAt, null);
  assert.equal(monitor.timer, null);
  assert.equal(scans, 0);
  await monitor.close();
});

test('重啟時未確認的下單流程改為人工確認，不因下一個補貨訊號重複送單', async () => {
  const { monitor, state } = monitorForTest();
  state.data.commerce.amazonJpProductOrder = { status: 'ordering', completedCount: 0, stepLog: [] };
  await monitor.start();
  assert.equal(monitor.status().status, 'needs_review');
  const result = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.equal(result.reason, 'order_needs_review');
  assert.equal(monitor.timer, null);
  await monitor.close();
});

test('同 ASIN 原價補貨訊號只啟動一次，完成後不會繼續刷新', async () => {
  const { monitor } = monitorForTest();
  let scans = 0;
  monitor.scanOnce = async ({ purchase, signal }) => {
    assert.equal(purchase, true);
    assert.equal(signal.asin, 'B0DWSBHQWD');
    scans += 1;
    monitor.storage().status = 'waiting_signal';
  };
  await monitor.start();
  const first = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  const duplicate = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.equal(first.queued, true);
  assert.equal(duplicate.reason, 'already_processing_signal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scans, 1);
  assert.equal(monitor.timer, null);
  assert.equal(monitor.status().nextAttemptAt, null);
  await monitor.close();
});

test('手動檢查商品頁僅讀取條件，不會按立即購買', async () => {
  const { monitor, state } = monitorForTest();
  state.data.commerce.amazonJp = { catalog: [{ code: 'BX-40', name: 'ワインダーランチャーL', normalizedName: 'ワインダーランチャーL', msrpYen: 880 }] };
  const page = {
    url: () => 'about:blank',
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {}
  };
  monitor.pageFor = async () => page;
  monitor.productSnapshot = async () => ({
    url: targetUrl, asin: 'B0DWSBHQWD', title: 'BEYBLADE X BX-40 ワインダーランチャーL',
    priceText: '¥880', priceYen: 880, sellerConfirmed: true, signedIn: true,
    purchaseLimited: false, buyNowAvailable: true, addCartAvailable: true, loginRequired: false, pageIssue: ''
  });
  monitor.clickQualifiedOffer = async () => { throw new Error('手動檢查不應點購買'); };
  const result = await monitor.scanOnce();
  assert.equal(result.status, 'inspected_only');
  assert.equal(result.snapshot.evaluation, 'qualified');
  assert.equal(monitor.storage().completedCount, 0);
  await monitor.close();
});

test('掃描訊號命中後若商品頁型號不符，禁止點購買', async () => {
  const { monitor } = monitorForTest();
  const page = {
    url: () => 'about:blank',
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {}
  };
  monitor.pageFor = async () => page;
  monitor.productSnapshot = async () => ({
    url: targetUrl, asin: 'B0DWSBHQWD', code: 'UX-20', title: 'BEYBLADE X UX-20',
    priceText: '¥880', priceYen: 880, sellerConfirmed: true, signedIn: true,
    purchaseLimited: false, buyNowAvailable: true, addCartAvailable: true, loginRequired: false, pageIssue: ''
  });
  monitor.resolveMsrp = () => ({ msrpYen: 880 });
  monitor.clickQualifiedOffer = async () => { throw new Error('型號不符不應點購買'); };
  const result = await monitor.scanOnce({ purchase: true, signal: { asin: 'B0DWSBHQWD', code: 'UX-19', matchedAt: Date.now() } });
  assert.equal(result.status, 'waiting_signal');
  assert.equal(result.snapshot.evaluation, 'product_mismatch');
  await monitor.close();
});

const hybridConfig = () => ({ enabled: true, mode: 'hybrid', targetUrl, targetSuccessCount: 1 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const goodSnapshot = () => ({
  asin: 'B0DWSBHQWD', code: 'BX-40', title: 'BEYBLADE X BX-40',
  priceYen: 880, priceText: '¥880', signedIn: true, sellerConfirmed: true,
  buyNowAvailable: true, addCartAvailable: true, pageIssue: ''
});

function fakeProductPage(monitor, snapshot = goodSnapshot()) {
  let reads = 0;
  const page = { url: () => 'about:blank', goto: async () => { reads += 1; return { status: () => 200 }; }, waitForTimeout: async () => {} };
  monitor.pageFor = async () => page;
  monitor.productSnapshot = async () => snapshot;
  monitor.resolveMsrp = () => ({ msrpYen: 880 });
  return { page, reads: () => reads };
}

test('實際紀錄整合：成功與 DC 結果分開保存，重設及重啟後訂單耗時仍存在', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amazon-product-archive-test-'));
  const { monitor } = monitorForTest(hybridConfig());
  t.after(async () => { await monitor.close(); await fs.rm(dir, { recursive: true, force: true }); });
  monitor.orderHistory = new AmazonOrderHistory(dir);
  fakeProductPage(monitor);
  monitor.clickQualifiedOffer = async () => monitor.recordStep('buy_now_click');
  monitor.checkoutRunner = async (_page, _snapshot, record) => {
    await record('checkout_inspect', { step: 1, url: 'https://amazon.co.jp/checkout/private' });
    await record('submit_order');
    await record('submit_result', { status: 'ordered', orderId: 'TEST-ORDER' });
    return { status: 'ordered', snapshot: { orderId: 'TEST-ORDER', url: 'https://amazon.co.jp/thankyou' } };
  };
  monitor.notifyPrivate = async () => { throw new Error('test notification failed'); };
  await monitor.scanOnce({ purchase: true, trigger: 'poll' });
  const before = monitor.orderHistory.status().recent[0];
  assert.equal(before.status, 'ordered');
  assert.equal(before.trigger, 'poll');
  assert.equal(before.signalAt, null);
  assert.equal(before.notification.status, 'failed');
  assert.ok(before.timings.refreshToConfirmedMs >= 0);
  assert.ok(before.timings.qualifiedToPurchaseMs >= 0);
  assert.deepEqual(before.steps.map(s => s.name), ['refresh_start', 'product_evaluated', 'buy_now_click', 'checkout_inspect', 'submit_order', 'submit_result']);
  const file = path.join(monitor.orderHistory.directory, `${before.id}.json`);
  const original = await fs.readFile(file, 'utf8');
  await monitor.resetProgress();
  assert.equal(monitor.storage().completedCount, 0);
  assert.equal(monitor.storage().stepLog.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const reloaded = new AmazonOrderHistory(dir);
  await reloaded.ready;
  assert.equal(reloaded.status().recent[0].orderId, 'TEST-ORDER');
  assert.equal(reloaded.status().recent[0].timings.refreshToConfirmedMs, before.timings.refreshToConfirmedMs);
});

test('一般缺貨不建檔；購買失敗與送單後斷線各自保存且不誤報成功', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amazon-product-archive-test-'));
  const { monitor } = monitorForTest(hybridConfig());
  t.after(async () => { await monitor.close(); await fs.rm(dir, { recursive: true, force: true }); });
  monitor.orderHistory = new AmazonOrderHistory(dir);
  await monitor.orderHistory.ready;
  fakeProductPage(monitor, { ...goodSnapshot(), buyNowAvailable: false, addCartAvailable: false });
  await monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(monitor.orderHistory.status().total, 0);
  assert.equal((await fs.readdir(monitor.orderHistory.directory)).length, 0);
  fakeProductPage(monitor);
  monitor.clickQualifiedOffer = async () => { throw new Error('test buy button missing'); };
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /test buy button missing/);
  assert.equal(monitor.orderHistory.status().recent[0].status, 'failed');
  delete monitor.storage().backoffUntil;
  monitor.clickQualifiedOffer = async () => monitor.recordStep('buy_now_click');
  monitor.checkoutRunner = async (_p, _s, record) => { await record('submit_order'); throw new Error('test response lost'); };
  await assert.rejects(monitor.scanOnce({ purchase: true, signal: { asin: verifiedSignal.asin, matchedAt: Date.now() }, trigger: 'scan_signal' }), /test response lost/);
  const history = monitor.orderHistory.status();
  assert.equal(history.total, 2);
  assert.equal(history.recent[0].status, 'submitted_unconfirmed');
  assert.equal(history.recent[0].trigger, 'scan_signal');
  assert.ok(history.recent[0].timings.signalToRefreshMs >= 0);
  assert.equal(history.recent[0].timings.submitToConfirmedMs, null);
  assert.equal(monitor.storage().status, 'needs_review');
});

test('未設定或未知模式維持原模式；只有明確 hybrid 才開五秒刷新', () => {
  assert.equal(normalizeAmazonJpProductMode(undefined), 'scan_signal');
  assert.equal(normalizeAmazonJpProductMode('invalid'), 'scan_signal');
  assert.equal(normalizeAmazonJpProductMode('hybrid'), 'hybrid');
});

test('雙線每五秒啟動一次，缺貨快速回待命而不洗失敗通知', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  const stub = fakeProductPage(monitor, { ...goodSnapshot(), priceYen: null, sellerConfirmed: false, buyNowAvailable: false, addCartAvailable: false });
  monitor.notifyPrivate = async () => assert.fail('一般缺貨不應通知');
  monitor.clickQualifiedOffer = async () => assert.fail('缺貨不應購買');
  await monitor.start();
  assert.equal(monitor.storage().status, 'waiting_poll');
  assert.equal(Date.parse(monitor.nextAttemptAt) - Date.now(), 5000);
  t.mock.timers.tick(4999);
  await tick();
  assert.equal(stub.reads(), 0);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(stub.reads(), 1);
  assert.equal(monitor.running, false);
  assert.equal(monitor.storage().lastSnapshot.evaluation, 'not_purchasable');
  assert.equal(Date.parse(monitor.nextAttemptAt) - Date.now(), 5000);
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(stub.reads(), 2);
});

test('補貨訊號立即取代五秒計時器，重複訊號合併', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  const stub = fakeProductPage(monitor, { ...goodSnapshot(), buyNowAvailable: false, addCartAvailable: false });
  await monitor.start();
  const first = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.equal(first.queued, true);
  assert.equal(Date.parse(monitor.nextAttemptAt), Date.now());
  const duplicate = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.equal(duplicate.reason, 'already_processing_signal');
  t.mock.timers.tick(0);
  await tick();
  assert.equal(stub.reads(), 1);
  assert.equal(monitor.storage().lastTrigger, 'scan_signal');
  assert.equal(monitor.storage().lastNotificationKind, 'failure');
});

test('五秒檢查中收到訊號不重疊，缺貨結束後只加一次立即複查', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  const stub = fakeProductPage(monitor);
  let release;
  monitor.productSnapshot = () => new Promise((resolve) => { release = resolve; });
  await monitor.start();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(monitor.running, true);
  await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.equal(monitor.timer, null);
  assert.equal(stub.reads(), 1);
  release({ ...goodSnapshot(), buyNowAvailable: false, addCartAvailable: false });
  await tick();
  assert.equal(Date.parse(monitor.nextAttemptAt), Date.now());
  monitor.productSnapshot = async () => ({ ...goodSnapshot(), buyNowAvailable: false, addCartAvailable: false });
  t.mock.timers.tick(0);
  await tick();
  assert.equal(stub.reads(), 2);
});

test('五秒模式合格後可模擬送單，結帳期間訊號不刷新，達成功次數就停止', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  const stub = fakeProductPage(monitor);
  let checkoutCalls = 0;
  monitor.clickQualifiedOffer = async () => {
    assert.equal(monitor.phase, 'ordering');
    assert.equal(monitor.timer, null);
    const signal = await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
    assert.equal(signal.reason, 'already_processing_signal');
    assert.equal((await monitor.scanOnce()).skipped, true);
  };
  monitor.checkoutRunner = async (_page, _snapshot, recordStep) => {
    checkoutCalls += 1;
    await recordStep('submit_order');
    return { status: 'ordered', snapshot: { url: 'https://www.amazon.co.jp/checkout/thankyou', orderId: 'TEST-ONLY' } };
  };
  await monitor.start();
  const result = await monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(result.status, 'ordered');
  assert.equal(checkoutCalls, 1);
  assert.equal(stub.reads(), 1);
  assert.equal(monitor.storage().completedCount, 1);
  assert.equal(monitor.storage().status, 'completed');
  assert.equal(monitor.timer, null);
  assert.equal(monitor.pendingSignal, null);
  assert.equal(monitor.running, false);
});

test('五秒模式未達成功次數會再排程，切回原模式不清除成功數', async (t) => {
  const config = { ...hybridConfig(), targetSuccessCount: 2 };
  const { monitor } = monitorForTest(config);
  t.after(() => monitor.close());
  fakeProductPage(monitor);
  monitor.clickQualifiedOffer = async () => {};
  monitor.checkoutRunner = async () => ({ status: 'ordered', snapshot: { url: 'test', orderId: 'TEST' } });
  await monitor.start();
  await monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(monitor.storage().completedCount, 1);
  assert.ok(monitor.timer);
  config.mode = 'scan_signal';
  await monitor.start();
  assert.equal(monitor.storage().completedCount, 1);
  assert.equal(monitor.storage().status, 'waiting_signal');
  assert.equal(monitor.timer, null);
});

test('最終送單回覆遺失會停在待核對，兩路與只讀檢查都不能恢復下單', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  fakeProductPage(monitor);
  monitor.clickQualifiedOffer = async () => {};
  monitor.checkoutRunner = async (_page, _snapshot, recordStep) => { await recordStep('submit_order'); throw new Error('response lost'); };
  await monitor.start();
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /response lost/);
  assert.equal(monitor.storage().status, 'needs_review');
  assert.equal(monitor.timer, null);
  assert.equal(monitor.storage().completedCount, 0);
  assert.equal((await monitor.scanOnce()).reason, 'order_needs_review');
  await monitor.start();
  assert.equal(monitor.timer, null);
  assert.equal((await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' })).reason, 'order_needs_review');
});

test('429 遵守 Retry-After，補貨訊號不能繞過降速期限', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  const { page, reads } = fakeProductPage(monitor);
  page.goto = async () => ({ status: () => 429, headers: () => ({ 'retry-after': '120' }) });
  await monitor.start();
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /HTTP 429/);
  assert.ok(Date.parse(monitor.storage().backoffUntil) - Date.now() > 119_000);
  await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' });
  assert.ok(Date.parse(monitor.nextAttemptAt) - Date.now() > 119_000);
  assert.equal((await monitor.scanOnce()).reason, 'cooling_down');
  assert.equal(reads(), 0);
});

test('登入失效暫停輪詢；完成登入前新訊號不會打開購買', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  fakeProductPage(monitor, { ...goodSnapshot(), signedIn: false, loginRequired: true });
  await monitor.start();
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /登入/);
  assert.equal(monitor.storage().status, 'needs_login');
  assert.equal(monitor.timer, null);
  assert.equal((await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' })).reason, 'login_required');
});

test('舊版把不完整頁誤判登出時可自動恢復，真正登入頁仍保持暫停', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  Object.assign(monitor.storage(), {
    status: 'needs_login',
    lastError: '舊版誤判',
    lastSnapshot: { loginRequired: false, signedIn: false, pageIssue: 'product_unreadable' }
  });
  await monitor.start();
  assert.equal(monitor.storage().status, 'waiting_poll');
  assert.equal(monitor.storage().lastError, '');

  monitor.stop();
  Object.assign(monitor.storage(), {
    status: 'needs_login',
    lastError: '明確登入失效',
    lastSnapshot: { loginRequired: true, signedIn: false, pageIssue: 'product_unreadable' }
  });
  await monitor.start();
  assert.equal(monitor.storage().status, 'needs_login');
  assert.equal(monitor.timer, null);
});

test('三條五秒線首次請求錯開，後續仍維持各自五秒週期', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const monitors = ['A', 'B', 'C'].map((slot) => {
    const state = { data: { commerce: {} }, save: async () => {} };
    const config = hybridConfig();
    return new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config, slot, storageKey: `order${slot}` });
  });
  t.after(() => monitors.forEach((monitor) => monitor.close()));
  await Promise.all(monitors.map((monitor) => monitor.start()));
  assert.deepEqual(monitors.map((monitor) => Date.parse(monitor.nextAttemptAt) - Date.now()), [5000, 6650, 8300]);
});

test('停止任務立即取消兩路；正在檢查時禁止重設或開登入視窗', async (t) => {
  const { monitor } = monitorForTest(hybridConfig());
  t.after(() => monitor.close());
  await monitor.start();
  monitor.running = true;
  await assert.rejects(monitor.resetProgress(), /正在檢查或結帳/);
  await assert.rejects(monitor.openLogin(), /正在檢查或結帳/);
  monitor.running = false;
  monitor.stop();
  assert.equal(monitor.timer, null);
  assert.equal(monitor.nextAttemptAt, null);
  assert.equal((await monitor.requestPurchaseFromSignal(verifiedSignal, { source: '日亞官方原價', kind: 'restock' })).reason, 'paused_for_login_or_stop');
});

test('商品快照一次讀 DOM，缺價格／按鈕不等待 locator，也不誤報非自營', async () => {
  const { monitor } = monitorForTest();
  let evaluations = 0;
  const document = {
    title: 'BEYBLADE X BX-40', body: { innerText: '現在在庫切れです。' },
    querySelector: (selector) => selector === '#productTitle' ? { textContent: 'BEYBLADE X BX-40' }
      : selector.startsWith('#nav-link-accountList') ? { textContent: 'テストさん' } : null,
    querySelectorAll: () => []
  };
  const page = {
    url: () => targetUrl,
    locator: () => assert.fail('不得逐一等待缺少的價格 selector'),
    evaluate: async (fn) => { evaluations += 1; return vm.runInNewContext(`(${fn.toString()})()`, { document, getComputedStyle: () => ({}) }); }
  };
  const snapshot = await monitor.productSnapshot(page);
  assert.equal(evaluations, 1);
  assert.equal(snapshot.priceText, '');
  assert.equal(snapshot.buyNowAvailable, false);
  assert.equal(snapshot.signedIn, true);
  assert.equal(evaluateAmazonJpProductOrder(snapshot, { msrpYen: 880 }).reason, 'not_purchasable');
});

test('商品快照卡住有三秒上限並關閉該頁，不會留下未完成讀取重疊刷新', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { monitor } = monitorForTest();
  let closed = 0;
  const page = { evaluate: () => new Promise(() => {}), close: async () => { closed += 1; } };
  const pending = assert.rejects(monitor.productSnapshot(page), /超過 3 秒/);
  t.mock.timers.tick(3000);
  await pending;
  assert.equal(closed, 1);
});

test('設定處理器持久化模式，僅切模式不重設進度，省略模式保持現值', async (t) => {
  const config = { amazonJpProductOrders: { A: { ...hybridConfig(), mode: 'scan_signal' } } };
  const { monitor } = monitorForTest(config.amazonJpProductOrders.A);
  monitor.getConfig = () => config.amazonJpProductOrders.A;
  t.after(() => monitor.close());
  monitor.storage().completedCount = 1;
  config.amazonJpProductOrders.A.targetSuccessCount = 2;
  const saved = [];
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const body = source.match(/onSaveAmazonJpProductOrder: async \(body\) => \{([\s\S]*?)\n  \},\n  onOpenAmazonJpProductOrderLogin/)[1];
  const handler = vm.runInNewContext(`(async (body) => {${body}\n})`, {
    config, amazonJpProductOrderBySlot: { A: monitor }, normalizeAmazonJpProductUrl, normalizeAmazonJpProductMode,
    saveConfig: async () => saved.push(JSON.parse(JSON.stringify(config))), log: () => {}
  });
  const canonical = normalizeAmazonJpProductUrl(targetUrl);
  config.amazonJpProductOrders.A.targetUrl = canonical;
  await handler({ slot: 'A', enabled: true, mode: 'hybrid', targetUrl: canonical, targetSuccessCount: 2 });
  assert.equal(saved.at(-1).amazonJpProductOrders.A.mode, 'hybrid');
  assert.equal(monitor.storage().completedCount, 1);
  assert.ok(monitor.timer);
  await handler({ slot: 'A', enabled: false, targetUrl: canonical, targetSuccessCount: 2 });
  assert.equal(saved.at(-1).amazonJpProductOrders.A.mode, 'hybrid');
  assert.equal(monitor.storage().completedCount, 1);
  assert.equal(monitor.timer, null);
  monitor.running = true;
  await assert.rejects(handler({ slot: 'A', enabled: true, mode: 'scan_signal', targetUrl: canonical, targetSuccessCount: 2 }), /正在檢查或結帳/);
  assert.equal(config.amazonJpProductOrders.A.mode, 'hybrid');
  monitor.running = false;
});

test('日亞頁面改為 A B C 三任務並保留永久中文訂單紀錄', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /日亞三組商品頁雙線搶購/);
  assert.match(source, /for\(const slot of \['A','B','C'\]\)/);
  assert.match(source, /永久訂單時間紀錄/);
  assert.match(source, /class="purchase-table-head"/);
  assert.match(source, /const stepsOpen=existingStepLog\?existingStepLog\.open:localStorage\.getItem\('beyblade-amazon-step-log-'\+slot\)==='1'/);
  assert.match(source, /class="purchase-task-log fold" '\+\(stepsOpen\?'open':''\)/);
  assert.doesNotMatch(source, /id="amazon-single-/);
  return;
  const renderer = source.match(/function renderAmazonProductOrder\(s\)\{[\s\S]*?\n\}/)[0];
  const nodes = new Map();
  const sandbox = { amazonProductOrderDirty: false, fmt: String, document: { querySelector: (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {});
    return nodes.get(selector);
  } } };
  vm.createContext(sandbox);
  vm.runInContext(`${renderer}; this.render = renderAmazonProductOrder;`, sandbox);
  const stepLog = Array.from({ length: 19 }, (_, i) => ({ at: `old-${i}`, name: 'refresh_start', elapsedMs: 0 }));
  stepLog.push({ at: 'evaluated', name: 'product_evaluated', result: 'not_purchasable', elapsedMs: 3077 });
  stepLog.push({ at: 'checkout', name: 'checkout_inspect', step: 2, elapsedMs: 4000 });
  stepLog.push({ at: 'submitted', name: 'submit_result', status: 'submitted_unconfirmed', elapsedMs: 5000 });
  const original = JSON.stringify(stepLog);
  sandbox.render({ japanAuctions: { amazonJpProductOrder: { stepLog } } });
  const text = nodes.get('#amazon-product-order-steps').textContent;
  assert.ok(text.startsWith('submitted｜本輪經過 5000 毫秒｜確認送單結果｜已送出，訂單結果待確認'));
  assert.ok(text.indexOf('submitted') < text.indexOf('checkout'));
  assert.ok(text.indexOf('checkout') < text.indexOf('evaluated'));
  assert.ok(text.includes('檢查結帳頁面（第 2 步）'));
  assert.ok(text.includes('商品條件檢查完成｜目前無可用購買按鈕，等待補貨'));
  assert.ok(text.includes('開始刷新商品頁'));
  assert.ok(!text.includes('old-0｜') && !text.includes('old-1｜'));
  assert.ok(text.includes('old-2｜'));
  assert.doesNotMatch(text, /refresh_start|product_evaluated|not_purchasable|submit_result/);
  assert.equal(JSON.stringify(stepLog), original);
  sandbox.render({ japanAuctions: { amazonJpProductOrder: { stepLog: [] } } });
  assert.equal(nodes.get('#amazon-product-order-steps').textContent, '尚無紀錄');
  sandbox.render({ japanAuctions: { amazonJpProductOrder: { stepLog: [], orderHistory: {
    total: 1, directory: 'test-history', error: '保存警示', recent: [{ id: 'test-record', startedAt: '2026-09-22T01:00:00Z',
      status: 'ordered', trigger: 'poll', orderId: 'TEST-ORDER', product: { code: 'UX-20', title: '<商品文字>' },
      timings: { refreshToConfirmedMs: 5500, signalToRefreshMs: null },
      steps: [{ name: 'submit_order', at: '2026-09-22T01:00:05Z', elapsedMs: 5000 }] }]
  } } } });
  const archiveText = nodes.get('#amazon-product-order-history').textContent;
  assert.match(archiveText, /訂單成立｜UX-20｜五秒輪詢/);
  assert.match(archiveText, /刷新至確認成立：5\.500 秒/);
  assert.match(archiveText, /訊號至刷新：未記錄/);
  assert.match(archiveText, /TEST-ORDER/);
  assert.match(archiveText, /送出訂單/);
  assert.match(archiveText, /test-record\.json/);
  assert.equal(nodes.get('#amazon-product-history-error').textContent, '保存警示');
});

test('三平台下單 UI 使用緊湊條列並保留帳號設定展開狀態', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const overview = await fs.readFile(new URL('../src/dashboard-overview.js', import.meta.url), 'utf8');
  assert.match(source, /class="funbox-account purchase-account-row compact"/);
  assert.match(source, /function toggleFunboxAccountCard/);
  assert.match(source, /card\.classList\.toggle\('compact',!funboxExpandedSlots\.has\(slot\)\)/);
  assert.match(source, /card\.classList\.add\('purchase-account-row'\).*card\.classList\.toggle\('compact',!esliteExpandedSlots\.has\(slot\)\)/);
  assert.match(source, /const apiState=esliteAccountReadiness\(a,account,runtimeAccount\)\.text/);
  assert.match(source, /API 快線就緒/);
  assert.match(source, /單品／合單各帳號自選，最多三路並行/);
  assert.match(source, /偵測到變化，暫時每 90 秒檢查/);
  assert.match(source, /平常每 10 分鐘檢查/);
  assert.match(source, /class="purchase-task-list"/);
  assert.ok(source.indexOf('id="shopping-target-list"') < source.indexOf('id="shopping-target-name"'));
  assert.equal((source.match(/新增監控專區/g)||[]).length, 1);
  assert.match(overview, /beyblade-ui-fold-v3-'\+tab\+'-'\+anchor/);
  assert.match(overview, /japan:\[\['一般網站','#japan-target-list'\]/);
});

test('三條日亞任務各自保留兩種模式與未儲存選擇', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /amazonProductOrderDirty=\{A:false,B:false,C:false\}/);
  assert.match(source, /五秒＋訊號雙線/);
  assert.match(source, /markAmazonProductOrderDirty/);
  return;
  const renderer = source.match(/function renderAmazonProductOrder\(s\)\{[\s\S]*?\n\}/)[0];
  const nodes = new Map();
  const sandbox = { amazonProductOrderDirty: false, fmt: String, document: { querySelector: (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {});
    return nodes.get(selector);
  } } };
  vm.createContext(sandbox);
  vm.runInContext(`${renderer}; this.render = renderAmazonProductOrder;`, sandbox);
  const status = { enabled: true, mode: 'hybrid', status: 'waiting_poll', completedCount: 1, targetSuccessCount: 2 };
  const render = () => sandbox.render({ japanAuctions: { amazonJpProductOrder: status, amazonJp: { enabled: true } } });
  render();
  assert.equal(nodes.get('#amazon-product-order-mode').value, 'hybrid');
  assert.equal(nodes.get('#amazon-product-order-state').textContent, '五秒雙線待命');
  status.running = true;
  status.phase = 'inspecting';
  render();
  assert.equal(nodes.get('#amazon-product-order-state').textContent, '只讀檢查中（不下單）');
  status.phase = 'ordering';
  render();
  assert.equal(nodes.get('#amazon-product-order-state').textContent, '正在結帳（停止刷新）');
  sandbox.amazonProductOrderDirty = true;
  status.mode = 'scan_signal';
  render();
  assert.equal(nodes.get('#amazon-product-order-mode').value, 'hybrid');
  sandbox.amazonProductOrderDirty = false;
  render();
  assert.equal(nodes.get('#amazon-product-order-mode').value, 'scan_signal');
});
