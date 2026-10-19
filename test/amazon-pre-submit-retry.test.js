import test from 'node:test';
import assert from 'node:assert/strict';
import { canRecoverAmazonDirectIntent, nextAmazonPreSubmitRetry } from '../src/amazon-pre-submit-retry.js';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { AmazonRaceCoordinator } from '../src/amazon-race-coordinator.js';
import { parseAmazonHttpReview } from '../src/amazon-jp-http.js';
import { load } from 'cheerio';
import { asin, origin, product, review, completion } from './fixtures/amazon-race-fixtures.js';

const tx = () => ({ phase: 'buy_now', route: 'direct_buy_now', asin, quantity: 1, priceYen: 880 });
const stockPage = '<h1>更新您的商品</h1><div class="a-alert-content">抱歉，无法再提供您所请求的数量。我们已将您的数量更新为最大可提供数量。</div><p>数量: 0</p><form id="main-continue-form"><button>继续</button></form>';

test('only exact pre-final direct intent can recover; unknown final send and consumed race grants never unlock', () => {
  const base = { transaction: tx(), asin, fastLane: true };
  assert.equal(canRecoverAmazonDirectIntent(base), true);
  for (const phase of ['adding', 'cart_ready', 'submitted', 'confirmed']) assert.equal(canRecoverAmazonDirectIntent({ ...base, transaction: { ...tx(), phase } }), false);
  for (const raceState of ['granted', 'unknown', 'ordered']) assert.equal(canRecoverAmazonDirectIntent({ ...base, raceState }), false);
  for (const patch of [{ submitted: true }, { asin: 'B0TEST0002' }, { fastLane: false }, { transaction: { ...tx(), quantity: 2 } }, { transaction: { ...tx(), route: 'old_cart' } }]) {
    assert.equal(canRecoverAmazonDirectIntent({ ...base, ...patch }), false);
  }
});

test('three failed preparations use 2s/5s/30s, then resume with a fresh bounded retry window; Retry-After wins', () => {
  let now = 1_700_000_000_000, previous;
  for (const delay of [2000, 5000, 30_000, 2000]) {
    previous = nextAmazonPreSubmitRetry(previous, { asin, now });
    assert.equal(previous.delayMs, delay); now += delay;
  }
  assert.equal(nextAmazonPreSubmitRetry(previous, { asin, now, minimumDelayMs: 120_000 }).delayMs, 120_000);
  assert.equal(nextAmazonPreSubmitRetry(previous, { asin: 'B0TEST0002', now }).attempts, 1);
});

function fixture(t, { slot = 'A', failBuy = false, finalTimeout = false, captcha = false, rateLimited = false, unexpectedCompletion = false } = {}) {
  const calls = [], config = { enabled: true, fastLane: true, checkoutTransport: 'api', mode: 'hybrid', targetUrl: origin + '/dp/' + asin, targetSuccessCount: 1, maxShippingYen: 500 };
  const state = { data: {}, save: async () => {}, writeSnapshot: async () => {} };
  let available = false;
  const request = { async fetch(url, options = {}) {
    const p = new URL(url).pathname; calls.push({ p, method: options.method || 'GET' });
    let html = '', status = 200, headers = {};
    if (p.startsWith('/dp/')) html = product();
    else if (p === '/checkout/entry/buynow') {
      if (failBuy) throw new Error('synthetic lost Buy Now response');
      if (rateLimited) { status = 429; headers['retry-after'] = '120'; }
      if (unexpectedCompletion) { status = 302; headers.location = '/gp/buy/thankyou/handlers/display.html'; }
      html = captcha ? '<h1>Robot Check</h1>' : available ? review() : stockPage;
    } else if (p.endsWith('/place-order')) {
      if (finalTimeout) throw new Error('synthetic lost FINAL response');
      status = 302; headers.location = '/gp/buy/thankyou/handlers/display.html';
    } else if (p.includes('/thankyou/')) html = completion();
    else assert.fail('Unnecessary request during retry: ' + p);
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} };
  } };
  const records = [];
  const history = { begin: async r => { const record = { ...r }; records.push(record); return record; }, step: async () => {},
    finish: async (r, result) => Object.assign(r, result), notification: async () => {}, status: () => ({}) };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, slot, getConfig: () => config, orderHistory: history });
  monitor.contextFor = async () => ({ request });
  monitor.resolveMsrp = () => ({ msrpYen: 880, code: 'BX-40' });
  t.after(() => monitor.close());
  return { monitor, state, config, calls, records, available: () => { available = true; }, poll: () => monitor.scanOnce({ purchase: true, trigger: 'poll' }) };
}

test('official update-items quantity-shortage page is stock competition, not a missing final form; Continue is never clicked', () => {
  assert.throws(() => parseAmazonHttpReview({ $: load(stockPage), url: origin + '/checkout/p/fixture/spc' }, { priceYen: 880 }), { code: 'AMAZON_CHECKOUT_STOCK_CHANGED' });
});
for (const slot of ['A', 'B', 'C']) {
  test(`${slot}: stock loss in 02 resumes automatically without cart/order tour, then a later fresh quote can succeed once`, async t => {
    const f = fixture(t, { slot });
    await assert.rejects(f.poll(), { code: 'AMAZON_CHECKOUT_STOCK_CHANGED' });
    assert.equal(f.config.enabled, true); assert.equal(f.monitor.canSchedule(), true); assert.ok(f.monitor.timer);
    assert.equal(f.monitor.hasPendingApiTransaction(), false); assert.equal(f.monitor.storage().status, 'waiting_poll');
    assert.equal(f.monitor.storage().preSubmitRetry.attempts, 1);
    assert.match(f.monitor.status().purchaseSteps.at(-1).action, /2秒後重試/);
    assert.equal(f.monitor.status().purchaseSteps.at(-1).step, '02');
    assert.equal(f.calls.filter(c => c.p.endsWith('/place-order')).length, 0);
    delete f.monitor.storage().backoffUntil; f.available();
    assert.equal((await f.poll()).status, 'ordered'); assert.equal(f.monitor.storage().completedCount, 1);
    assert.equal(f.calls.filter(c => c.p.endsWith('/place-order')).length, 1);
    assert.equal(f.records.length, 2); assert.deepEqual(f.records.map(r => r.status), ['failed', 'ordered']);
    assert.equal(f.calls.some(c => /cart|order-history|order-details/.test(c.p)), false);
  });
}
test('lost Buy Now response resumes, but lost FINAL order response stays held with exactly one final POST', async t => {
  const lostBuy = fixture(t, { failBuy: true });
  await assert.rejects(lostBuy.poll()); assert.equal(lostBuy.monitor.canSchedule(), true);
  assert.equal(lostBuy.monitor.hasPendingApiTransaction(), false);
  const lostFinal = fixture(t, { finalTimeout: true }); lostFinal.available();
  const result = await lostFinal.poll(); assert.equal(result.status, 'submitted_unconfirmed');
  assert.equal(lostFinal.monitor.storage().status, 'needs_review'); assert.equal(lostFinal.monitor.canSchedule(), false);
  await lostFinal.poll(); assert.equal(lostFinal.calls.filter(c => c.p.endsWith('/place-order')).length, 1);
  assert.equal(lostFinal.monitor.storage().apiTransaction.phase, 'submitted');
});
test('restart releases exact legacy direct pre-final hold automatically, but not submitted or unproven cart states', async t => {
  const f = fixture(t); f.monitor.storage().status = 'needs_review'; f.monitor.storage().apiTransaction = tx();
  await f.monitor.start();
  assert.equal(f.monitor.hasPendingApiTransaction(), false); assert.equal(f.monitor.canSchedule(), true); assert.ok(f.monitor.timer);
  assert.deepEqual(f.calls, [], 'recover from our own stage evidence without reading or clearing cart');
  for (const phase of ['submitted', 'adding']) {
    const held = fixture(t); held.monitor.storage().apiTransaction = { ...tx(), phase };
    await held.monitor.start(); assert.equal(held.monitor.hasPendingApiTransaction(), true);
    assert.equal(held.monitor.canSchedule(), false); assert.equal(held.monitor.timer, null);
  }
});
test('unexpected confirmation after Buy Now is held, never mistaken for ordinary pre-submit failure and auto-bought again', async t => {
  const f = fixture(t, { unexpectedCompletion: true });
  await assert.rejects(f.poll(), { code: 'AMAZON_UNEXPECTED_COMPLETION' });
  assert.equal(f.monitor.storage().status, 'needs_review'); assert.equal(f.monitor.canSchedule(), false);
  assert.equal(f.monitor.storage().apiTransaction.phase, 'submitted'); assert.equal(f.monitor.storage().completedCount, 0);
  assert.equal(f.calls.filter(c => c.p.endsWith('/place-order')).length, 0);
  await f.poll(); assert.equal(f.calls.filter(c => c.p === '/checkout/entry/buynow').length, 1);
});
test('pre-final retry respects official cooldown and real human verification; no token clearing or CAPTCHA bypass', async t => {
  const rate = fixture(t, { rateLimited: true });
  await assert.rejects(rate.poll(), { code: 'AMAZON_RATE_LIMITED' });
  assert.equal(rate.monitor.canSchedule(), true); assert.ok(Date.parse(rate.monitor.storage().backoffUntil) - Date.now() > 119_000);
  assert.equal(rate.monitor.storage().preSubmitRetry.delayMs, 120_000);
  const captcha = fixture(t, { captcha: true });
  await assert.rejects(captcha.poll(), { code: 'AMAZON_VERIFICATION_REQUIRED' });
  assert.equal(captcha.monitor.storage().status, 'needs_verification'); assert.equal(captcha.monitor.canSchedule(), false);
});
test('state-write failure restores pending intent and stops instead of sending another purchase', async t => {
  const f = fixture(t); f.monitor.storage().apiTransaction = tx();
  f.state.writeSnapshot = async () => { throw new Error('disk full'); };
  await assert.rejects(f.monitor.recoverPreSubmit(), /disk full/);
  assert.equal(f.monitor.storage().apiTransaction.phase, 'buy_now'); assert.equal(f.monitor.canSchedule(), false); assert.deepEqual(f.calls, []);
});
test('race permits new preparation IDs with bounded retries but never reuses any final grant, even after a day', async () => {
  let now = 1_700_000_000_000;
  const state = { data: {}, writeSnapshot: async () => {} }, config = { enabled: true, targetUrl: origin + '/dp/' + asin };
  const c = new AmazonRaceCoordinator({ state, getConfig: () => config, now: () => now });
  let lease = await c.begin('A', 'api', asin); const waveId = lease.waveId;
  for (const delay of [2000, 5000, 30_000]) {
    await c.finish(lease, { status: 'failed' });
    assert.equal(Date.parse(c.status('A').routes.api.retryAt) - now, delay);
    await assert.rejects(c.begin('A', 'api', asin)); now += delay;
    const next = await c.begin('A', 'api', asin); assert.equal(next.waveId, waveId); assert.notEqual(next.attemptId, lease.attemptId);
    await assert.rejects(c.grant(lease)); lease = next;
  }
  await c.grant(lease); await c.finish(lease, { status: 'failed' }); now += 86_400_000;
  await assert.rejects(c.begin('A', 'api', asin)); await assert.rejects(c.grant(lease));
});
