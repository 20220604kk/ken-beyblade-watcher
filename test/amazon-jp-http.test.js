import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { AmazonJpHttpClient, amazonAodUrl, amazonHttpForm, parseAmazonAod, amazonOfferDecisionText,
  parseAmazonHttpCart, parseAmazonHttpReview, amazonOfficialOrderIds, matchesAmazonOfficialDetail, amazonOrderIdFromCompletion } from '../src/amazon-jp-http.js';
import { amazonThreeSteps } from '../src/amazon-three-steps.js';
import { openAmazonBrowserDirectEntry } from '../src/amazon-browser-direct-entry.js';
import { AmazonJpProductOrderMonitor, validateAmazonJpProductCheckout } from '../src/amazon-jp-product-order.js';

// Synthetic HTML only. No cookies, account details, real order IDs or network.
const asin = 'B0TEST0001', otherAsin = 'B0TEST0002';
const oldId = '000-0000000-0000001', newId = '000-0000000-0000002';
const origin = 'https://www.amazon.co.jp';
const seller = 'AN1VRQENFRJN5';
const page = (html, url = origin + '/checkout/p/fixture/spc') => ({ $: load(html), url });
const input = (name, value = '', type = 'hidden') => `<input type="${type}" name="${name}" value="${value}">`;
function directProductHtml({ merchant = seller, target = asin, price = 880, currency = 'JPY', quantity = '1', token = 'fixture-product-token', disabled = false, offer = 'fixture-offer',
  buttonAction = '/checkout/entry/buynow' } = {}) {
  return `<span id="productTitle">BEYBLADE X BX-40</span><div id="buybox"><div id="merchantInfoFeature_feature_div">Seller: ${merchant === seller ? 'Amazon.co.jp' : 'Third party'}</div>
    <form method="post" action="/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance">
    ${input('anti-csrftoken-a2z', token)}${input('ASIN', target)}${input('offerListingID', offer)}
    ${input('merchantID', merchant)}${input('items[0.base][quantity]', quantity)}${input('items[0.base][customerVisiblePrice][currencyCode]', currency)}
    ${input('items[0.base][customerVisiblePrice][amount]', price)}
    <input id="buy-now-button" type="submit" name="submit.buy-now" value="Buy now" ${buttonAction === null ? '' : `formaction="${buttonAction}"`} ${disabled ? 'disabled' : ''}></form></div>`;
}
function offerHtml({ sellerId = seller, price = 880, condition = '全新品', target = asin, token = 'fixture-token' } = {}) {
  return `<h1 id="aod-asin-title-text">BEYBLADE X BX-40</h1><div id="aod-container"><div id="aod-offer-list"><div id="aod-offer">
    <h5 id="aod-offer-heading">${condition}</h5><span class="apex-pricetopay-accessibility-label">JP¥${price}</span>
    <div id="aod-offer-soldBy"><a href="/seller?seller=${sellerId}">Seller</a></div>
    <form method="post" action="/cart/add-to-cart/ref=aod_dpdsk_new_1">
    ${input('anti-csrftoken-a2z', token)}${input('items[0.base][asin]', target)}${input('items[0.base][offerListingId]', 'fixture-offer')}
    ${input('items[0.base][quantity]')}${input('submit.addToCart', 'Add', 'submit')}</form></div></div></div>`;
}
const entryForm = () => `<form method="get" action="/checkout/entry/cart">${input('cartItemCount', '1')}${input('proceedToRetailCheckout', '1', 'submit')}</form>`;
function cartHtml({ empty = false, target = asin, quantity = 1, mixed = false, merchant = 'Amazon.co.jp', offering = '' } = {}) {
  return `<span id="nav-cart-count">${empty ? 0 : mixed ? 2 : quantity}</span><div id="sc-active-cart">${empty ? '<h2>您的亚马逊购物车为空</h2>'
    : `<div data-asin="${target}" data-quantity="${quantity}" data-encoded-offering="${offering}"><p>販売元: ${merchant}</p></div>${mixed ? `<div data-asin="${otherAsin}" data-quantity="1"></div>` : ''}`}</div>${entryForm()}`;
}
function reviewHtml({ target = asin, quantity = 1, total = 1380, shipping = 500, points = '', merchant = 'Amazon.co.jp',
  address = true, currency = true, csrf = true, mixed = false } = {}) {
  return `<section id="item-block-1"><span id="item-block-product-title-1">BEYBLADE X BX-40</span><a href="/dp/${target}">Item</a>
    <span data-a-selector="inner-value">${quantity}</span><p>販売元: ${merchant}</p></section>
    ${mixed ? `<section id="item-block-2"><span id="item-block-product-title-2">BEYBLADE X BX-41</span><a href="/dp/${otherAsin}">Item</a></section>` : ''}
    ${address === 'live' ? '<a id="change-delivery-link"><h2 id="deliver-to-customer-text">正在发送至</h2><span id="deliver-to-address-text">Synthetic test destination</span></a>' : address ? '<div id="shipping-address">Synthetic test destination</div>' : ''}
    <p>商品: JPY 880 配送费: JPY ${shipping} 订单总计: JPY ${total}</p>
    <p>商品: TWD 200 配送费: TWD 100 订单总计: TWD 300</p>${points}
    ${currency ? `<input name="currencyOptions" type="radio" value="MARKETPLACE"><form>${input('selectedCurrencyOption', 'MARKETPLACE')}${input('placeYourOrderButtonText', '用JPY下订单')}</form>` : ''}
    <form id="spc-form" method="post" action="/checkout/p/fixture/spc/place-order">
    ${csrf ? input('anti-csrftoken-a2z', 'fresh-review-token') : ''}${input('currentViewId', 'fixture-view')}
    ${input('currentCurrencyOption', 'LOCAL')}${input('placeYourOrder1', '用TWD下订单', 'submit')}
    ${input('setOrderingPrefs', '1', 'checkbox')}</form>`;
}
const historyHtml = ids => `<h1>您的订单</h1><div id="ordersContainer">${ids.length ? ids.map(id => `<div class="order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.${id}"></div>`).join('') : '<p>尚无订单</p>'}</div>`;
const detailHtml = ({ id = newId, target = asin, quantity = 1, total = 1380, shipping = 500, cancelled = false } = {}) =>
  `<h1>订单编号 ${id}</h1><a href="/dp/${target}">BEYBLADE X BX-40</a><p>数量: ${quantity} 販売元: Amazon.co.jp</p><p>金额: JP¥${total} 配送费/手续费: JP¥${shipping}</p>${cancelled ? '<p>已取消</p>' : ''}`;
function fakeTransport({ addTimeout = false, submitTimeout = false, submitStatus = 302, noNewOrder = false, cartPatch = {}, reviewPatch = {},
  cartInitiallyFull = false, initialCartPatch = {}, offerPatch = {}, inlineCart = false, addVerification = false, duplicateMatches = false,
  directPatch = {}, buyTimeout = false, noCompletionId = false } = {}) {
  const calls = []; let added = false, submitted = false;
  const transport = { async fetch(url, options) {
    const u = new URL(url), method = options.method || 'GET';
    calls.push({ path: u.pathname, method, fields: new URLSearchParams(options.data), options });
    let html = '', status = 200, headers = {};
    if (u.pathname.includes('/aodAjaxMain/')) html = offerHtml(offerPatch);
    else if (u.pathname.startsWith('/dp/')) html = directProductHtml(directPatch);
    else if (u.pathname === '/checkout/entry/buynow' || u.pathname.startsWith('/gp/product/handle-buy-box/')) {
      if (buyTimeout) throw new Error('fixture response lost');
      status = 302; headers = { location: '/checkout/p/fixture/spc' };
    }
    else if (u.pathname === '/checkout/p/fixture/spc') html = reviewHtml(reviewPatch);
    else if (u.pathname.includes('/gp/cart/view.html')) html = cartHtml(added ? cartPatch : { empty: !cartInitiallyFull, ...initialCartPatch });
    else if (u.pathname.includes('/order-history')) html = historyHtml(submitted && !noNewOrder ? [newId, ...(duplicateMatches ? ['000-0000000-0000003'] : []), oldId] : [oldId]);
    else if (u.pathname.startsWith('/cart/add-to-cart/')) {
      added = true;
      if (addTimeout) throw new Error('Sensitive transport error must not be propagated');
      html = addVerification ? '<h1>Robot Check</h1>' : inlineCart ? cartHtml(cartPatch)
        : '<p>商品已加入购物车</p><span id="nav-cart-count">1</span>' + entryForm();
    } else if (u.pathname === '/checkout/entry/cart') html = reviewHtml(reviewPatch);
    else if (u.pathname.endsWith('/spc/place-order')) {
      submitted = true;
      if (submitTimeout) throw new Error('Response lost');
      status = submitStatus;
      headers = { location: '/gp/buy/thankyou/handlers/display.html?purchaseId=999-9999999-9999999' };
      html = '<p>Order posted</p>';
    } else if (u.pathname.includes('/thankyou/')) html = '<p>订单已提交</p>' + (noNewOrder || noCompletionId ? '' : `<a href="/your-orders/order-details?orderID=${newId}">Order details</a>`);
    else if (u.pathname === '/your-orders/order-details') html = detailHtml({ id: u.searchParams.get('orderID') });
    else assert.fail(`Unexpected fixture route ${u.pathname}`);
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} };
  } };
  return { calls, transport };
}
function clientFixture(options = {}) {
  const f = fakeTransport(options), checkpoints = [], steps = [];
  const client = new AmazonJpHttpClient({ request: f.transport, canContinue: () => true,
    checkpoint: async tx => checkpoints.push(tx ? structuredClone(tx) : null), recordStep: async name => steps.push(name) });
  return { ...f, client, checkpoints, steps };
}
const validate = checkout => validateAmazonJpProductCheckout(checkout, { asin, code: 'BX-40', msrpYen: 880, maxShippingYen: 500 });

test('02 直購跳轉 404 保存實際失敗回應，本輪不重送；未送單可於冷卻後重新取得新商品流程', async t => {
  const f=monitorFixture(t),captures=[];f.config.fastLane=true;
  const originalFetch=f.transport.fetch;
  f.transport.fetch=async(url,options)=>{
    const response=await originalFetch(url,options);
    if(new URL(url).pathname==='/checkout/p/fixture/spc')return{status:()=>404,headers:()=>({}),text:async()=>'<h1>Actual fixture 404 body</h1>',dispose:async()=>{}};
    return response;
  };
  f.monitor.orderHistory.captureEvidence=(_record,kind,input)=>captures.push({kind,...input});
  await assert.rejects(f.monitor.scanOnce({purchase:true,trigger:'poll'}),/結帳入口回傳 HTTP 404/);
  assert.deepEqual(captures.map(item=>item.kind),['entry','failure']);
  assert.equal(captures[1].status,404);assert.match(captures[1].html,/Actual fixture 404 body/);
  assert.equal(new URL(captures[1].url).pathname,'/checkout/p/fixture/spc');
  assert.equal(captures[1].trace.length,2);assert.equal(captures[1].trace[0].method,'POST');assert.equal(captures[1].trace[1].status,404);
  assert.equal(f.calls.filter(item=>item.method==='POST').length,1);
  assert.equal(f.calls.some(item=>item.path.endsWith('/place-order')),false);
  assert.equal(f.monitor.storage().apiTransaction,undefined);assert.equal(f.monitor.storage().status,'waiting_poll');
  assert.equal(f.monitor.storage().preSubmitRetry.attempts,1);assert.equal(f.monitor.canSchedule(),true);
  assert.equal(f.monitor.status().purchaseSteps.at(-1).step,'02');
});

test('API 02 快照回呼壞掉也不更動官網請求次數或成功結果', async()=>{
  const f=clientFixture();f.client.directBuyNow=true;
  f.client.captureEvidence=()=>{throw new Error('evidence unavailable');};
  const result=await f.client.checkout(await f.client.readOffer(asin),{beforeSubmit:validate});
  assert.equal(result.status,'ordered');assert.equal(result.snapshot.orderId,newId);
  assert.equal(f.calls.filter(item=>item.method==='POST').length,2);
});

test('AOD only selects new Amazon retail offer, never third-party Amazon fulfillment or used', () => {
  const good = parseAmazonAod(page(offerHtml()), asin);
  assert.equal(good.snapshot.priceYen, 880); assert.equal(good.snapshot.addCartAvailable, true);
  for (const patch of [{ sellerId: 'THIRD_PARTY' }, { condition: '中古品' }, { target: otherAsin }, { token: '' }]) {
    assert.equal(parseAmazonAod(page(offerHtml(patch)), asin).snapshot.addCartAvailable, false);
  }
  assert.equal(parseAmazonAod(page(''), asin).snapshot.pageIssue, 'product_unreadable');
  assert.equal(parseAmazonAod(page('<h1 id="aod-asin-title-text">BEYBLADE X BX-40</h1><div id="aod-container">現在在庫切れです</div>'), asin).snapshot.pageIssue, '');
  assert.equal(new URL(amazonAodUrl(asin)).searchParams.get('asin'), asin);
});

test('live Chinese label 全新品 qualifies; near-match used labels still cannot qualify', () => {
  for (const condition of ['全新品', '全新', '新品', 'New']) {
    assert.equal(parseAmazonAod(page(offerHtml({ condition })), asin).snapshot.addCartAvailable, true, condition);
  }
  for (const condition of ['非全新品', '二手', '中古品', 'Used', 'Renewed', '新品同様']) {
    const parsed = parseAmazonAod(page(offerHtml({ condition })), asin);
    assert.equal(parsed.snapshot.addCartAvailable, false, condition);
    assert.equal(parsed.snapshot.diagnostic.decision, 'no_new_amazon_retail_offer');
  }
});

test('offer diagnostics distinguish no retail, condition, contract and price without retaining secrets', () => {
  const scenarios = [
    [{ sellerId: 'THIRD_PARTY' }, 'no_amazon_retail_offer', 'seller_not_amazon'],
    [{ condition: '中古品' }, 'no_new_amazon_retail_offer', 'condition_not_new'],
    [{ token: '' }, 'retail_contract_incomplete', 'missing_csrf'],
    [{ price: 'unknown' }, 'retail_price_unreadable', 'price_unreadable']
  ];
  for (const [patch, decision, reason] of scenarios) {
    const { diagnostic } = parseAmazonAod(page(offerHtml(patch)), asin).snapshot;
    assert.equal(diagnostic.decision, decision);
    assert.equal(diagnostic.rejectionCounts[reason], 1);
    assert.ok(amazonOfferDecisionText(diagnostic));
    assert.equal(/fixture-token|fixture-offer|anti-csrftoken|offerListingId/.test(JSON.stringify(diagnostic)), false);
  }
  const noOffers = parseAmazonAod(page('<h1 id="aod-asin-title-text">BX-40</h1><div id="aod-container">No offers</div>'), asin);
  assert.equal(noOffers.snapshot.diagnostic.decision, 'no_offers');
  assert.match(amazonOfferDecisionText({ decision: 'retail_contract_incomplete' }), /不能判定售罄/);
});

test('cart read rejects mixed ASIN or unknown count; saved-for-later does not count as active', () => {
  assert.equal(parseAmazonHttpCart(page(cartHtml({ empty: true }))).empty, true);
  assert.equal(parseAmazonHttpCart(page('<h2>cart is empty</h2>')).empty, false);
  const cart = parseAmazonHttpCart(page(cartHtml() + `<div id="sc-saved-cart"><div data-asin="${otherAsin}"></div></div>`));
  assert.deepEqual(cart.items, [{ asin, quantity: 1, sellerConfirmed: true }]);
});

test('JPY choice binds the final POST; hidden JPY quote alone is not the active currency', () => {
  const review = parseAmazonHttpReview(page(reviewHtml()), { priceYen: 880 });
  assert.equal(review.checkout.totalYen, 1380); assert.equal(review.checkout.pointsUsed, 0);
  assert.equal(review.overrides.currentCurrencyOption, 'MARKETPLACE');
  assert.equal(review.overrides.setOrderingPrefs, '');
  assert.throws(() => parseAmazonHttpReview(page(reviewHtml({ currency: false })), { priceYen: 880 }), /JPY/);
  assert.throws(() => parseAmazonHttpReview(page(reviewHtml({ csrf: false })), { priceYen: 880 }), /契約/);
  assert.throws(() => parseAmazonHttpReview(page(reviewHtml({ points: '<p>ポイント利用: 150</p>', total: 1230 })), { priceYen: 880 }), /折點/);
  assert.throws(() => parseAmazonHttpReview(page(reviewHtml() + '<p>订单总计: JPY 1381</p>'), { priceYen: 880 }), /金額/);
});

test('normal full API chain uses one add and one order POST, fresh fields, official order not purchaseId', async () => {
  const f = clientFixture(); const snapshot = await f.client.readOffer(asin);
  const result = await f.client.checkout(snapshot, { beforeSubmit: validate });
  assert.equal(result.status, 'ordered'); assert.equal(result.snapshot.orderId, newId);
  const posts = f.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2);
  assert.equal(posts[0].fields.get('items[0.base][quantity]'), '1');
  assert.equal(posts[1].fields.get('anti-csrftoken-a2z'), 'fresh-review-token');
  assert.equal(posts[1].fields.get('currentCurrencyOption'), 'MARKETPLACE');
  assert.equal(posts[1].fields.get('setOrderingPrefs'), '');
  assert.deepEqual(f.checkpoints.map(tx => tx.phase), ['adding', 'cart_ready', 'submitted', 'confirmed']);
  assert.ok(f.calls.every(c => c.options.maxRetries === 0 && c.options.maxRedirects === 0));
  await assert.rejects(f.client.checkout(snapshot, { beforeSubmit: validate }), /禁止重複/);
});

test('fast checkout resumes only exact target, quantity one, retail and same fresh offer; saves add plus cart GET', async () => {
  const normal = clientFixture();
  await normal.client.checkout(await normal.client.readOffer(asin), { beforeSubmit: validate });
  const f = clientFixture({ cartInitiallyFull: true, initialCartPatch: { offering: 'fixture-offer' } });
  f.client.fastCheckout = true;
  const snapshot = await f.client.readOffer(asin);
  assert.equal((await f.client.checkout(snapshot, { beforeSubmit: validate })).status, 'ordered');
  assert.equal(f.calls.filter(call => call.path.startsWith('/cart/add-to-cart/')).length, 0);
  assert.equal(f.calls.filter(call => call.path.includes('/gp/cart/view.html')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/place-order')).length, 1);
  assert.equal(normal.calls.length - f.calls.length, 2);
  assert.equal(f.checkpoints[0].phase, 'cart_ready');
  assert.equal(f.checkpoints[0].route, 'existing_target_cart');
  assert.ok(f.steps.includes('api_cart_resume'));
  assert.equal(/fixture-offer|fixture-token/.test(JSON.stringify(f.checkpoints)), false);
  await assert.rejects(f.client.checkout(snapshot, { beforeSubmit: validate }), /禁止重複/);
});

test('fast cart resume preserves all unknown/mixed/third-party/offer-mismatch carts without any POST', async () => {
  for (const initialCartPatch of [{ offering: '' }, { offering: 'different-offer' }, { offering: '%bad' },
    { offering: 'fixture-offer', target: otherAsin }, { offering: 'fixture-offer', mixed: true },
    { offering: 'fixture-offer', quantity: 2 }, { offering: 'fixture-offer', merchant: 'Third party' }]) {
    const f = clientFixture({ cartInitiallyFull: true, initialCartPatch });
    f.client.fastCheckout = true;
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }), { code: 'AMAZON_CART_REVIEW' });
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  }
});

test('resumed cart still checks JPY, points, price, seller, quantity and shipping before submission', async () => {
  for (const reviewPatch of [{ target: otherAsin }, { mixed: true }, { quantity: 2 }, { merchant: 'Third party' },
    { address: false }, { shipping: 501, total: 1381 }, { total: 1500 }, { currency: false },
    { points: '<p>ポイント利用: 150</p>', total: 1230 }, { csrf: false }]) {
    const f = clientFixture({ cartInitiallyFull: true, initialCartPatch: { offering: 'fixture-offer' }, reviewPatch });
    f.client.fastCheckout = true;
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  }
});

test('resumed cart timeout submits once, reconciles only; stopped task never submits or clears the cart', async () => {
  const f = clientFixture({ cartInitiallyFull: true, initialCartPatch: { offering: 'fixture-offer' }, submitTimeout: true, noNewOrder: true });
  f.client.fastCheckout = true;
  assert.equal((await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate })).status, 'submitted_unconfirmed');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.checkpoints.at(-1).phase, 'submitted');
  const stopped = clientFixture({ cartInitiallyFull: true, initialCartPatch: { offering: 'fixture-offer' } });
  stopped.client.fastCheckout = true;
  let enabled = true;
  stopped.client.canContinue = () => enabled;
  stopped.client.checkpoint = async () => { enabled = false; };
  await assert.rejects(stopped.client.checkout(await stopped.client.readOffer(asin), { beforeSubmit: validate }), /已停止/);
  assert.equal(stopped.calls.some(call => call.method === 'POST'), false);
});

test('complete add response saves cart GET; incomplete response, timeout and non-fast routes keep the read', async () => {
  for (const fastCheckout of [true, false]) {
    const f = clientFixture({ inlineCart: true });
    f.client.fastCheckout = fastCheckout;
    await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate });
    assert.equal(f.calls.filter(call => call.path.includes('/gp/cart/view.html')).length, fastCheckout ? 1 : 2);
  }
  for (const options of [{}, { addTimeout: true }, { inlineCart: true, cartPatch: { merchant: 'Third party' } }]) {
    const f = clientFixture(options); f.client.fastCheckout = true;
    await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate });
    assert.equal(f.calls.filter(call => call.path.includes('/gp/cart/view.html')).length, 2);
    assert.equal(f.calls.filter(call => call.path.startsWith('/cart/add-to-cart/')).length, 1);
  }
});

test('add timeout reads cart and can continue only when exact one target confirmed, never re-add', async () => {
  const f = clientFixture({ addTimeout: true }); const snapshot = await f.client.readOffer(asin);
  assert.equal((await f.client.checkout(snapshot, { beforeSubmit: validate })).status, 'ordered');
  assert.equal(f.calls.filter(c => c.path.startsWith('/cart/add-to-cart')).length, 1);
  assert.ok(f.steps.includes('api_cart_check'));
});

test('submit timeout reconciles official orders, no blind POST or browser fallback', async () => {
  const f = clientFixture({ submitTimeout: true }); const snapshot = await f.client.readOffer(asin);
  assert.equal((await f.client.checkout(snapshot, { beforeSubmit: validate })).snapshot.orderId, newId);
  assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
  assert.ok(f.steps.includes('api_order_check'));
});

test('missing or ambiguous official order stays unresolved; no resubmit or clear', async () => {
  for (const options of [{ submitTimeout: true, noNewOrder: true }, { duplicateMatches: true }]) {
    const f = clientFixture(options); const snapshot = await f.client.readOffer(asin);
    assert.equal((await f.client.checkout(snapshot, { beforeSubmit: validate })).status, 'submitted_unconfirmed');
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
    assert.equal(f.checkpoints.at(-1).phase, 'submitted');
    assert.equal(f.calls.some(c => /delete|clear|cancel/.test(c.path)), false);
  }
});

test('existing cart is preserved without adding; mutations blocked on every identity/quote failure', async () => {
  const full = clientFixture({ cartInitiallyFull: true });
  await assert.rejects(full.client.checkout(await full.client.readOffer(asin), { beforeSubmit: validate }), /購物車已有商品/);
  assert.equal(full.calls.some(c => c.method === 'POST'), false);
  for (const options of [{ cartPatch: { target: otherAsin } }, { cartPatch: { mixed: true } }, { cartPatch: { quantity: 2 } },
    { reviewPatch: { target: otherAsin } }, { reviewPatch: { mixed: true } }, { reviewPatch: { quantity: 2 } },
    { reviewPatch: { merchant: 'Third party' } }, { reviewPatch: { address: false } },
    { reviewPatch: { shipping: 501, total: 1381 } }, { reviewPatch: { total: 1400 } }]) {
    const f = clientFixture(options);
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 0);
  }
});

test('verification after add stops before more requests; HTTP429 respects Retry-After', async () => {
  const f = clientFixture({ addVerification: true });
  await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }), { code: 'AMAZON_VERIFICATION_REQUIRED' });
  assert.ok(f.calls.at(-1).path.startsWith('/cart/add-to-cart/'));
  const limited = new AmazonJpHttpClient({ request: { fetch: async () => ({ status: () => 429,
    headers: () => ({ 'retry-after': '180' }), text: async () => '', dispose: async () => {} }) } });
  await assert.rejects(limited.readOffer(asin), e => e.code === 'AMAZON_RATE_LIMITED' && e.retryAfterMs === 180000);
});

test('HTTP rejects external redirects, sign-in, 307 replay and redacts transport failure', async () => {
  for (const [status, location, expected] of [[302, 'https://evil.example/checkout', /跨網域/], [302, '/ap/signin', /官方登入表單/]]) {
    let calls = 0;
    const client = new AmazonJpHttpClient({ request: { fetch: async url => { calls++; const signin=url.includes('/ap/signin');return { status: () => signin?200:status,
      headers: () => ({ location }), text: async () => signin?'<input id="ap_email">':'', dispose: async () => {} }; } } });
    await assert.rejects(client.readOffer(asin), expected); assert.equal(calls, location==='/ap/signin'?2:1);
  }
  const replay = clientFixture({ submitStatus: 307 });
  // The POST is never replayed; GET order reconciliation can still prove success.
  assert.equal((await replay.client.checkout(await replay.client.readOffer(asin), { beforeSubmit: validate })).status, 'ordered');
  assert.equal(replay.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
  const failure = new AmazonJpHttpClient({ request: { fetch: async () => { throw new Error('cookie=SECRET'); } } });
  await assert.rejects(failure.readOffer(asin), e => !e.message.includes('SECRET'));
});

test('order history uses contextual official card IDs; unknown pages not an empty baseline', () => {
  assert.deepEqual(amazonOfficialOrderIds(page(historyHtml([oldId]))), [oldId]);
  assert.deepEqual(amazonOfficialOrderIds(page(historyHtml([]))), []);
  assert.throws(() => amazonOfficialOrderIds(page(`<p>Unknown session ${newId}</p>`)), /列表/);
  assert.throws(() => amazonOfficialOrderIds(page('<div class="order-card" data-csa-c-slot-id="bad.000-0000000-0000002"></div>')), /識別/);
  assert.throws(() => amazonOfficialOrderIds(page('<h1>Your Orders</h1><div id="ordersContainer"></div>')), /未完整/);
  const expected = { asin, totalYen: 1380, shippingYen: 500 };
  assert.equal(matchesAmazonOfficialDetail(page(detailHtml()), newId, expected), true);
  for (const patch of [{ target: otherAsin }, { quantity: 2 }, { total: 1381 }, { cancelled: true }]) {
    assert.equal(matchesAmazonOfficialDetail(page(detailHtml(patch)), newId, expected), false);
  }
});

test('form excludes unchecked preferences/other submits; refuses external origin', () => {
  const p = page(`<form method="post" action="/cart/add-to-cart/x">${input('setOrderingPrefs', '1', 'checkbox')}${input('buy', '1', 'submit')}${input('delete', '1', 'submit')}</form>`);
  const parsed = amazonHttpForm(p, p.$('form'), 'buy');
  assert.equal(parsed.fields.has('setOrderingPrefs'), false); assert.equal(parsed.fields.has('delete'), false);
  assert.throws(() => amazonHttpForm(page('<form action="https://evil.example"></form>'), load('<form action="https://evil.example"></form>')('form')), /網域/);
});

test('clicked submitter overrides form action/method; unclicked, disabled and external overrides cannot hijack submission', () => {
  const p = page(`<form method="get" action="/gp/product/handle-buy-box/old">
    <input name="ASIN" value="${asin}"><input type="submit" name="submit.add-to-cart" formaction="https://evil.test/steal">
    <input type="submit" name="submit.buy-now" formaction="/checkout/entry/buynow" formmethod="post" value="Buy now"></form>`, origin + '/dp/' + asin);
  const contract = amazonHttpForm(p, p.$('form'), 'submit.buy-now');
  assert.equal(contract.url, origin + '/checkout/entry/buynow');
  assert.equal(contract.method, 'POST');
  assert.equal(contract.fields.get('submit.buy-now'), 'Buy now');
  assert.equal(contract.fields.has('submit.add-to-cart'), false);
  for (const attrs of ['formaction="https://evil.test/steal"', 'formaction="//amazon.co.jp.evil.test/steal"',
    'formaction="https://user:secret@www.amazon.co.jp/checkout/entry/buynow"',
    'formmethod="delete"', 'formenctype="multipart/form-data"']) {
    const bad = page(`<form action="/checkout/entry/buynow" method="post"><button name="buy" ${attrs}>Buy</button></form>`);
    assert.throws(() => amazonHttpForm(bad, bad.$('form'), 'buy'));
  }
  const disabled = page('<form action="/safe" method="post"><input name="buy" type="submit" formaction="https://evil.test" disabled></form>');
  assert.equal(amazonHttpForm(disabled, disabled.$('form'), 'buy').url, origin + '/safe');
  const ambiguous = page('<form><button name="buy">A</button><button name="buy">B</button></form>');
  assert.throws(() => amazonHttpForm(ambiguous, ambiguous.$('form'), 'buy'), /不唯一/);
});

test('native form ownership and missing submit value match real Chrome, not all descendant controls', async () => {
  const html = '<form id="f" method="post" action="/checkout/entry/buynow"><input name="anti-csrftoken-a2z" value="A"><input name="anti-csrftoken-a2z" value="B" form="other"><input type="submit" id="buy" name="submit.buy-now"></form><form id="other"></form>';
  const p = page(html), parsed = amazonHttpForm(p, p.$('#f'), 'submit.buy-now');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const dom = await browser.newPage();
    await dom.setContent(html);
    const native = await dom.evaluate(() => [...new FormData(document.querySelector('#f'), document.querySelector('#buy')).entries()]
      // The browser-localized default submit label is UA-dependent. Only this
      // button's presence is contractual when HTML omits its value attribute.
      .map(([key, value]) => [key, key === 'submit.buy-now' ? '' : value]));
    assert.deepEqual([...parsed.fields], native);
  } finally { await browser.close(); }
});

test('live Tango hidden ASIN is read from its line-item description, never inferred from the title or unrelated page text', () => {
  const original = reviewHtml().replace(`<a href="/dp/${asin}">Item</a>`, '');
  const marker = `<div id="checkout-item-block-0"><div id="col-item-block-description"><span class="aok-hidden">${asin}</span></div></div>`;
  const parsed = parseAmazonHttpReview(page(original + marker), { priceYen: 880 });
  assert.equal(parsed.checkout.asin, asin);
  assert.equal(parsed.checkout.identitySource, 'line_item_metadata');
  assert.equal(validate(parsed.checkout).totalYen, 1380);
  for (const invalid of [`<span class="aok-hidden">${asin}</span>`, `<div id="col-item-block-description"><span class="aok-hidden">${asin}</span></div>`,
    `<script type="application/json">{"asin":"${asin}"}</script>`]) {
    assert.equal(parseAmazonHttpReview(page(original + invalid), { priceYen: 880 }).checkout.asin, '');
  }
  const wrong = parseAmazonHttpReview(page(original + marker.replace(asin, otherAsin)), { priceYen: 880 });
  assert.throws(() => validate(wrong.checkout), /商品與目標不符/);
});

test('direct checkout uses clicked official endpoint, never guesses a replacement or falls back after timeout', async () => {
  for (const buttonAction of ['/checkout/entry/buynow', null]) {
    const f = clientFixture({ directPatch: { buttonAction } }); f.client.directBuyNow = true;
    assert.equal((await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate })).status, 'ordered');
    const paths = f.calls.filter(c => c.method === 'POST').map(c => c.path);
    assert.equal(paths[0], buttonAction ?? '/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance');
    assert.equal(paths.length, 2);
  }
  const invalid = clientFixture({ directPatch: { buttonAction: '/cart/add-to-cart/unknown' } }); invalid.client.directBuyNow = true;
  await assert.rejects(invalid.client.checkout(await invalid.client.readOffer(asin), { beforeSubmit: validate }), e => e.code === 'AMAZON_DIRECT_BUY_CONTRACT');
  assert.equal(invalid.calls.some(c => c.method === 'POST'), false);
  const timed = clientFixture({ buyTimeout: true }); timed.client.directBuyNow = true;
  await assert.rejects(timed.client.checkout(await timed.client.readOffer(asin), { beforeSubmit: validate }));
  assert.deepEqual(timed.calls.filter(c => c.method === 'POST').map(c => c.path), ['/checkout/entry/buynow']);
});

test('direct product polling reuses only this rounds verified form; eliminates AOD and duplicate product GET without changing order guards', async () => {
  const f = clientFixture(); f.client.directBuyNow = true;
  const quote = await f.client.readDirectOffer(asin);
  assert.equal(quote.buyNowAvailable, true);
  assert.equal((await f.client.checkout(quote, { beforeSubmit: validate })).status, 'ordered');
  assert.equal(f.calls.filter(c => c.path.startsWith('/dp/')).length, 1);
  assert.equal(f.calls.some(c => /aodAjaxMain|cart\/view|order-history/.test(c.path)), false);
  assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/checkout/entry/buynow', '/checkout/p/fixture/spc/place-order']);
  for (const expired of [false, true]) {
    const fresh = clientFixture(); fresh.client.directBuyNow = true;
    const snapshot = await fresh.client.readDirectOffer(asin);
    if (expired) fresh.client.directProductAt = Date.now() - 5001;
    await fresh.client.checkout(expired ? snapshot : { ...snapshot }, { beforeSubmit: validate });
    assert.equal(fresh.calls.filter(c => c.path.startsWith('/dp/')).length, 2);
  }
});

test('direct product polling keeps availability quiet and requires fresh matching AOD only for ambiguous currency', async () => {
  const absent = clientFixture({ directPatch: { disabled: true } }); absent.client.directBuyNow = true;
  assert.equal((await absent.client.readDirectOffer(asin)).buyNowAvailable, false);
  assert.equal(absent.calls.length, 1);
  const twd = clientFixture({ directPatch: { currency: 'TWD', price: 180 } }); twd.client.directBuyNow = true;
  const quote = await twd.client.readDirectOffer(asin);
  assert.equal((await twd.client.checkout(quote, { beforeSubmit: validate })).status, 'ordered');
  assert.equal(twd.calls.filter(c => c.path.includes('aodAjaxMain')).length, 1);
  assert.equal(twd.calls.filter(c => c.path.startsWith('/dp/')).length, 1);
  for (const patch of [{ merchant: 'THIRD' }, { target: otherAsin }, { quantity: '2' }, { token: '' }, { currency: 'TWD', offer: 'different-offer' }]) {
    const invalid = clientFixture({ directPatch: patch });
    await assert.rejects(invalid.client.readDirectOffer(asin));
    assert.equal(invalid.calls.some(c => c.method === 'POST'), false);
  }
});

test('disappearing direct button keeps cadence; invalid contract cools down; lost Buy Now is NOT a final order and retries safely', async t => {
  const unavailable = monitorFixture(t, { directPatch: { disabled: true } }); unavailable.config.fastLane = true;
  assert.equal((await unavailable.monitor.scanOnce({ purchase: true, trigger: 'poll' })).status, 'waiting_poll');
  assert.equal(unavailable.calls.some(c => c.method === 'POST'), false);
  assert.equal(unavailable.monitor.hasPendingApiTransaction(), false);
  assert.equal(unavailable.monitor.storage().backoffUntil, undefined);
  assert.equal(unavailable.monitor.canSchedule(), true);
  assert.equal(unavailable.monitor.status().purchaseSteps.at(-1).action, '等待可購商品');
  const wrongPrice = monitorFixture(t, { directPatch: { target: otherAsin } }); wrongPrice.config.fastLane = true;
  await assert.rejects(wrongPrice.monitor.scanOnce({ purchase: true, trigger: 'poll' }), e => e.code === 'AMAZON_DIRECT_BUY_CONTRACT');
  assert.ok(Date.parse(wrongPrice.monitor.storage().backoffUntil) > Date.now());
  const lost = monitorFixture(t, { buyTimeout: true }); lost.config.fastLane = true;
  await assert.rejects(lost.monitor.scanOnce({ purchase: true, trigger: 'poll' }));
  assert.equal(lost.monitor.storage().status, 'waiting_poll');
  assert.equal(lost.monitor.hasPendingApiTransaction(), false);
  assert.equal(lost.monitor.canSchedule(), true);
  assert.equal(lost.monitor.storage().preSubmitRetry.attempts, 1);
  assert.equal(lost.calls.some(c => c.path.endsWith('/place-order')), false);
});

function monitorFixture(t, options = {}) {
  const f = fakeTransport(options);
  const config = { enabled: true, mode: 'hybrid', targetUrl: origin + '/dp/' + asin, targetSuccessCount: 1, maxShippingYen: 500 };
  const state = { data: { commerce: {} }, async save() {} };
  const history = { begin: async () => ({}), step: async () => {}, finish: async () => {}, notification: async () => {}, status: () => ({}) };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config, orderHistory: history,
    slot: options.slot || 'A', ...(options.slot ? { storageKey: `amazonJpProductOrder${options.slot}` } : {}) });
  monitor.contextFor = async () => ({ request: f.transport });
  monitor.resolveMsrp = () => ({ msrpYen: 880 });
  monitor.pageFor = async () => assert.fail('API task must not load/click a product page');
  t.after(() => monitor.close());
  return { ...f, monitor, state, config };
}

const checkoutShell = '<header id="nav-checkout-title"><h1>安全结账</h1></header><footer>Privacy notice</footer>';

test('checkout shell is distinguished from stock loss and an arbitrary missing form', () => {
  assert.throws(() => parseAmazonHttpReview(page(checkoutShell), { priceYen: 880 }), e => e.code === 'AMAZON_CHECKOUT_SHELL');
  assert.throws(() => parseAmazonHttpReview(page(checkoutShell + '<p>抱歉，无法再提供您所请求的数量。</p>'), {}), e => e.code === 'AMAZON_CHECKOUT_STOCK_CHANGED');
  for (const html of ['', '<h1>Unknown page</h1>', checkoutShell + '<div class="a-alert-content">Payment problem</div>',
    checkoutShell + '<input type="submit" name="continue">']) {
    assert.throws(() => parseAmazonHttpReview(page(html), {}), e => e.code !== 'AMAZON_CHECKOUT_SHELL');
  }
  const row = amazonThreeSteps([{ name: 'buy_now_click' }, { name: 'failure', error: '安全結帳只收到空白頁框' }]).at(-1);
  assert.equal(row.step, '02'); assert.match(row.action, /空白.*瀏覽器/);
});

test('shell arms a scoped temporary browser entry; no blind replay and no fallback for timeout/auth/unknown submit', async t => {
  const f = monitorFixture(t); f.config.fastLane = true;
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, options) => new URL(url).pathname === '/checkout/p/fixture/spc'
    ? { status: () => 200, headers: () => ({}), text: async () => checkoutShell, dispose: async () => {} } : fetch(url, options);
  await assert.rejects(f.monitor.scanOnce({ purchase: true, trigger: 'poll' }), e => e.code === 'AMAZON_CHECKOUT_SHELL');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.monitor.storage().apiTransaction, undefined);
  assert.equal(f.monitor.status().checkoutEntryRoute, 'browser_fallback');
  assert.equal(typeof (await f.monitor.httpClient()).browserDirectEntry, 'function');
  f.config.targetUrl = origin + '/dp/' + otherAsin;
  assert.equal(f.monitor.browserEntryFallbackActive(), false);
  f.config.targetUrl = origin + '/dp/' + asin;
  f.monitor.storage().checkoutEntryFallback.until = new Date(Date.now() - 1).toISOString();
  assert.equal(f.monitor.browserEntryFallbackActive(), false);
  for (const options of [{ buyTimeout: true }, { submitTimeout: true, noCompletionId: true }]) {
    const other = monitorFixture(t, options); other.config.fastLane = true;
    await other.monitor.scanOnce({ purchase: true, trigger: 'poll' }).catch(() => {});
    assert.equal(other.monitor.storage().checkoutEntryFallback, undefined);
  }
});

test('shell fallback uses a real native browser Buy Now, waits for rendered review, then existing single HTTP final submission', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext(), dom = await context.newPage(), native = [];
  const pageErrors = []; dom.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    native.push({ method: req.method(), path: url.pathname });
    if (url.pathname.startsWith('/dp/')) return route.fulfill({ contentType: 'text/html', body: directProductHtml() });
    if (url.pathname === '/checkout/entry/buynow') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: checkoutShell
      + `<template>${reviewHtml()}</template><script>setTimeout(()=>{const t=document.querySelector('template');t.replaceWith(t.content.cloneNode(true))},100)</script>` });
    return route.abort();
  });
  const f = monitorFixture(t); f.config.fastLane = true;
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, options) => new URL(url).pathname === '/checkout/p/fixture/spc'
    ? { status: () => 200, headers: () => ({}), text: async () => checkoutShell, dispose: async () => {} } : fetch(url, options);
  await assert.rejects(f.monitor.scanOnce({ purchase: true, trigger: 'poll' }), e => e.code === 'AMAZON_CHECKOUT_SHELL');
  clearTimeout(f.monitor.timer); f.monitor.timer = null; delete f.monitor.storage().backoffUntil;
  f.monitor.pageFor = async () => dom;
  const result = await f.monitor.scanOnce({ purchase: true, trigger: 'poll' }).catch(error => {
    error.message += ` | fixture page errors: ${JSON.stringify(pageErrors)} | native: ${JSON.stringify(native)}`;
    throw error;
  });
  assert.equal(result.status, 'ordered'); assert.equal(result.snapshot.orderId, newId);
  assert.equal(native.filter(c => c.method === 'POST').length, 1);
  assert.equal(native.find(c => c.method === 'POST').path, '/checkout/entry/buynow');
  assert.equal(f.calls.filter(c => c.path === '/checkout/entry/buynow').length, 1, 'the fallback must not repeat API Buy Now');
  assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
  assert.equal(f.monitor.storage().completedCount, 1);
  assert.equal(f.monitor.storage().apiTransaction.phase, 'confirmed');
  assert.ok(f.monitor.status().purchaseSteps.some(s => s.action === '啟用背景瀏覽器結帳入口'));
});

test('browser entry rechecks live form; rejects seller/price/quantity changes, auth, captcha and throttling without a Buy Now POST', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  for (const variant of [{ merchant: 'THIRD_PARTY' }, { price: 881 }, { quantity: '2' },
    { html: '<input id="ap_email">', code: 'AMAZON_LOGIN_REQUIRED' },
    { html: '<input id="captchacharacters">', code: 'AMAZON_VERIFICATION_REQUIRED' },
    { status: 429, code: 'AMAZON_RATE_LIMITED' }]) {
    const context = await browser.newContext(), dom = await context.newPage(); let posts = 0;
    await context.route('**/*', route => {
      if (route.request().method() === 'POST') posts++;
      return route.fulfill({ status: variant.status || 200, contentType: 'text/html', body: variant.html || directProductHtml(variant) });
    });
    await assert.rejects(openAmazonBrowserDirectEntry(dom, { asin, priceYen: 880 }), e => !variant.code || e.code === variant.code);
    assert.equal(posts, 0); await context.close();
  }
});

test('browser-prepared review retains final identity, shipping, points, durable intent and unknown-submit protections', async () => {
  for (const patch of [{ target: otherAsin }, { quantity: 2 }, { shipping: 501, total: 1381 },
    { merchant: 'Third party' }, { points: input('pointsToApply', '1') }]) {
    const f = clientFixture(); f.client.directBuyNow = true;
    f.client.browserDirectEntry = async () => ({ ...page(reviewHtml(patch)), status: 200 });
    await assert.rejects(f.client.checkout(await f.client.readDirectOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.some(c => c.method === 'POST'), false);
    assert.equal(f.client.submitted, false);
  }
  const f = clientFixture({ submitTimeout: true }); f.client.directBuyNow = true; let entries = 0;
  f.client.browserDirectEntry = async () => { entries++; return { ...page(reviewHtml()), status: 200 }; };
  const result = await f.client.checkout(await f.client.readDirectOffer(asin), { beforeSubmit: validate });
  assert.equal(result.status, 'submitted_unconfirmed'); assert.equal(entries, 1);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.checkpoints.at(-1).phase, 'submitted');
  await assert.rejects(f.client.checkout(await f.client.readDirectOffer(asin), { beforeSubmit: validate }));
  assert.equal(entries, 1);
});

test('production defaults to API; manual scan GET only, scheduled purchase full API', async t => {
  const f = monitorFixture(t);
  assert.equal(f.monitor.transport(), 'api');
  const inspected = await f.monitor.scanOnce();
  assert.equal(inspected.status, 'inspected_only'); assert.equal(f.calls.length, 1);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  const result = await f.monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(result.snapshot.orderId, newId); assert.equal(f.monitor.storage().completedCount, 1);
  assert.equal(f.monitor.storage().apiTransaction.accounted, true); assert.equal(f.monitor.timer, null);
  assert.equal(f.monitor.status().checkoutTransport, 'api');
  assert.equal(JSON.stringify(f.monitor.status()).includes('baselineOrderIds'), false);
});

test('production unknown POST stops both triggers; read-only reconciliation can recover once', async t => {
  const f = monitorFixture(t, { submitTimeout: true, noNewOrder: true });
  const result = await f.monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(result.status, 'submitted_unconfirmed'); assert.equal(f.monitor.storage().status, 'needs_review');
  assert.equal(f.monitor.timer, null); assert.equal(f.monitor.canSchedule(), false);
  await assert.rejects(f.monitor.resetProgress(), /未核對交易/);
  assert.equal((await f.monitor.scanOnce()).reason, 'order_needs_review');
  const recovered = fakeTransport();
  // Isolate recovery transport: history/detail GET only, no mutation possible.
  recovered.transport.fetch = async url => ({ status: () => 200, headers: () => ({}), dispose: async () => {},
    text: async () => new URL(url).pathname.includes('order-history') ? historyHtml([newId, oldId]) : detailHtml() });
  f.monitor.contextFor = async () => ({ request: recovered.transport });
  let recoveryRecord;
  f.monitor.orderHistory.begin = async data => { recoveryRecord=data;return{}; };
  assert.equal((await f.monitor.reconcileApiOrder()).status, 'ordered');
  assert.equal(recoveryRecord.compactSteps,true);
  assert.equal(recoveryRecord.steps.some(step=>step.name==='refresh_start'),false,'核對不混入上一輪的購買步驟');
  assert.equal(f.monitor.status().purchaseSteps.at(-1).step,'03');
  assert.equal(f.monitor.status().purchaseSteps.at(-1).status,'成功');
  assert.equal(f.monitor.storage().completedCount, 1);
  assert.equal((await f.monitor.reconcileApiOrder()).skipped, true);
  assert.equal(f.monitor.storage().completedCount, 1);
});

test('restart preserves API intent even if old status is ready, never clears it by reset', async t => {
  const f = monitorFixture(t);
  f.monitor.storage().status = 'ready';
  f.monitor.storage().apiTransaction = { phase: 'adding', asin, baselineOrderIds: [] };
  await f.monitor.start();
  assert.equal(f.monitor.storage().status, 'needs_review'); assert.equal(f.monitor.timer, null);
  await assert.rejects(f.monitor.resetProgress(), /未核對交易/);
  assert.equal((await f.monitor.reconcileApiOrder()).reason, 'cart_needs_manual_review');
  assert.equal(f.calls.length, 0);
});

test('cancellation after quote or durable add intent prevents POST', async t => {
  const f = monitorFixture(t);
  let saves = 0;
  f.state.save = async () => { saves++; if (f.monitor.storage().apiTransaction?.phase === 'adding') f.monitor.stop(); };
  await assert.rejects(f.monitor.scanOnce({ purchase: true, trigger: 'poll' }), /已停止/);
  assert.ok(saves > 0); assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('API stages save durable checkpoints without shared state debounce', async t => {
  const f = monitorFixture(t); let immediate = 0;
  f.state.writeSnapshot = async () => { immediate++; };
  await f.monitor.scanOnce();
  assert.ok(immediate >= 2);
});

test('manual cart recovery is read-only and cannot unlock a submitted transaction', async t => {
  const f = monitorFixture(t);
  f.monitor.storage().status = 'needs_review';
  f.monitor.storage().apiTransaction = { phase: 'adding', asin };
  assert.match((await f.monitor.confirmApiCartReviewed()).message, /確認空車/);
  assert.equal(f.monitor.storage().apiTransaction, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  f.monitor.stop(); f.monitor.storage().status = 'needs_review';
  f.monitor.storage().apiTransaction = { phase: 'submitted', asin };
  await assert.rejects(f.monitor.confirmApiCartReviewed(), /必須先查/);
  assert.equal(f.calls.length, 1);
});

test('Amazon elsewhere in HTML cannot qualify a third-party offer or review item', () => {
  const unrelated = `<div>販売元: Amazon.co.jp <a href="/seller?seller=${seller}">Amazon</a></div>`;
  assert.equal(parseAmazonAod(page(offerHtml({ sellerId: 'THIRD_PARTY' }) + unrelated), asin).snapshot.sellerConfirmed, false);
  const review = parseAmazonHttpReview(page(reviewHtml({ merchant: 'Third party' }) + unrelated), { priceYen: 880 });
  assert.equal(review.checkout.sellerConfirmed, false);
});

test('throttled order POST remains unknown and read-only reconciliation respects cooldown', async t => {
  const f = monitorFixture(t, { submitStatus: 429 });
  await assert.rejects(f.monitor.scanOnce({ purchase: true, trigger: 'poll' }), { code: 'AMAZON_RATE_LIMITED' });
  assert.equal(f.monitor.storage().status, 'needs_review');
  assert.ok(Date.parse(f.monitor.storage().backoffUntil) > Date.now());
  const before = f.calls.length;
  assert.equal((await f.monitor.reconcileApiOrder()).reason, 'cooling_down');
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
});

test('A fast preflight overlaps only the two reads; no add until both have completed', async () => {
  const f = clientFixture(); f.client.parallelPreflight = true;
  const snapshot = await f.client.readOffer(asin);
  const original = f.transport.fetch.bind(f.transport), gates = new Map();
  let initialCart = true, initialHistory = true;
  f.transport.fetch = (url, options) => {
    const path = new URL(url).pathname;
    if (initialCart && path.includes('/gp/cart/view.html')) {
      initialCart = false; return new Promise(resolve => gates.set('cart', () => resolve(original(url, options))));
    }
    if (initialHistory && path.includes('/order-history')) {
      initialHistory = false; return new Promise(resolve => gates.set('history', () => resolve(original(url, options))));
    }
    return original(url, options);
  };
  const result = f.client.checkout(snapshot, { beforeSubmit: validate });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...gates.keys()].sort(), ['cart', 'history']);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  gates.get('history')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  gates.get('cart')();
  assert.equal((await result).status, 'ordered');
  assert.equal(f.calls.filter(call => call.path.endsWith('/place-order')).length, 1);
  assert.ok(f.checkpoints.some(tx => tx.phase === 'submitted'));
  assert.ok(Number.isFinite(snapshot.diagnostic.quoteMs));
});

test('parallel preflight drains in-flight reads and prioritizes official cooldown, never posts on failure', async () => {
  const f = clientFixture(); f.client.parallelPreflight = true;
  const snapshot = await f.client.readOffer(asin);
  let release, finished = false;
  f.transport.fetch = async url => {
    if (new URL(url).pathname.includes('/order-history')) {
      await new Promise(resolve => { release = resolve; });
      return { status: () => 429, headers: () => ({ 'retry-after': '180' }), text: async () => '', dispose: async () => {} };
    }
    throw new Error('fixture transport failure');
  };
  const work = f.client.checkout(snapshot, { beforeSubmit: validate }).then(() => assert.fail('must fail'), error => {
    finished = true; assert.equal(error.code, 'AMAZON_RATE_LIMITED'); assert.equal(error.retryAfterMs, 180000);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); release(); await work;
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('fast preflight retains all cart, quote and uncertain-submit safeguards', async () => {
  for (const options of [{ cartInitiallyFull: true }, { cartPatch: { mixed: true } },
    { reviewPatch: { merchant: 'Third party' } }, { reviewPatch: { shipping: 501, total: 1381 } }]) {
    const f = clientFixture(options); f.client.parallelPreflight = true;
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.filter(call => call.path.endsWith('/place-order')).length, 0);
  }
  const unknown = clientFixture({ submitTimeout: true, noNewOrder: true }); unknown.client.parallelPreflight = true;
  assert.equal((await unknown.client.checkout(await unknown.client.readOffer(asin), { beforeSubmit: validate })).status, 'submitted_unconfirmed');
  assert.equal(unknown.calls.filter(call => call.path.endsWith('/place-order')).length, 1);
});

test('ABC API opts into direct buy now without preflight; browser and explicitly disabled fast lane retain legacy route', async t => {
  for (const slot of ['A', 'B', 'C']) {
    const f = monitorFixture(t); f.monitor.slot = slot; f.config.fastLane = true;
    const client = await f.monitor.httpClient();
    assert.equal(client.parallelPreflight, false);
    assert.equal(client.directBuyNow, true);
    assert.equal(client.fastCheckout, true);
    assert.equal(f.monitor.pollIntervalMs(), 1000);
    assert.equal(f.monitor.status().pollIntervalSeconds, 1);
    f.config.fastLane = false;
    assert.equal(f.monitor.fastLaneEnabled(), false); assert.equal(f.monitor.pollIntervalMs(), 5000);
    f.config.fastLane = true;
    f.config.checkoutTransport = 'browser';
    assert.equal(f.monitor.fastLaneEnabled(), false); assert.equal(f.monitor.pollIntervalMs(), 5000);
  }
});

test('BC use the same complete direct-product route, evidence and no-replay protection as A without sharing profiles or state', async t => {
  const slots = [];
  for (const slot of ['B', 'C']) {
    const f = monitorFixture(t, { slot }); f.config.fastLane = true;
    const captures = [];
    f.monitor.orderHistory.captureEvidence = (_record, kind, value) => captures.push({ kind, status: value.status });
    assert.equal((await f.monitor.scanOnce({ purchase: true, trigger: 'poll' })).status, 'ordered');
    assert.equal(f.monitor.status().checkoutRoute, 'direct_buy_now');
    assert.equal(f.monitor.status().pollIntervalSeconds, 1);
    assert.equal(f.calls.filter(call => call.path.startsWith('/dp/')).length, 1);
    assert.equal(f.calls.some(call => /aodAjaxMain|cart\/view|add-to-cart|order-history/.test(call.path)), false);
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.path), ['/checkout/entry/buynow', '/checkout/p/fixture/spc/place-order']);
    assert.deepEqual(captures.map(value => value.kind), ['entry', 'response']);
    slots.push(f.monitor);
    const unknown = monitorFixture(t, { slot, submitTimeout: true, noCompletionId: true }); unknown.config.fastLane = true;
    assert.equal((await unknown.monitor.scanOnce({ purchase: true, trigger: 'poll' })).status, 'submitted_unconfirmed');
    assert.equal(unknown.monitor.canSchedule(), false);
    assert.equal(unknown.monitor.storage().status, 'needs_review');
    assert.equal((await unknown.monitor.scanOnce({ purchase: true, trigger: 'poll' })).skipped, true);
    assert.equal(unknown.calls.filter(call => call.path.endsWith('/place-order')).length, 1);
    for (const patch of [{ shipping: 501, total: 1381 }, { target: otherAsin }, { points: input('pointsToApply', '1') }]) {
      const invalid = monitorFixture(t, { slot, reviewPatch: patch }); invalid.config.fastLane = true;
      await assert.rejects(invalid.monitor.scanOnce({ purchase: true, trigger: 'poll' }));
      assert.equal(invalid.calls.some(call => call.path.endsWith('/place-order')), false);
    }
  }
  assert.notEqual(slots[0].profileDirectory, slots[1].profileDirectory);
  assert.notEqual(slots[0].storageKey, slots[1].storageKey);
});

test('A production ignores the cart and enters direct checkout; ordinary polling adds no diagnostic state write', async t => {
  const f = monitorFixture(t, { cartInitiallyFull: true, initialCartPatch: { offering: 'fixture-offer' } });
  f.config.fastLane = true;
  const result = await f.monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(result.status, 'ordered');
  assert.equal(f.monitor.storage().apiTransaction.route, 'direct_buy_now');
  assert.equal(f.calls.filter(call => call.path.startsWith('/cart/add-to-cart/')).length, 0);
  assert.equal(f.calls.some(call => /cart\/view|order-history|checkout\/entry\/cart/.test(call.path)), false);
  assert.equal(f.monitor.status().purchaseSteps.at(-1).status, '成功');
  assert.ok(f.monitor.status().stepLog.every(row => ['01','02','03'].includes(row.step) && !row.name));
  const plain = monitorFixture(t);
  await plain.monitor.scanOnce();
  assert.equal(plain.monitor.status().stepLog.some(step => step.name === 'api_request_complete'), false);
  assert.ok(Number.isFinite(plain.monitor.storage().lastSnapshot.diagnostic.responseMs));
  assert.ok(Number.isFinite(plain.monitor.storage().lastSnapshot.diagnostic.offerParseMs));
});

test('signal rejection records actual classification, stays bounded and cannot submit', async t => {
  const f = monitorFixture(t, { offerPatch: { token: '' } });
  const messages = [];
  f.monitor.notifyPrivate = async message => { messages.push(message); };
  f.monitor.signalChecks = Array.from({ length: 40 }, () => ({ at: 'old' }));
  await f.monitor.scanOnce({ purchase: true, trigger: 'scan_signal', signal: { asin, matchedAt: Date.now() } });
  assert.equal(f.monitor.signalChecks.length, 40);
  assert.equal(f.monitor.signalChecks.at(-1).diagnostic.decision, 'retail_contract_incomplete');
  assert.match(messages[0], /不能判定售罄/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  assert.equal(/fixture-token|fixture-offer/.test(JSON.stringify(f.monitor.signalChecks)), false);
});

test('A fast purchase persists ordering immediately without the generic debounce, still submits only once', async t => {
  const f = monitorFixture(t); f.config.fastLane = true;
  let orderingCheckpoint = false;
  f.state.writeSnapshot = async () => {
    if (f.monitor.storage().status === 'ordering' && !f.monitor.storage().apiTransaction) orderingCheckpoint = true;
  };
  f.state.save = async () => {
    assert.equal(f.monitor.storage().status === 'ordering' && !f.monitor.storage().apiTransaction, false,
      'fast lane must not wait for debounced save before starting preflight');
  };
  const result = await f.monitor.scanOnce({ purchase: true, trigger: 'poll' });
  assert.equal(orderingCheckpoint, true); assert.equal(result.status, 'ordered');
  assert.equal(f.calls.filter(call => call.path.endsWith('/place-order')).length, 1);
  assert.equal(f.monitor.status().stepLog.some(step => step.name === 'api_preflight_ready'), false);
  assert.equal(f.calls.some(call => /cart\/view|order-history|checkout\/entry\/cart/.test(call.path)), false);
});

test('direct buy follows only product -> buy-now -> review -> order, never cart or pre-purchase history', async () => {
  const f = clientFixture({ cartInitiallyFull: true }); f.client.directBuyNow = true;
  const snapshot = await f.client.readOffer(asin);
  assert.equal((await f.client.checkout(snapshot, { beforeSubmit: validate })).status, 'ordered');
  assert.deepEqual(f.calls.slice(1).map(c => [c.method, c.path]), [
    ['GET', `/dp/${asin}`], ['POST', '/checkout/entry/buynow'],
    ['GET', '/checkout/p/fixture/spc'], ['POST', '/checkout/p/fixture/spc/place-order'],
    ['GET', '/gp/buy/thankyou/handlers/display.html']
  ]);
  const buy = f.calls.find(c => c.path === '/checkout/entry/buynow');
  assert.equal(buy.fields.has('submit.buy-now'), true);
  assert.equal(buy.fields.has('submit.add-to-cart'), false);
  await assert.rejects(f.client.checkout(snapshot, { beforeSubmit: validate }));
  assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
});

test('direct product rejects wrong seller, ASIN, quantity, quote, currency, disabled button and missing token without any POST', async () => {
  for (const directPatch of [{ merchant: 'THIRD' }, { target: otherAsin }, { quantity: '2' }, { quantity: '' }, { price: 881 },
    { currency: 'TWD', offer: 'different-offer' }, { disabled: true }, { token: '' }]) {
    const f = clientFixture({ directPatch }); f.client.directBuyNow = true;
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.some(c => c.method === 'POST'), false);
    assert.equal(f.checkpoints.length, 0);
  }
});

test('TWD product display can only reuse the exact fresh AOD JPY offering; final order still submits JPY', async () => {
  const f = clientFixture({ directPatch: { currency: 'TWD', price: 180 } }); f.client.directBuyNow = true;
  assert.equal((await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate })).status, 'ordered');
  const order = f.calls.find(c => c.path.endsWith('/place-order'));
  assert.equal(order.fields.get('currentCurrencyOption'), 'MARKETPLACE');
  assert.match(order.fields.get('placeYourOrder1'), /JPY/);
});

test('live direct checkout delivery block is recognized from actual address content, not heading alone', async () => {
  const f = clientFixture({ reviewPatch: { address: 'live' } }); f.client.directBuyNow = true;
  assert.equal((await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate })).status, 'ordered');
  const headingOnly = reviewHtml({ address: false }).replace('<p>商品:', '<h2 id="deliver-to-customer-text">正在发送至</h2><p>商品:');
  assert.equal(parseAmazonHttpReview(page(headingOnly), { priceYen: 880 }).checkout.deliveryConfirmed, false);
});

test('direct checkout keeps final ASIN, seller, price, mixed-cart, quantity, shipping, points and address guards', async () => {
  for (const reviewPatch of [{ target: otherAsin }, { merchant: 'Third party' }, { mixed: true }, { quantity: 2 },
    { total: 1500 }, { shipping: 600, total: 1480 }, { points: input('pointsToApply', '1') }, { address: false },
    { currency: false }, { csrf: false }]) {
    const f = clientFixture({ reviewPatch }); f.client.directBuyNow = true;
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 0);
    assert.equal(f.calls.filter(c => c.path === '/checkout/entry/buynow').length, 1);
    assert.equal(f.calls.some(c => /cart\/view|order-history/.test(c.path)), false);
  }
});

test('direct buy response timeout stops before final submission; order timeout never repeats or fabricates a number', async () => {
  const beforeOrder = clientFixture({ buyTimeout: true }); beforeOrder.client.directBuyNow = true;
  await assert.rejects(beforeOrder.client.checkout(await beforeOrder.client.readOffer(asin), { beforeSubmit: validate }));
  assert.equal(beforeOrder.checkpoints.at(-1).phase, 'buy_now');
  assert.equal(beforeOrder.calls.filter(c => c.path.endsWith('/place-order')).length, 0);
  for (const options of [{ submitTimeout: true }, { noCompletionId: true }]) {
    const f = clientFixture(options); f.client.directBuyNow = true;
    const result = await f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate });
    assert.equal(result.status, 'submitted_unconfirmed'); assert.equal(result.snapshot.orderId, '');
    assert.equal(f.checkpoints.at(-1).phase, 'submitted');
    assert.equal((await f.client.confirmOrder(f.checkpoints.at(-1))).status, 'submitted_unconfirmed');
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
    assert.equal(f.calls.some(c => /cart\/view|order-history/.test(c.path)), false);
  }
});

test('completion accepts only unique official labelled/order-detail IDs, never purchaseId or ambiguous IDs', () => {
  const url = `${origin}/gp/buy/thankyou/handlers/display.html?purchaseId=${oldId}`;
  assert.equal(amazonOrderIdFromCompletion(page('<p>订单已提交</p>', url)), '');
  assert.equal(amazonOrderIdFromCompletion(page(`<p>订单已提交</p><p>订单编号 ${newId}</p>`, url)), newId);
  assert.equal(amazonOrderIdFromCompletion(page(`<p>订单已提交</p><a href="https://evil.test/order-details?orderID=${newId}">Details</a>`, url)), '');
  assert.equal(amazonOrderIdFromCompletion(page(`<p>订单已提交</p><a href="/your-orders/order-details?orderID=${newId}"></a><a href="/your-orders/order-details?orderID=${oldId}"></a>`, url)), '');
});

test('direct checkout can stop at each durable intent and immediately before either POST', async () => {
  for (const stopAt of ['buy_now', 'submitted', 'buy_now_click', 'submit_order']) {
    const f = clientFixture(); f.client.directBuyNow = true; let enabled = true;
    f.client.canContinue = () => enabled;
    f.client.checkpoint = async tx => { if (tx?.phase === stopAt) enabled = false; };
    f.client.recordStep = async name => { if (name === stopAt) enabled = false; };
    await assert.rejects(f.client.checkout(await f.client.readOffer(asin), { beforeSubmit: validate }));
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 0);
    if (['buy_now', 'buy_now_click'].includes(stopAt)) assert.equal(f.calls.some(c => c.method === 'POST'), false);
  }
});

test('A prepares baseline in idle before the first quote; history after submission obtains ID when completion omits it', async t => {
  const f = monitorFixture(t, { noCompletionId: true }); f.config.fastLane = true;
  await f.monitor.runScheduledScan();
  assert.equal(f.calls[0].path.includes('order-history'), true);
  const quoteIndex = f.calls.findIndex(c => c.path.includes('aodAjaxMain'));
  const submitIndex = f.calls.findIndex(c => c.path.endsWith('/place-order'));
  assert.equal(f.calls.slice(quoteIndex, submitIndex).some(c => /order-history|cart\/view/.test(c.path)), false);
  assert.equal(f.monitor.storage().completedCount, 1);
  assert.equal(f.monitor.status().purchaseSteps.at(-1).status, '成功');
});

test('hot stock signal never waits for idle preparation; stale or other-target baseline is not used to identify orders', async t => {
  const f = monitorFixture(t); f.config.fastLane = true;
  f.monitor.pendingSignal = { asin, matchedAt: Date.now() };
  await f.monitor.runScheduledScan();
  assert.equal(f.calls[0].path, `/dp/${asin}`);
  for (const baseline of [{ asin, at: new Date(Date.now() - 31_000).toISOString(), ids: [oldId] },
    { asin: otherAsin, at: new Date().toISOString(), ids: [oldId] }]) {
    const direct = clientFixture({ noCompletionId: true }); direct.client.directBuyNow = true;
    direct.client.idleOrderBaseline = baseline;
    assert.equal((await direct.client.checkout(await direct.client.readOffer(asin), { beforeSubmit: validate })).status, 'submitted_unconfirmed');
    assert.equal(direct.calls.some(c => c.path.includes('order-history')), false);
  }
});

test('three-category stream appends actual events, never invents rows or successful order proof', () => {
  const base = [{ name: 'buy_now_click' }, { name: 'checkout_verified' }, { name: 'submit_order' }];
  assert.deepEqual(amazonThreeSteps([...base, { name: 'submit_result', status: 'ordered', orderId: newId }]).map(r => r.status), ['成功', '成功', '執行中', '成功']);
  assert.equal(amazonThreeSteps(base).length, 3);
  assert.equal(amazonThreeSteps(base)[2].action, '送出訂單');
  assert.deepEqual(amazonThreeSteps([]), []);
  assert.equal(amazonThreeSteps([{ name: 'buy_now_click' }, { name: 'failure', error: '缺貨' }])[1].status, '失敗');
  assert.notEqual(amazonThreeSteps([{ name: 'api_add_cart' }])[0].status, '成功');
  assert.notEqual(amazonThreeSteps([...base, { name: 'submit_result', status: 'ordered' }]).at(-1).status, '成功');
  const rounds=[{name:'refresh_start'},...base,{name:'submit_result',status:'ordered',orderId:newId},{name:'refresh_start'},{name:'failure',error:'登入失效'}];
  const stream=amazonThreeSteps(rounds);
  assert.equal(stream.length, 7); assert.equal(stream.at(-1).step,'01');
  assert.equal(stream.at(-1).status,'失敗');
  assert.deepEqual(amazonThreeSteps(stream),stream);
  assert.equal(amazonThreeSteps([{name:'api_request_complete'},{name:'api_preflight_ready'}]).length,0);
});

test('official detail without quantity label needs matching subtotal AND self-retail unit price, never absence alone', () => {
  const expected = { asin, priceYen: 880, shippingYen: 500, totalYen: 1380 };
  const html = detailHtml().replace('数量: 1', '');
  const evidence = '<p>商品小计： JPY 880</p><p>卖家：Amazon.co.jp JP¥880</p>';
  assert.equal(matchesAmazonOfficialDetail(page(html), newId, expected), false);
  assert.equal(matchesAmazonOfficialDetail(page(html + evidence), newId, expected), true);
  assert.equal(matchesAmazonOfficialDetail(page(html + evidence.replace('小计： JPY 880', '小计： JPY 1760')), newId, expected), false);
  assert.equal(matchesAmazonOfficialDetail(page(html + evidence.replace('JP¥880', 'JP¥440')), newId, expected), false);
  assert.equal(matchesAmazonOfficialDetail(page(html + '<p>商品小计： JPY 880</p>'), newId, expected), false);
});

function idleCartFixture({ lostResponse = false, unchanged = false, malformed = false } = {}) {
  let items = ['fixture-one', 'fixture-two']; const calls = [];
  const html = () => `<span id="nav-cart-count">${items.length}</span><div id="sc-active-cart"><form id="activeCartViewForm" method="post" action="/cart/ref=ord_cart_shr">
    ${input('anti-csrftoken-a2z', 'fixture-idle-token')}${items.length ? items.map(id => `<div data-asin="${asin}" data-quantity="1" data-itemid="${id}">
    ${input(`submit.delete-active.${malformed ? 'WRONG' : id}`, 'Delete', 'submit')}${input(`submit.save-for-later.${id}`, 'Save', 'submit')}</div>`).join('') : '<p>购物车为空</p>'}</form></div>
    <div id="sc-saved-cart"><input type="submit" name="submit.delete-saved.fixture-saved"></div>`;
  const client = new AmazonJpHttpClient({ request: { async fetch(url, options) {
    const fields = new URLSearchParams(options.data); calls.push({ method: options.method, path: new URL(url).pathname, fields });
    if (options.method === 'POST') {
      const target = [...fields.keys()].find(k => k.startsWith('submit.delete-active.'))?.slice('submit.delete-active.'.length);
      if (!unchanged) items = items.filter(id => id !== target);
      if (lostResponse) throw new Error('response lost');
    }
    return { status: () => 200, headers: () => ({}), text: async () => html(), dispose: async () => {} };
  } } });
  return { client, calls, remaining: () => items.length };
}

test('idle cleanup removes only active items using fresh official delete forms, never saved items, add or checkout', async () => {
  const f = idleCartFixture();
  assert.deepEqual(await f.client.clearIdleCart(), { removed: 2, empty: true });
  assert.equal(f.remaining(), 0);
  const posts = f.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2);
  for (const c of posts) {
    assert.equal([...c.fields.keys()].filter(k => k.startsWith('submit.')).length, 1);
    assert.equal([...c.fields.keys()].some(k => /delete-saved|save-for-later|move-to-cart/.test(k)), false);
  }
  assert.equal(f.calls.some(c => /checkout|add-to-cart|order-history/.test(c.path)), false);
});
test('idle delete timeout reads once, does not replay an unconfirmed deletion; malformed contract never deletes', async () => {
  const accepted = idleCartFixture({ lostResponse: true });
  assert.equal((await accepted.client.clearIdleCart()).removed, 2);
  const unknown = idleCartFixture({ lostResponse: true, unchanged: true });
  await assert.rejects(unknown.client.clearIdleCart(), /不重送/);
  assert.equal(unknown.calls.filter(c => c.method === 'POST').length, 1);
  const malformed = idleCartFixture({ malformed: true }); await assert.rejects(malformed.client.clearIdleCart());
  assert.equal(malformed.calls.some(c => c.method === 'POST'), false);
  const stopped = idleCartFixture(); stopped.client.canContinue = () => false;
  await assert.rejects(stopped.client.clearIdleCart()); assert.equal(stopped.calls.length, 0);
});

test('A cleanup runs once after 500 unavailable checks, never during qualifying offer, pending intent or only-read scan', async t => {
  const f = monitorFixture(t, { directPatch: { disabled: true } }); f.config.fastLane = true;
  f.monitor.maintenancePollCount = 499;
  f.monitor.refreshCount = 9000; f.monitor.clearDiagnostics();
  assert.equal(f.monitor.maintenancePollCount,499,'清 LOG 不延後第 500 次的待機保養');
  f.monitor.directIdleOrderBaseline = { asin, at: new Date().toISOString(), ids: [oldId] };
  const originalClient = f.monitor.httpClient.bind(f.monitor); let cleaned = 0;
  f.monitor.httpClient = async () => {
    const client = await originalClient(); client.clearIdleCart = async () => { cleaned++; return { removed: 1, empty: true }; }; return client;
  };
  await f.monitor.scanOnce({ purchase: true, trigger: 'poll' }); assert.equal(cleaned, 1);
  await f.monitor.scanOnce({ purchase: true, trigger: 'poll' }); assert.equal(cleaned, 1);
  f.monitor.maintenancePollCount = 999;
  await f.monitor.scanOnce(); assert.equal(cleaned, 1);
  f.monitor.storage().apiTransaction = { phase: 'submitted' };
  await f.monitor.runScheduledScan(); assert.equal(cleaned, 1);
  const hot = monitorFixture(t); hot.config.fastLane = true; hot.monitor.maintenancePollCount = 499;
  const hotClient = hot.monitor.httpClient.bind(hot.monitor);
  hot.monitor.httpClient = async () => { const client = await hotClient(); client.clearIdleCart = async () => assert.fail('must not clean on qualified offer'); return client; };
  assert.equal((await hot.monitor.scanOnce({ purchase: true, trigger: 'poll' })).status, 'ordered');
});
