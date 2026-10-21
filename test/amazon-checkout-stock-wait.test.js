import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonJpHttpClient } from '../src/amazon-jp-http.js';
import { AmazonJpProductOrderMonitor, validateAmazonJpProductCheckout } from '../src/amazon-jp-product-order.js';
import { amazonCheckoutStockState, amazonStockWaitUrl } from '../src/amazon-checkout-stock-wait.js';
import { asin, origin, product, review, completion } from './fixtures/amazon-race-fixtures.js';

const red = `<h1>商品を更新する</h1><div data-asin="${asin}">数量: 0
  申し訳ありませんが、リクエストされた数量は入手できなくなりました。入手可能な最大数に数量を更新しました。</div>
  <form method="post" action="/unsafe-continue"><button>次に進む</button></form>`;
const empty = '<h1>Amazonカートは空です</h1>';
const response = (html, status = 200, headers = {}) => ({ status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} });

function fixture({ reads = [red, review()], state = {}, finalTimeout = false, waitFor } = {}) {
  const calls = [], waits = [], events = [], captures = [];
  let active = true, inFlight = 0, maxInFlight = 0;
  const client = new AmazonJpHttpClient({ stockWaitEnabled: true, stockWait: state.stockWait,
    canContinue: () => active, waitFor: async ms => { waits.push(ms); await waitFor?.(); },
    checkpoint: async tx => { state.tx = tx; }, onStockWait: async value => { state.stockWait = value; },
    recordStep: async (name, detail) => events.push({ name, ...detail }), captureEvidence: (kind, value) => captures.push({ kind, value }),
    request: { async fetch(url, options) {
      const path = new URL(url).pathname, method = options.method; calls.push({ path, method });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (path.startsWith('/dp/')) return response(product());
        if (path === '/checkout/entry/buynow') {
          if (method === 'POST') return response(red);
          const next = reads.shift(); assert.notEqual(next, undefined, 'unexpected extra refresh');
          if (next instanceof Error) throw next;
          return typeof next === 'string' ? response(next) : next;
        }
        if (path.endsWith('/place-order')) {
          if (finalTimeout) throw new Error('lost final response');
          return response(completion());
        }
        assert.fail('Unexpected operation: ' + path);
      } finally { inFlight--; }
    } }
  });
  const snapshot = { asin, title: 'BEYBLADE X BX-40', code: 'BX-40', priceYen: 880 };
  const run = () => client.checkoutDirect(snapshot, { beforeSubmit: async checkout => {
    validateAmazonJpProductCheckout(checkout, { asin, code: 'BX-40', msrpYen: 880, maxShippingYen: 500 });
    assert.equal(checkout.totalYen, 1380); assert.equal(checkout.shippingYen, 500);
  } });
  return { client, state, calls, waits, events, captures, run, stop: () => { active = false; }, maxInFlight: () => maxInFlight };
}

test('recognizes screenshot red/empty states; different ASIN and final/external URLs cannot enter refresh loop', () => {
  assert.equal(amazonCheckoutStockState({ html: red }, asin), 'stock_wait');
  assert.equal(amazonCheckoutStockState({ html: empty }, asin), 'empty');
  assert.equal(amazonCheckoutStockState({ html: red.replace(asin, 'B0TEST0002') }, asin), 'mismatch');
  assert.equal(amazonCheckoutStockState({ html: '<h1>此商品缺货，您无法购买</h1>' }, asin), 'stock_wait');
  for (const url of ['/checkout/p/fixture/spc/place-order', 'https://evil.example/checkout/entry/buynow', '/ap/signin']) assert.throws(() => amazonStockWaitUrl(url));
});

test('status exposes only stock-wait summary, never private checkout URL, flow tokens or old snapshot', async t => {
  const m = new AmazonJpProductOrderMonitor({ dataDir: '.', state: { data: {}, save: async () => {} },
    getConfig: () => ({ enabled: true, fastLane: true, mode: 'hybrid', targetUrl: origin + '/dp/' + asin }), orderHistory: { status: () => ({}) } });
  t.after(() => m.close());
  m.storage().checkoutStockWait = { asin, url: origin + '/checkout/p/PRIVATEFLOW/spc?token=SECRET', snapshot: { private: 'VALUE' }, since: '2026-10-21', refreshCount: 7 };
  const status = m.status(); assert.equal(status.checkoutStockWait.active, true); assert.equal(status.checkoutStockWait.refreshCount, 7);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATEFLOW|SECRET|VALUE/);
});

test('slow response adds no extra one-second idle wait', async () => {
  let stopped = false;
  const client = new AmazonJpHttpClient({ request: {}, canContinue: () => !stopped,
    waitFor: async ms => { assert.equal(ms, 0); stopped = true; } });
  await assert.rejects(client.waitAtCheckout({ html: red, url: origin + '/checkout/entry/buynow', durationMs: 1500 }, { asin }, { asin }), { code: 'AMAZON_STOCK_WAIT_STOPPED' });
});

test('red page retains checkout, GET refreshes sequentially, stock return permits exactly one fresh final POST', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 'submitted_unconfirmed'); // fixture has no confirmation URL; never fabricate success
  assert.deepEqual(f.calls.map(c => c.method + ' ' + c.path), ['GET /dp/' + asin, 'POST /checkout/entry/buynow',
    'GET /checkout/entry/buynow', 'GET /checkout/entry/buynow', 'POST /checkout/p/fixture/spc/place-order']);
  assert.equal(f.waits.length, 2); assert.ok(f.waits.every(ms => ms >= 0 && ms <= 1000));
  assert.equal(f.maxInFlight(), 1); assert.equal(f.state.stockWait, null);
  assert.equal(f.state.tx.phase, 'submitted');
});

test('only explicit empty cart releases retained flow and returns to product polling, never presses qty-zero Continue', async () => {
  const f = fixture({ reads: [empty] });
  await assert.rejects(f.run(), { code: 'AMAZON_CHECKOUT_CART_EMPTY' });
  assert.equal(f.state.stockWait, null); assert.equal(f.state.tx, null);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

for (const [label, next] of [['timeout', new Error('lost GET')], ['unknown page', '<h1>Temporary service error</h1>']]) {
  test(`${label} keeps original checkout; next client resumes GET without replaying product/Buy Now`, async () => {
    const f = fixture({ reads: [next] }); await assert.rejects(f.run());
    assert.ok(f.state.stockWait); assert.equal(f.client.submitted, false);
    const g = fixture({ state: f.state, reads: [review()] }); await g.run();
    assert.equal(g.calls[0].method, 'GET'); assert.equal(g.calls[0].path, '/checkout/entry/buynow');
    assert.equal(g.calls.filter(c => c.path.startsWith('/dp/')).length, 0);
    assert.equal(g.calls.filter(c => c.method === 'POST' && c.path === '/checkout/entry/buynow').length, 0);
    assert.equal(g.captures[0].kind, 'response');
  });
}

for (const status of [429, 503]) test(`red refresh HTTP ${status} honors Retry-After and does not issue another request`, async () => {
  const f = fixture({ reads: [response('', status, { 'retry-after': '180' })] });
  await assert.rejects(f.run(), e => e.code === 'AMAZON_RATE_LIMITED' && e.retryAfterMs === 180000);
  assert.ok(f.state.stockWait); assert.equal(f.calls.length, 3); assert.equal(f.client.submitted, false);
});

test('stop during red wait preserves location and issues no further request', async () => {
  let f; f = fixture({ waitFor: async () => f.stop() });
  await assert.rejects(f.run(), { code: 'AMAZON_STOCK_WAIT_STOPPED' });
  assert.ok(f.state.stockWait); assert.equal(f.calls.length, 2); assert.equal(f.client.submitted, false);
});

for (const patch of [{ quantity: 0 }, { quantity: 2 }, { target: 'B0TEST0002' }, { seller: 'Other' }, { mixed: true }, { points: true }]) {
  test(`stock return still rejects invalid review ${JSON.stringify(patch)}`, async () => {
    const f = fixture({ reads: [review(patch)] }); await assert.rejects(f.run());
    assert.equal(f.calls.some(c => c.path.endsWith('/place-order')), false);
    assert.ok(f.state.stockWait, 'unknown/invalid review must not trigger re-add');
  });
}

test('GET official sign-in redirect can return authenticated page without login false-positive; MFA remains distinct', async () => {
  const paths = [];
  const client = new AmazonJpHttpClient({ request: { fetch: async url => {
    const p = new URL(url).pathname; paths.push(p);
    return p === '/checkout/entry/buynow' ? response('', 302, { location: '/ap/signin' })
      : p === '/ap/signin' ? response('', 302, { location: '/checkout/p/fixture/spc' }) : response(review());
  } } });
  assert.equal((await client.request('/checkout/entry/buynow')).status, 200);
  assert.equal(paths.length, 3);
  await assert.rejects(client.request('/ap/mfa'), { code: 'AMAZON_VERIFICATION_REQUIRED' });
});
