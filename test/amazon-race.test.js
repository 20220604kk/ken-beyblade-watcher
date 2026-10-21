import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { AmazonRaceCoordinator } from '../src/amazon-race-coordinator.js';
import { AmazonRaceBridge, raceDocument } from '../src/amazon-race-bridge.js';
import { AmazonOrderHistory } from '../src/amazon-order-history.js';
import { AmazonJpHttpClient, amazonOrderIdFromCompletion } from '../src/amazon-jp-http.js';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { createDashboard } from '../src/dashboard.js';
import { amazonDomAction } from '../extensions/amazon-race/dom.js';
import { accountIdentity } from '../extensions/amazon-race/identity.js';
import { asin, origin, product, review, completion } from './fixtures/amazon-race-fixtures.js';

function fixture(data = {}) {
  const config = { enabled: true, targetUrl: origin + '/dp/' + asin, targetSuccessCount: 1, maxShippingYen: 500 };
  let writes = 0;
  const state = { data, save: async () => {}, writeSnapshot: async () => { writes++; } };
  const coordinator = new AmazonRaceCoordinator({ state, getConfig: () => config });
  return { coordinator, state, config, writes: () => writes };
}
test('parallel leases grant once per route, at most two sends, neither waits for peer network', async () => {
  const { coordinator: c, writes } = fixture();
  const [api, frontend] = await Promise.all(['api', 'frontend'].map(r => c.begin('A', r, asin)));
  assert.equal(api.waveId, frontend.waveId);
  const grants = await Promise.all([c.grant(api), c.grant(frontend), c.grant(api)].map(p => p.then(v => v, e => e)));
  assert.equal(grants.filter(r => r.granted).length, 2);
  assert.equal(writes(), 4);
  await assert.rejects(c.begin('A', 'api', asin));
  await c.finish(api, { status: 'ordered', orderId: '000-0000000-0000001' });
  await c.finish(frontend, { status: 'ordered', orderId: '000-0000000-0000002' });
  assert.deepEqual(Object.values(c.status('A').routes).map(r => r.state), ['ordered', 'ordered']);
});
test('first success cancels only a peer which has NOT received a final grant', async () => {
  const { coordinator: c } = fixture();
  const api = await c.begin('A', 'api', asin), f = await c.begin('A', 'frontend', asin);
  await c.grant(api); await c.finish(api, { status: 'ordered', orderId: '000-0000000-0000001' });
  assert.equal(c.canContinue(f), false); await assert.rejects(c.grant(f));
  assert.equal(c.status('A').routes.frontend.state, 'cancelled');
  assert.equal(c.pending('A'), false);
});
test('unknown API send does not prevent ONE frontend send; restart cannot replay either consumed grant', async () => {
  const f = fixture(), c = f.coordinator;
  const api = await c.begin('A', 'api', asin); await c.grant(api); await c.finish(api, { status: 'submitted_unconfirmed' });
  const frontend = await c.begin('A', 'frontend', asin); await c.grant(frontend);
  const restarted = fixture(structuredClone(f.state.data)).coordinator;
  await assert.rejects(restarted.grant(api)); await assert.rejects(restarted.grant(frontend));
  restarted.unavailable('A'); await assert.rejects(restarted.begin('A', 'api', asin));
  await assert.rejects(restarted.reset('A'));
  await restarted.finish(frontend, { status: 'ordered', orderId: '000-0000000-0000002' });
  assert.equal(restarted.status('A').routes.api.state, 'unknown');
});
test('a failure or duplicate completion cannot overwrite success or double-count the other route order', async () => {
  const { coordinator: c } = fixture();
  const a = await c.begin('A', 'api', asin), b = await c.begin('A', 'frontend', asin);
  await c.grant(a); await c.grant(b);
  let count = 0;
  await c.finish(a, { status: 'ordered', orderId: '000-0000000-0000001' }, () => count++);
  await c.finish(a, { status: 'failed' }, () => count++);
  await assert.rejects(c.finish(b, { status: 'ordered', orderId: '000-0000000-0000001' }));
  await c.finish(b, { status: 'failed' });
  assert.equal(count, 1); assert.equal(c.status('A').routes.api.state, 'ordered');
  assert.equal(c.status('A').routes.frontend.state, 'unknown');
});
test('disk failure consumes in-memory grant fail-closed; stale, foreign and cancelled leases never send', async () => {
  const f = fixture(), c = f.coordinator;
  const a = await c.begin('A', 'api', asin);
  f.state.writeSnapshot = async () => { throw new Error('disk full'); };
  await assert.rejects(c.grant(a), /disk full/); await assert.rejects(c.grant(a));
  assert.equal(c.status('A').routes.api.state, 'granted');
  await assert.rejects(c.grant({ ...a, slot: 'B' }));
  const second = fixture(); const b = await second.coordinator.begin('A', 'frontend', asin);
  await second.coordinator.cancel('A'); await assert.rejects(second.coordinator.grant(b));
});
test('no new wave on continuous availability; later unavailable edge re-arms only settled routes', async () => {
  const { coordinator: c } = fixture();
  const a = await c.begin('A', 'api', asin); await c.finish(a, { status: 'failed' });
  await assert.rejects(c.begin('A', 'api', asin)); c.unavailable('A');
  const next = await c.begin('A', 'api', asin); assert.notEqual(next.waveId, a.waveId);
  assert.equal(c.maintenanceBlocked(), true);
  await c.finish(next, { status: 'failed' }); c.online.add('A'); assert.equal(c.maintenanceBlocked(), true);
});

async function bridgeFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-race-test-'));
  const f = fixture(), history = new AmazonOrderHistory(dir);
  history.evidence.render = async () => Buffer.from('offline test image');
  const storage = { completedCount: 0 }, notifications = [];
  const monitor = { phase: 'idle', getConfig: () => f.config, targetProduct: () => ({ title: 'BX-40' }),
    storage: () => storage, resolveMsrp: () => ({ msrpYen: 880 }), pollIntervalMs: () => 2000, stop: () => {},
    notifyPrivate: async msg => notifications.push(msg) };
  const bridge = new AmazonRaceBridge({ coordinator: f.coordinator, monitors: { A: monitor }, history });
  bridge.runtime.set('A', { state: 'connected', steps: [], refreshCount: 0 });
  t.after(async () => { await history.evidence.queue; await fs.rm(dir, { recursive: true, force: true }); });
  await history.ready;
  return { ...f, bridge, history, monitor, storage, notifications };
}
test('frontend full synthetic flow validates DOM, persists one grant, stores separate route/order and no private HTML in state', async t => {
  const f = await bridgeFixture(t);
  const begin = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
  assert.equal(begin.action, 'buy');
  const grant = await f.bridge.message('A', { type: 'review', lease: begin.lease, url: origin + '/checkout/p/fixture/spc', html: review() });
  assert.equal(grant.action, 'submit');
  const result = await f.bridge.message('A', { type: 'result', lease: begin.lease,
    url: origin + '/gp/buy/thankyou/handlers/display.html', html: completion() });
  assert.equal(result.status, 'ordered'); assert.equal(f.storage.completedCount, 1);
  await f.bridge.message('A', { type: 'result', lease: begin.lease, url: origin + '/gp/buy/thankyou/handlers/display.html', html: completion() });
  assert.equal(f.storage.completedCount, 1); assert.equal(f.history.recent[0].route, 'frontend');
  assert.equal(f.history.recent[0].status, 'ordered'); assert.equal(f.notifications.length, 1);
  const serialized = JSON.stringify(f.state.data);
  assert.doesNotMatch(serialized, /synthetic-token|synthetic-review-token|Synthetic test destination|<form/);
  assert.ok(f.history.recent[0].evidence.length);
});
for (const [name, options] of Object.entries({ wrongAsin: { target: 'B0TEST0002' }, multiQuantity: { quantity: 2 }, mixed: { mixed: true },
  seller: { seller: 'Other' }, shipping: { shipping: 501, total: 1381 }, total: { total: 1500 }, points: { points: true } })) {
  test('frontend refuses unsafe checkout: ' + name, async t => {
    const f = await bridgeFixture(t);
    const { lease } = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
    await assert.rejects(f.bridge.message('A', { type: 'review', lease, url: origin + '/checkout/p/fixture/spc', html: review(options) }));
    assert.equal(f.coordinator.status('A').routes.frontend.state, 'preparing');
  });
}
test('TWD requires native JPY selection; unavailable/third-party rejected, TT MSRP no longer gates retail', async t => {
  const f = await bridgeFixture(t);
  for (const options of [{ available: false }]) assert.equal((await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product(options) })).action, 'wait');
  await assert.rejects(f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product({ seller: 'OTHER' }) }));
  const { lease } = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
  assert.equal((await f.bridge.message('A', { type: 'review', lease, url: origin + '/checkout/p/fixture/spc', html: review({ jpy: false }) })).action, 'jpy');
  assert.equal(f.coordinator.status('A').routes.frontend.state, 'preparing');
});

test('frontend uses its own retail quote instead of TT/manual MSRP, then rejects checkout above that quote', async t => {
  const f = await bridgeFixture(t);
  f.bridge.monitors.A.resolveMsrp = () => assert.fail('frontend cannot resolve TT');
  assert.equal(f.bridge.task('A').pricingPolicy, 'amazon_retail_quote');
  const { lease } = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product({ price: 9900 }) });
  assert.ok(lease);
  await assert.rejects(f.bridge.message('A', { type: 'review', lease, url: origin + '/checkout/p/fixture/spc', html: review({ total: 11000 }) }), /金額無法核對/);
  assert.equal(f.coordinator.status('A').routes.frontend.state, 'preparing');
  const result = await f.bridge.message('A', { type: 'review', lease, url: origin + '/checkout/p/fixture/spc',
    html: review({ total: 10400 }).replace('商品: JPY 880', '商品: JPY 9900') });
  assert.equal(result.action, 'submit');
});
test('CAPTCHA/login, external URLs, misleading purchaseId, and no final grant cannot claim a successful order', async t => {
  for (const url of ['https://evil.invalid/', 'https://www.amazon.co.jp/ap/signin']) assert.throws(() => raceDocument({ url, html: product() }));
  assert.throws(() => raceDocument({ url: origin + '/dp/' + asin, html: '<title>Robot Check</title>' }));
  const f = await bridgeFixture(t);
  const { lease } = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
  const early = await f.bridge.message('A', { type: 'result', lease, url: origin + '/gp/buy/thankyou/handlers/display.html', html: completion() });
  assert.equal(early.status, 'submitted_unconfirmed'); assert.equal(f.storage.completedCount, 0);
  assert.equal((await f.bridge.message('A', { type: 'result', lease, url: origin + '/gp/buy/thankyou/handlers/display.html', html: completion() })).status, 'submitted_unconfirmed');
  assert.equal(f.storage.completedCount, 0);
  await assert.rejects(f.coordinator.grant(lease));
  const g = await bridgeFixture(t);
  const second = await g.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
  await g.coordinator.grant(second.lease);
  const unknown = await g.bridge.message('A', { type: 'result', lease: second.lease, url: origin + '/gp/buy/thankyou/handlers/display.html?purchaseId=999-9999999-9999999', html: '<h1>订单已提交</h1>' });
  assert.equal(unknown.status, 'submitted_unconfirmed'); assert.equal(g.storage.completedCount, 0);
});
test('pairing binds slot + extension origin and never exposes token in status; foreign hosts rejected', async t => {
  const f = await bridgeFixture(t), paired = await f.bridge.pair('A');
  const fakeSocket = { close() {} };
  await assert.rejects(f.bridge.authenticate('https://evil.invalid', { slot: 'A', token: paired.token, accountConfirmed: true }, fakeSocket));
  await assert.rejects(f.bridge.authenticate('chrome-extension://' + 'a'.repeat(32), { slot: 'A', token: 'bad', accountConfirmed: true }, fakeSocket));
  await f.bridge.authenticate('chrome-extension://' + 'a'.repeat(32), { slot: 'A', token: paired.token, accountConfirmed: true }, fakeSocket);
  assert.equal(f.bridge.status('A').connected, true);
  assert.doesNotMatch(JSON.stringify(f.bridge.status('A')), new RegExp(paired.token));
  assert.notEqual(f.coordinator.root().pairing.A.tokenHash, paired.token);
});
test('API grant denial occurs before final POST; consumed grant never retries and parallel mode never attributes peer history', async () => {
  const calls = [];
  const client = new AmazonJpHttpClient({ request: {}, authorizeFinalSubmit: async () => { throw new Error('peer won'); } });
  const tx = { phase: 'buy_now' };
  client.prepareDirectCheckout = async () => ({ tx, reviewPage: {}, review: { checkout: { totalYen: 1380, shippingYen: 500 } } });
  client.sendForm = async () => { calls.push('final POST'); };
  await assert.rejects(client.checkoutDirect({}, { beforeSubmit: async () => {} }), /peer won/);
  assert.equal(client.submitted, false); assert.equal(tx.phase, 'buy_now'); assert.deepEqual(calls, []);
});
test('real API monitor + real HTTP parser and frontend bridge finish two independent synthetic orders with no peer wait or cross-record overwrite', async t => {
  const f = await bridgeFixture(t), calls = [];
  let release, finalArrived;
  const arrived = new Promise(resolve => { finalArrived = resolve; });
  const responseReady = new Promise(resolve => { release = resolve; });
  const transport = { async fetch(url, options = {}) {
    const u = new URL(url); calls.push([u.pathname, options.method || 'GET']);
    let html = '', status = 200, headers = {};
    if (u.pathname.startsWith('/dp/')) html = product();
    else if (u.pathname === '/checkout/entry/buynow') html = review();
    else if (u.pathname.endsWith('/place-order')) { finalArrived(); await responseReady; status = 302; headers.location = '/gp/buy/thankyou/handlers/display.html'; }
    else if (u.pathname.includes('/thankyou/')) html = completion('000-0000000-0000001');
    else assert.fail('Unexpected API request: ' + u.pathname);
    return { status: () => status, headers: () => headers, text: async () => html, dispose: async () => {} };
  } };
  Object.assign(f.config, { checkoutTransport: 'api', fastLane: true, mode: 'scan_signal' });
  const monitor = new AmazonJpProductOrderMonitor({ slot: 'A', dataDir: '.', state: f.state, getConfig: () => f.config,
    orderHistory: f.history, notifyPrivate: async () => {} });
  monitor.contextFor = async () => ({ request: transport });
  monitor.resolveMsrp = () => ({ msrpYen: 880, code: 'BX-40' });
  monitor.raceCoordinator = f.coordinator; f.coordinator.online.add('A'); f.bridge.monitors.A = monitor;
  t.after(() => monitor.close());
  const api = monitor.scanOnce({ purchase: true, signal: { asin, matchedAt: Date.now() }, trigger: 'synthetic_parallel' });
  await Promise.race([arrived, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('API did not reach final send')), 3000); timer.unref(); })]);
  const { lease } = await f.bridge.message('A', { type: 'product', url: origin + '/dp/' + asin, html: product() });
  await f.bridge.message('A', { type: 'review', lease, url: origin + '/checkout/p/fixture/spc', html: review() });
  await f.bridge.message('A', { type: 'result', lease, url: origin + '/gp/buy/thankyou/handlers/display.html', html: completion() });
  release(); assert.equal((await api).status, 'ordered');
  assert.equal(monitor.storage().completedCount, 2);
  const records = f.history.recent.filter(r => r.status === 'ordered');
  assert.equal(records.length, 2); assert.equal(new Set(records.map(r => r.raceId)).size, 1);
  assert.deepEqual(records.map(r => r.route).sort(), ['api', 'frontend']);
  assert.equal(new Set(records.map(r => r.orderId)).size, 2);
  assert.equal(calls.filter(([p]) => p.endsWith('/place-order')).length, 1);
  assert.ok(!calls.some(([p]) => /cart|order-history|order-details/.test(p)), 'no cart or ambiguous cross-route history query in hot path');
});
test('dashboard pairing HTTP boundary rejects websites, rebinding hosts and GET; local UI receives secret once only', async t => {
  const f = await bridgeFixture(t);
  const server = createDashboard({ port: 0, amazonRace: f.bridge, getStatus: () => ({}), log: () => {} });
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (headers = {}, method = 'POST') => fetch(base + '/amazon-race/pair', { method,
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ slot: 'A' }) } : {}) });
  assert.equal((await request({ Origin: 'https://evil.invalid' })).status, 400);
  assert.equal((await request({ Host: 'evil.invalid', Origin: 'http://evil.invalid' })).status, 400);
  assert.equal((await request({}, 'GET')).status, 400);
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json(); assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.bridge.status('A')), new RegExp(body.token));
});
test('identity tolerates official language greeting changes, not different display identities', () => {
  assert.equal(accountIdentity('Hello, Test'), accountIdentity('こんにちは、Testさん'));
  assert.notEqual(accountIdentity('Hello, Test'), accountIdentity('Hello, Other'));
});

test('native DOM executor clicks actual button overrides, detects changed review, and never repeats a click by itself', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); let posts = 0;
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ contentType: 'text/html', body: u.pathname.startsWith('/dp/') ? product() : review() });
  });
  await page.goto(origin + '/dp/' + asin);
  const p = await page.evaluate(amazonDomAction, 'read');
  await page.evaluate(({ source, command, expected }) => (0, eval)('(' + source + ')')(command, expected), { source: amazonDomAction.toString(), command: 'buy', expected: p });
  await page.waitForURL('**/checkout/entry/buynow'); assert.equal(posts, 1);
  const r = await page.evaluate(amazonDomAction, 'read');
  await page.locator('#item-block-product-title-1').evaluate(n => { n.textContent = 'Different item'; });
  await assert.rejects(page.evaluate(({ source, expected }) => (0, eval)('(' + source + ')')('submit', expected), { source: amazonDomAction.toString(), expected: r }), /已變更/);
  assert.equal(posts, 1);
});

for (const shortageFirst of [false, true]) {
test(`actual MV3 extension -> local WebSocket -> fixture Amazon DOM -> stored confirmed order${shortageFirst ? ' after an automatic pre-submit shortage retry' : ''}; no real external traffic`, { timeout: 60_000 }, async t => {
  const f = await bridgeFixture(t), paired = await f.bridge.pair('A');
  let observedResult;
  const handle = f.bridge.message.bind(f.bridge);
  f.bridge.message = async (slot, msg) => {
    if (msg.type === 'result') observedResult = { url: msg.url, text: load(msg.html || '')('body').text().slice(0, 600),
      parsed: msg.html ? amazonOrderIdFromCompletion({ url: msg.url, $: load(msg.html) }) : '' };
    return handle(slot, msg);
  };
  const server = http.createServer(); f.bridge.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const ws of f.bridge.connections.values()) ws.terminate(); server.close(resolve); }));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ken-race-chromium-'));
  const ext = path.resolve('extensions/amazon-race');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost'] });
  t.after(async () => { await context.close(); await fs.rm(profile, { force: true, recursive: true }); });
  try {
  const errors = [];
  context.on('weberror', e => errors.push(e.error().message));
  let buyPosts = 0, finalPosts = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.origin !== origin) return route.abort();
    let html;
    if (url.pathname.startsWith('/dp/')) html = product();
    else if (url.pathname === '/checkout/entry/buynow') {
      buyPosts++;
      html = shortageFirst && buyPosts === 1 ? '<h1>更新您的商品</h1><p>抱歉，无法再提供您所请求的数量。我们已将您的数量更新为最大可提供数量。</p><p>数量: 0</p>' : review();
    }
    else if (url.pathname.endsWith('/place-order')) {
      finalPosts++;
      // Playwright routes only the first request in an HTTP redirect chain.
      // A new fixture navigation is intercepted again, unlike a 302 follow-up.
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
        body: '<script>location.replace("/gp/buy/thankyou/handlers/display.html")</script>' });
    } else if (url.pathname.includes('/thankyou/')) html = completion();
    else return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10_000 });
  // Test-only transport redirection; installed production source stays pinned
  // to localhost:3210. No production Chrome profile/account is opened.
  await worker.evaluate(port => {
    const Native = WebSocket;
    globalThis.WebSocket = class extends Native { constructor() { super('ws://127.0.0.1:' + port + '/amazon-race/socket'); } };
  }, server.address().port);
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage(); await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  const response = await popup.evaluate(async token => chrome.runtime.sendMessage({ type: 'connect', slot: 'A', token, accountLabel: 'Hello, Test' }), paired.token);
  assert.equal(response.ok, true);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(async () => { clearInterval(interval);
      const local = await worker.evaluate(() => chrome.storage.local.get(['status', 'transaction', 'tabId']));
      reject(new Error(JSON.stringify({ bridge: f.bridge.status('A'), local, observedResult, pages: context.pages().map(p => p.url()), buyPosts, finalPosts }))); }, 30_000);
    const interval = setInterval(() => { if (f.storage.completedCount === 1 && f.history.recent[0]?.status === 'ordered') { clearTimeout(deadline); clearInterval(interval); resolve(); } }, 100);
  });
  assert.equal(buyPosts, shortageFirst ? 2 : 1); assert.equal(finalPosts, 1); assert.equal(f.history.recent[0].status, 'ordered');
  if (shortageFirst) { assert.equal(f.history.recent.length, 2); assert.equal(f.history.recent[1].status, 'failed'); }
  assert.equal(f.history.recent[0].route, 'frontend'); assert.deepEqual(errors, []);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'connect', slot: 'A', token: 'f'.repeat(64), accountLabel: 'Hello, Other' }));
  assert.equal(finalPosts, 1, 'reconnect must not place another order');
  } finally { await context.close(); }
});
}
