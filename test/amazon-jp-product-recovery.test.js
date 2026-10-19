import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { AmazonJpProductOrderMonitor, validateAmazonJpProductCheckout } from '../src/amazon-jp-product-order.js';
import { advanceAmazonJpCheckout, clickAndWaitForAmazonNavigation, parseAmazonJpCheckoutSnapshot, readAmazonJpCheckoutSnapshot, AmazonJpSingleOrderMonitor } from '../src/amazon-jp-single-order.js';
import { amazonProductRecoveryDelay } from '../src/amazon-jp-page-readiness.js';

const targetUrl = 'https://www.amazon.co.jp/dp/B0DWSBHQWD';
const targetAsin = 'B0DWSBHQWD';
function fixture(t, config = {}) {
  const settings = { enabled: false, mode: 'hybrid', targetUrl, maxShippingYen: 500, checkoutTransport: 'browser', ...config };
  const state = { data: {}, async save() {} };
  const history = { status: () => ({}), async begin() { return {}; }, async step() {}, async finish() {}, async notification() {} };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => settings, orderHistory: history });
  t.after(() => monitor.close());
  return { monitor, state, settings };
}
const quote = (patch = {}) => ({ url: 'https://www.amazon.co.jp/checkout/p/test/spc', asin: targetAsin,
  asins: [targetAsin], code: 'BX-40', itemCount: 1, quantity: 1, sellerConfirmed: true, deliveryConfirmed: true,
  totalYen: 1380, shippingYen: 500, ...patch });
const limits = { asin: targetAsin, code: 'BX-40', msrpYen: 880, maxShippingYen: 500 };

test('送單前接受運費 500，拒絕缺資料、混車、數量變動、第三方、超價及配送未知', () => {
  assert.deepEqual(validateAmazonJpProductCheckout(quote(), limits), { totalYen: 1380, shippingYen: 500 });
  for (const patch of [{ itemCount: 2 }, { quantity: 2 }, { asin: 'B0HJ783F18' }, { asins: [targetAsin, 'B0HJ783F18'] },
    { code: 'BX-41' }, { sellerConfirmed: false }, { deliveryConfirmed: false }, { totalYen: null },
    { shippingYen: null }, { shippingYen: 501 }, { totalYen: 1382 }, { url: 'https://amazon.co.jp.evil.test/checkout/' }]) {
    assert.throws(() => validateAmazonJpProductCheckout(quote(patch), limits));
  }
});

test('結帳金額解析包含零運費及含運總額，不把未知當作零', () => {
  const parsed = parseAmazonJpCheckoutSnapshot({ bodyText: '注文合計: ￥1,380 配送料・手数料: ￥500', deliveryConfirmed: true });
  assert.equal(parsed.totalYen, 1380);
  assert.equal(parsed.shippingYen, 500);
  assert.equal(parseAmazonJpCheckoutSnapshot({ totalText: '¥880', shippingText: '¥0' }).shippingYen, 0);
  assert.equal(parseAmazonJpCheckoutSnapshot({ totalText: '¥880' }).shippingYen, null);
  assert.equal(parseAmazonJpCheckoutSnapshot({ totalText: 'TWD 880' }).totalYen, null);
});

test('點擊使用 Locator 可操作性，不能退回 JavaScript click；點擊失敗不再點一次', async () => {
  let clicks = 0;
  const locator = { async click(options) { assert.equal(options.timeout, 15000); clicks++; }, async evaluate() { assert.fail('不得用 JS 點擊'); } };
  const page = { url: () => targetUrl, async waitForURL() {} };
  await clickAndWaitForAmazonNavigation(page, locator);
  assert.equal(clicks, 1);
  locator.click = async () => { clicks++; throw new Error('covered button'); };
  await assert.rejects(clickAndWaitForAmazonNavigation(page, locator), /covered button/);
  assert.equal(clicks, 2);
});

test('真正瀏覽器慢載入超過 250ms 仍等到報價；明確缺貨快回、驗證及空白分開記錄', async t => {
  const { monitor } = fixture(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<body><script>setTimeout(()=>{document.body.innerHTML='<span id="productTitle">BEYBLADE X BX-40</span><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">¥880</span></span></div><input name="merchantID" value="AN1VRQENFRJN5"><button id="buy-now-button">Buy</button>';},450);</script></body>`);
  const started = Date.now();
  const loaded = await monitor.productSnapshot(page);
  assert.ok(Date.now() - started >= 300);
  assert.equal(loaded.priceYen, 880);
  assert.equal(loaded.sellerConfirmed, true);
  assert.equal(loaded.diagnostic.readiness.state, 'offer');
  await page.setContent('<span id="productTitle">BEYBLADE X BX-40</span><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">¥880</span></span></div><input name="merchantID" value="AN1VRQENFRJN5"><button id="buy-now-button" hidden>Buy</button>');
  const hidden = await monitor.productSnapshot(page);
  assert.equal(hidden.diagnostic.readiness.state, 'time_limit');
  assert.equal(hidden.buyNowAvailable, false);
  await page.setContent('<span id="productTitle">BEYBLADE X BX-40</span><div id="availability">現在在庫切れです。</div>');
  const unavailable = await monitor.productSnapshot(page);
  assert.equal(unavailable.diagnostic.readiness.state, 'unavailable');
  assert.equal(unavailable.pageIssue, '');
  await page.setContent('<h1>Robot Check</h1><input id="captchacharacters">');
  const captcha = await monitor.productSnapshot(page);
  assert.equal(captcha.pageIssue, 'human_verification');
  assert.equal(captcha.diagnostic.readiness.state, 'human_verification');
  await page.setContent('<body>private-cookie-data@example.test</body>');
  const blank = await monitor.productSnapshot(page, 202);
  assert.equal(blank.pageIssue, 'product_unreadable');
  assert.equal(blank.diagnostic.readiness.state, 'time_limit');
  assert.equal(blank.diagnostic.hasProductTitle, false);
  assert.doesNotMatch(JSON.stringify(blank.diagnostic), /private-cookie|example.test/);
  await page.setContent('<span id="item-block-product-title-1">BEYBLADE X BX-40</span><a href="https://www.amazon.co.jp/dp/B0DWSBHQWD">商品</a><span data-a-selector="inner-value">1</span><p>販売元: Amazon.co.jp</p><div id="shipping-address">テスト配送先</div><p>注文合計: ￥1,380 配送料・手数料: ￥500</p><input name="placeYourOrder1" type="submit">');
  const checkout = await readAmazonJpCheckoutSnapshot(page);
  assert.equal(checkout.asin, targetAsin);
  assert.equal(checkout.itemCount, 1);
  assert.equal(checkout.quantity, 1);
  assert.equal(checkout.totalYen, 1380);
  assert.equal(checkout.shippingYen, 500);
  assert.equal(checkout.deliveryConfirmed, true);
  assert.equal(checkout.sellerConfirmed, true);
});

test('結帳讀取卡住有上限且關閉該頁，不能留下重疊 DOM 讀取', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = 0;
  const page = { evaluate: () => new Promise(() => {}), close: async () => { closed++; } };
  const pending = assert.rejects(readAmazonJpCheckoutSnapshot(page), /超過 3 秒/);
  t.mock.timers.tick(3000);
  await pending;
  assert.equal(closed, 1);
});

test('人工驗證停止兩路，補貨訊號及重啟不能自行解除', async t => {
  const { monitor, settings } = fixture(t, { enabled: true });
  const page = { url: () => targetUrl, async reload() { return { status: () => 200 }; }, async goto() { return { status: () => 200 }; } };
  monitor.pageFor = async () => page;
  monitor.productSnapshot = async () => ({ asin: targetAsin, pageIssue: 'human_verification', diagnostic: { httpStatus: 200 } });
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /人工驗證/);
  assert.equal(monitor.storage().status, 'needs_verification');
  assert.equal(monitor.timer, null);
  const signal = { asin: targetAsin, available: true, sellerConfirmed: true, priceYen: 880, msrpYen: 880 };
  assert.equal((await monitor.requestPurchaseFromSignal(signal, { source: '日亞官方原價', kind: 'restock' })).reason, 'verification_required');
  await monitor.start();
  assert.equal(monitor.storage().status, 'needs_verification');
  assert.equal(monitor.timer, null);
  assert.equal(settings.enabled, true);
});

test('連續空白依 2/5/15/30/60 秒退避，只重開商品頁一次而不重建帳號 context', async t => {
  const { monitor } = fixture(t);
  let closed = 0, contextClosed = 0;
  const page = { url: () => targetUrl, async reload() { return { status: () => 200 }; }, async goto() { return { status: () => 200 }; }, async close() { closed++; } };
  const context = { async close() { contextClosed++; } };
  monitor.context = context;
  monitor.page = page;
  monitor.pageFor = async () => { monitor.page = page; return page; };
  monitor.productSnapshot = async () => ({ asin: targetAsin, title: '', pageIssue: 'product_unreadable' });
  for (let count = 1; count <= 6; count++) {
    delete monitor.storage().backoffUntil;
    await assert.rejects(monitor.scanOnce(), /有限恢復/);
    const delay = Date.parse(monitor.storage().backoffUntil) - Date.now();
    assert.ok(delay <= amazonProductRecoveryDelay(count) && delay > amazonProductRecoveryDelay(count) - 100);
  }
  assert.equal(closed, 1);
  assert.equal(monitor.context, context);
  assert.equal(contextClosed, 0);
  monitor.context = null;
});

function checkoutPage() {
  let clicks = 0;
  const button = { first() { return this; }, count: async () => 1, isVisible: async () => true, isEnabled: async () => true, async click() { clicks++; } };
  const missing = { first() { return this; }, count: async () => 0 };
  return { page: { locator: selector => selector.startsWith('#submitOrderButtonId') ? button : missing, async waitForLoadState() {} }, clicks: () => clicks };
}

test('最終核對失败及中途停止不送單；送單後斷線只點一次', async () => {
  const f = checkoutPage(), steps = [];
  await assert.rejects(advanceAmazonJpCheckout(f.page, async () => quote({ shippingYen: 501 }), async name => steps.push(name),
    { beforeSubmit: value => validateAmazonJpProductCheckout(value, limits) }), /運費/);
  assert.equal(f.clicks(), 0);
  assert.ok(!steps.includes('submit_order'));
  await assert.rejects(advanceAmazonJpCheckout(f.page, async () => quote(), async () => {}, { canContinue: () => false }), /已停止/);
  assert.equal(f.clicks(), 0);
  let snapshots = 0;
  await assert.rejects(advanceAmazonJpCheckout(f.page, async () => { if (snapshots++) throw new Error('lost response'); return quote(); }, async () => {},
    { beforeSubmit: value => validateAmazonJpProductCheckout(value, limits) }), /lost response/);
  assert.equal(f.clicks(), 1);
});

test('完成頁沒有正式單號不報成功，也不再次點送單', async () => {
  const f = checkoutPage();
  let snapshots = 0;
  const result = await advanceAmazonJpCheckout(f.page, async () => snapshots++ ? { confirmed: true } : quote());
  assert.equal(result.status, 'submitted_unconfirmed');
  assert.equal(f.clicks(), 1);
});

test('商品頁監控實際接上最終核對，超運費攔截並保留錯誤紀錄', async t => {
  const { monitor } = fixture(t, { enabled: true });
  const f = checkoutPage();
  f.page.url = () => targetUrl;
  f.page.reload = async () => ({ status: () => 200 });
  f.page.goto = f.page.reload;
  monitor.pageFor = async () => f.page;
  monitor.productSnapshot = async () => ({ asin: targetAsin, code: 'BX-40', title: 'BEYBLADE X BX-40', priceYen: 880, priceText: '¥880', sellerConfirmed: true, buyNowAvailable: true });
  monitor.resolveMsrp = () => ({ msrpYen: 880 });
  monitor.clickQualifiedOffer = async () => {};
  monitor.checkoutSnapshot = async () => quote({ shippingYen: 501 });
  await assert.rejects(monitor.scanOnce({ purchase: true, trigger: 'poll' }), /運費/);
  assert.equal(f.clicks(), 0);
  assert.equal(monitor.storage().completedCount, 0);
  assert.notEqual(monitor.storage().status, 'needs_review');
});

test('舊單品流程送單後斷線／結果不明皆暫停，不刷新、不重送', async () => {
  const state = { data: {}, async save() {} };
  const monitor = new AmazonJpSingleOrderMonitor({ dataDir: '.', state, getConfig: () => ({ enabled: true, targetUrl: 'https://www.amazon.co.jp/checkout/p/test/itemselect' }) });
  let visits = 0;
  const page = { url: () => 'https://www.amazon.co.jp/checkout/p/test/itemselect', async reload() {}, async goto() { visits++; }, async waitForTimeout() {} };
  monitor.pageFor = async () => page;
  monitor.snapshot = async () => quote();
  monitor.advanceCheckout = async (_page, _initial, onSubmit) => { onSubmit(); throw new Error('response lost'); };
  await assert.rejects(monitor.scanOnce(), /response lost/);
  assert.equal(monitor.storage().status, 'needs_review');
  assert.equal(visits, 0);
  assert.equal((await monitor.scanOnce()).reason, 'order_needs_review');
  monitor.start();
  assert.equal(monitor.timer, null);
  await monitor.close();
});
