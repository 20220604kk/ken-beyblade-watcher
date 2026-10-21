import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { AmazonJpHttpClient, amazonHttpForm, parseAmazonDirectBuyForm } from '../src/amazon-jp-http.js';
import { amazonCheckoutRenderUrl, amazonPrimeDecline, amazonSmartWagonEntry, amazonProductPrice, amazonItemSelection } from '../src/amazon-checkout-flow.js';
import { canRecoverAmazonDirectIntent } from '../src/amazon-pre-submit-retry.js';
import { product, review, completion, asin, origin } from './fixtures/amazon-race-fixtures.js';
import { retailAod } from './fixtures/amazon-aod-fixtures.js';

const doc = (html, url = origin + '/checkout/entry/buynow') => ({ html, $: load(html), url });
const response = (html, status = 200, headers = {}) => ({ status: () => status, text: async () => html, headers: () => headers, dispose: async () => {} });
const entry = '<a href="/checkout/entry/cart?cartItemCount=1">Checkout</a>';
const wagon = () => `<span id="nav-cart-count">1</span><div id="sw-atc-confirmation">カートに追加されました</div><div id="sw-atc-details-single-container"><a href="/dp/${asin}">Item</a></div>${entry}`;
const stock = `<div data-asin="${asin}">数量: 0 リクエストされた数量は入手できなくなりました</div><form action="/checkout/p/fixture/spc/place-order"></form>`;
function clientFixture({ main = product({ available: false }), add = wagon(), failAdd = false, failFinal = false, cart = '', checkout = review(), refresh = [review()] } = {}) {
  const calls = [], waits = [], state = {}, steps = []; let grantCount = 0, active = 0, maxActive = 0;
  const client = new AmazonJpHttpClient({ directBuyNow: true, retailFallbackEnabled: true, stockWaitEnabled: true, stockWaitIntervalMs: 250,
    checkpoint: async tx => { state.tx = tx; }, onStockWait: async value => { state.stockWait = value; }, waitFor: async ms => { waits.push(ms); },
    authorizeFinalSubmit: async () => { grantCount++; }, recordStep: async (name, detail) => steps.push({ name, ...detail }),
    request: { async fetch(url, options) {
      const path = new URL(url).pathname; calls.push({ path, method: options.method, fields: new URLSearchParams(options.data) });
      active++; maxActive = Math.max(maxActive, active);
      try {
        if (path.startsWith('/dp/')) return response(main);
        if (path.includes('aodAjaxMain')) return response(retailAod({ asin, price: 880 }));
        if (path.startsWith('/cart/add-to-cart/')) { if (failAdd) throw Error('lost'); return response(add); }
        if (path.includes('/gp/cart/view')) return response(cart);
        if (path === '/checkout/entry/cart' || path === '/checkout/entry/buynow' && options.method === 'POST') return response(checkout);
        if (path === '/checkout/p/fixture/spc') { const value = refresh.shift(); assert.ok(value, 'extra GET'); return typeof value === 'string' ? response(value) : value; }
        if (path === '/gp/prime/handler') return response('', 302, { location: '/checkout/p/fixture/spc' });
        if (path.endsWith('/place-order')) { if (failFinal) throw Error('lost'); return response('', 302, { location: '/gp/buy/thankyou/handlers/display.html' }); }
        if (path.includes('/thankyou/')) return response(completion());
        assert.fail('Unexpected path: ' + path);
      } finally { active--; }
    } }
  });
  const run = async () => client.checkout(await client.readRetailOffer(asin), { beforeSubmit: async c => {
    assert.deepEqual([c.asin, c.quantity, c.sellerConfirmed, c.itemCount, c.totalYen, c.shippingYen], [asin, 1, true, 1, 1380, 500]);
  } });
  return { client, calls, waits, state, steps, run, grants: () => grantCount, maxActive: () => maxActive };
}

for (const name of ['submit.pre-order', 'submit.preorder']) test(`preorder ${name} submits actual button override and reaches final once`, async () => {
  const main = product().replaceAll('buy-now-button', 'pre-order-button').replaceAll('submit.buy-now', name);
  assert.equal(parseAmazonDirectBuyForm(doc(main, origin + '/dp/' + asin), { asin, priceYen: 880 }).submitName, name);
  const f = clientFixture({ main }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.find(c => c.path === '/checkout/entry/buynow').fields.has(name), true);
  assert.equal(f.calls.some(c => c.path.includes('aodAjaxMain')), false);
  assert.equal(f.grants(), 1);
});

test('APEX price excludes struck price and ambiguous current quotes fail closed', () => {
  const html = '<div id="apex_desktop"><span class="a-price a-text-price"><span class="a-offscreen">￥9999</span></span><span class="apex-pricetopay-accessibility-label">￥880</span></div>';
  const parse = s => Number(s.replace(/[^\d]/g, '')) || null;
  assert.equal(amazonProductPrice(load(html), parse), 880);
  assert.equal(amazonProductPrice(load(html.replace('</div>', '<span class="apex-pricetopay-value">￥900</span></div>')), parse), null);
});

test('AOD fallback Smart Wagon avoids cart/history preflight, shares final grant and confirms own order', async () => {
  const f = clientFixture(); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.length, 6); // DP, AOD, add, entry, final, own thank-you
  assert.equal(f.calls.some(c => /cart\/view|order-history/.test(c.path)), false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
  assert.equal(f.grants(), 1); assert.equal(f.state.tx.route, 'aod_fast'); assert.equal(f.state.tx.phase, 'confirmed');
});

test('non-retail main Buy Box falls back to fresh new retail AOD without clicking third-party form', async () => {
  const f = clientFixture({ main: product({ seller: 'THIRD' }) }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.some(c => c.path === '/checkout/entry/buynow'), false);
  assert.equal(f.calls.filter(c => c.path.startsWith('/cart/add-to-cart/')).length, 1);
});

test('AOD fast path refuses copied/expired quote and makes no mutation', async () => {
  for (const expired of [true, false]) {
    const f = clientFixture(), quote = await f.client.readRetailOffer(asin);
    if (expired) f.client.offerAt = Date.now() - 5001;
    await assert.rejects(f.client.checkout(expired ? quote : { ...quote }, { beforeSubmit: async () => {} }), { code: 'AMAZON_CART_REVIEW' });
    assert.equal(f.calls.some(c => c.method === 'POST'), false);
  }
});

test('AOD add explicitly sets quantity one; duplicate ASIN and additional items cannot be added', async () => {
  const f = clientFixture(), quote = await f.client.readRetailOffer(asin);
  f.client.offer.contract.fields.set('items[0.base][quantity]', '');
  await f.client.checkout(quote, { beforeSubmit: async () => {} });
  assert.equal(f.calls.find(c => c.path.startsWith('/cart/add-to-cart/')).fields.get('items[0.base][quantity]'), '1');
  for (const [key, value] of [['items[0.base][asin]', 'B0TEST0002'], ['items[1.base][asin]', 'B0TEST0002']]) {
    const g = clientFixture(), snapshot = await g.client.readRetailOffer(asin);
    g.client.offer.contract.fields.append(key, value);
    await assert.rejects(g.client.checkout(snapshot, { beforeSubmit: async () => {} }), { code: 'AMAZON_CART_REVIEW' });
    assert.equal(g.calls.some(c => c.method === 'POST'), false);
  }
});

test('already rendered checkout after AOD add skips full cart and entry', async () => {
  const f = clientFixture({ add: review() }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.some(c => /cart\/view|entry\/cart/.test(c.path)), false);
});

for (const html of [wagon().replace('>1</span>', '>2</span>'), wagon().replace(asin, 'B0TEST0002'), wagon() + '<a href="/checkout/entry/cart?cartItemCount=1&ref=other">Other</a>']) {
  test('unproven or ambiguous Smart Wagon cannot skip cart verification', async () => {
    assert.equal(amazonSmartWagonEntry(doc(html, origin + '/cart/add-to-cart/ref=synthetic'), asin, amazonHttpForm), null);
    const f = clientFixture({ add: html, cart: '<span id="nav-cart-count">2</span>' }); await assert.rejects(f.run(), { code: 'AMAZON_CART_REVIEW' });
    assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 0); assert.equal(f.state.tx.phase, 'adding');
  });
}

test('ordinary cart fallback binds exact offering and seller before checkout', async () => {
  const cart = `<span id="nav-cart-count">1</span><div id="sc-active-cart"><div data-asin="${asin}" data-quantity="1" data-encoded-offering="synthetic-offer">販売元: Amazon.co.jp</div></div>${entry}`;
  const f = clientFixture({ add: '<p>Added</p>', cart }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.filter(c => /cart\/view/.test(c.path)).length, 1);
  const bad = clientFixture({ add: '<p>Added</p>', cart: cart.replace('data-encoded-offering="synthetic-offer"', 'data-encoded-offering="other"') });
  await assert.rejects(bad.run(), { code: 'AMAZON_CART_REVIEW' }); assert.equal(bad.grants(), 0);
});

test('unknown add is locked, unknown final is query-only and cannot replay', async () => {
  const add = clientFixture({ failAdd: true }); await assert.rejects(add.run());
  assert.equal(add.state.tx.phase, 'adding'); assert.equal(add.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(canRecoverAmazonDirectIntent({ transaction: add.state.tx, asin, fastLane: true }), false);
  const final = clientFixture({ failFinal: true }); assert.equal((await final.run()).status, 'submitted_unconfirmed');
  await assert.rejects(final.client.checkout(await final.client.readOffer(asin), { beforeSubmit: async () => {} }));
  assert.equal(final.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
  assert.equal(final.state.tx.phase, 'submitted');
});

for (const [label, html] of [
  ['Japanese', '<h1>プライム</h1><a href="/gp/prime/handler?action=decline">いいえ、結構です</a>'],
  ['English', '<h1>Prime</h1><a href="/gp/prime/handler?action=decline">No thanks</a>'],
  ['Chinese', '<h1>Prime 會員</h1><form method="post" action="/gp/prime/handler"><input name="action" value="decline"><input name="anti-csrftoken-a2z" value="synthetic"><button name="decline">不，謝謝</button></form>']
]) test(`${label} explicit Prime refusal continues without enrollment`, async () => {
  assert.ok(amazonPrimeDecline(doc(html), amazonHttpForm));
  const f = clientFixture({ main: product(), checkout: html }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.filter(c => c.path === '/gp/prime/handler').length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/place-order')).length, 1);
});

for (const html of [
  '<h1>Prime</h1><a href="/gp/prime/handler?action=accept">No thanks</a>',
  '<h1>Prime</h1><a href="https://evil.example/gp/prime/handler?action=decline">No thanks</a>',
  '<h1>Prime</h1><form method="post" action="/gp/prime/handler"><input name="action" value="decline"><button name="decline">No thanks</button></form>',
  '<h1>Prime</h1><a href="/checkout/p/fixture/spc?startTrial=1">No thanks</a>'
]) test('Prime refusal rejects enrollment, external host, absent CSRF and dangerous GET', () => {
  assert.equal(amazonPrimeDecline(doc(html), amazonHttpForm), null);
});

test('Prime continuation sign-in remains checkout scope, never an unrelated product login failure', async () => {
  const client = new AmazonJpHttpClient({ request: { fetch: async url => url.includes('/ap/signin')
    ? response('<form name="signIn"><input id="ap_email"></form>')
    : response('', 302, { location: '/ap/signin' }) } });
  await assert.rejects(client.request('/gp/prime/handler?action=decline'), e => e.code === 'AMAZON_CHECKOUT_AUTH_REQUIRED' && e.requestScope === 'checkout');
});

test('persisted AOD red flow resumes GET without product/AOD/add replay', async () => {
  const f = clientFixture();
  f.client.stockWait = { asin, url: origin + '/checkout/p/fixture/spc', snapshot: { asin, priceYen: 880 },
    tx: { asin, route: 'aod_fast', phase: 'buy_now', priceYen: 880, quantity: 1, startedAt: 'fixture' } };
  const result = await f.client.checkout(f.client.stockWait.snapshot, { beforeSubmit: async () => {} });
  assert.equal(result.status, 'ordered');
  assert.equal(f.calls[0].method, 'GET'); assert.equal(f.calls[0].path, '/checkout/p/fixture/spc');
  assert.equal(f.calls.some(c => /\/dp\/|aodAjaxMain|add-to-cart|entry\/cart/.test(c.path)), false);
  assert.equal(f.state.tx.route, 'aod_fast');
});

test('returned canonical URLs use structured evidence only, ambiguity and final endpoint are rejected', () => {
  assert.equal(amazonCheckoutRenderUrl(doc('<script type="application/json">{"redirectUrl":"/checkout/p/fixture/spc"}</script>')), origin + '/checkout/p/fixture/spc');
  assert.equal(amazonCheckoutRenderUrl(doc('{"checkoutUrl":"/checkout/p/fixture/spc"}')), origin + '/checkout/p/fixture/spc');
  assert.equal(amazonCheckoutRenderUrl(doc('<form action="/checkout/p/fixture/spc/place-order"></form>')), origin + '/checkout/p/fixture/spc');
  for (const html of ['<script>location="/checkout/p/fixture/spc"</script>', '<a href="/checkout/p/fixture/spc/place-order">Go</a>', '<a href="/checkout/p/fixture/spc">A</a><a href="/checkout/p/other/spc">B</a>']) assert.equal(amazonCheckoutRenderUrl(doc(html)), null);
});

test('thin SPC form shell reads its own canonical checkout, while complete review incurs no additional GET', async () => {
  for (const checkout of ['<form id="spc-form" action="/checkout/p/fixture/spc/place-order"></form>', '{"checkoutUrl":"/checkout/p/fixture/spc"}']) {
    const f = clientFixture({ main: product(), checkout });
    assert.equal((await f.run()).status, 'ordered');
    assert.equal(f.calls.filter(c => c.path === '/checkout/p/fixture/spc').length, 1);
  }
  const complete = clientFixture({ main: product() }); await complete.run();
  assert.equal(complete.calls.filter(c => c.path === '/checkout/p/fixture/spc').length, 0);
});

const selection = (quantity = 1) => `<section id="item-block-1"><a href="/dp/${asin}">Item</a><span data-a-selector="inner-value">${quantity}</span><p>販売元: Amazon.co.jp</p></section>
  <form action="/checkout/p/fixture/spc" method="post"><input name="anti-csrftoken-a2z" value="synthetic"><input name="quantity" value="${quantity}"><button name="continue">次に進む</button></form>`;
test('item selection follows only current same-flow native Continue after exact quantity and seller checks', async () => {
  const page = doc(selection(), origin + '/checkout/p/fixture/itemselect');
  assert.ok(amazonItemSelection(page, asin, amazonHttpForm));
  const f = clientFixture(); const reached = await f.client.advanceCheckout(page, { asin });
  assert.ok(reached.$('#spc-form').length); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].path, '/checkout/p/fixture/spc');
});
test('item selection never continues quantity zero, other seller/ASIN, other flow or final endpoint', async () => {
  for (const html of [selection(0), selection().replace(asin, 'B0TEST0002'), selection().replace('Amazon.co.jp', 'Other'),
    selection().replace('/fixture/spc', '/other/spc'), selection().replace('/fixture/spc', '/fixture/spc/place-order')]) {
    const page = doc(html, origin + '/checkout/p/fixture/itemselect');
    assert.equal(amazonItemSelection(page, asin, amazonHttpForm), null);
    const f = clientFixture(); const returned = await f.client.advanceCheckout(page, { asin });
    assert.equal(returned, page); assert.equal(f.calls.length, 0);
  }
});

test('unexpected completion during Prime decline locks transaction and never touches cart or final endpoint', async () => {
  const f = clientFixture();
  f.client.sendContract = async () => doc(completion(), origin + '/gp/buy/thankyou/handlers/display.html');
  await assert.rejects(f.client.advanceCheckout(doc('<h1>Prime</h1><a href="/gp/prime/handler?action=decline">No thanks</a>'), { asin, phase: 'buy_now' }), { code: 'AMAZON_UNEXPECTED_COMPLETION' });
  assert.equal(f.client.submitted, true); assert.equal(f.state.tx.phase, 'submitted'); assert.equal(f.calls.length, 0);
});

test('red flow GETs canonical SPC at 250ms sequential cadence, no extra buy/add or qty-zero Continue', async () => {
  const f = clientFixture({ checkout: stock, refresh: [stock, review()] }); assert.equal((await f.run()).status, 'ordered');
  assert.equal(f.calls.filter(c => c.path === '/checkout/p/fixture/spc').length, 2);
  assert.ok(f.waits.length === 2 && f.waits.every(ms => ms <= 250)); assert.equal(f.maxActive(), 1);
  assert.equal(f.state.stockWait, null); assert.equal(f.calls.filter(c => c.path.startsWith('/cart/add-to-cart/')).length, 1);
});

for (const status of [429, 503]) test(`red HTTP ${status} keeps retained AOD pointer and honors official delay`, async () => {
  const f = clientFixture({ checkout: stock, refresh: [response('', status, { 'retry-after': '180' })] });
  await assert.rejects(f.run(), e => e.code === 'AMAZON_RATE_LIMITED' && e.retryAfterMs === 180000);
  assert.equal(f.state.stockWait.tx.route, 'aod_fast');
  assert.equal(canRecoverAmazonDirectIntent({ transaction: f.state.tx, stockWait: f.state.stockWait, asin, fastLane: true }), true);
  assert.equal(canRecoverAmazonDirectIntent({ transaction: { ...f.state.tx, phase: 'submitted' }, stockWait: f.state.stockWait, asin, fastLane: true }), false);
  assert.equal(f.grants(), 0);
});

test('return to product releases red flow and resumes fresh product monitoring', async () => {
  const f = clientFixture({ checkout: stock }); let saved;
  f.client.request = async () => doc(product({ available: false }), origin + '/dp/' + asin);
  f.client.onStockWait = async s => { saved = s; }; f.client.waitFor = async () => {};
  await assert.rejects(f.client.waitAtCheckout(doc(stock), { asin, route: 'direct_buy_now' }, { asin }), { code: 'AMAZON_CHECKOUT_CART_EMPTY' });
  assert.equal(saved, null); assert.equal(f.state.tx, null);
});
