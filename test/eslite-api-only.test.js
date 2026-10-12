import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EslitePurchaseAdapter, MultiAccountEslitePurchaseAdapter, purchaseEsliteViaApi, readEsliteAuthToken } from '../src/auto-purchase.js';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';

const jwt = (expiry) => `Bearer e30.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`;
const response = (status, body) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => body, dispose: async () => {} });
const tokenState = (token) => ({ cookies: [], origins: [{ origin: 'https://www.eslite.com', localStorage: [{ name: 'auth._token.prd', value: token }] }] });
const product = { id: '1004201480268319742001', title: 'BEYBLADE X BX-09', available: true, stock: 1 };
const template = { paymentMode: 'seven_cod', checkout: { payment: '8', delivery: '5' } };
async function fixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-api-only-'));
  const sessionFile = path.join(dataDir, 'session.json');
  await fs.writeFile(sessionFile, JSON.stringify(tokenState(jwt(Math.floor(Date.now() / 1000) + 86400))));
  const adapter = new EslitePurchaseAdapter({ dataDir, sessionFile, apiOnly: true,
    getCredentials: () => ({ account: 'mock', password: 'mock' }), getCheckoutTemplate: () => template,
    apiContextFactory: async () => ({ api: { dispose: async () => {} }, expiresAtMs: Date.now() + 86400000 }),
    apiMaintenanceRunner: async (_file, opts) => ({ ok: true, loggedIn: true, cartEmpty: opts.clearCart ? true : null }),
    ...options });
  return { adapter, async close() { await adapter.close(); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

test('本地舊 token 不覆蓋較新 cookie，false 不是登入憑證', () => {
  const state = tokenState(jwt(1)); const newer = jwt(9999999999);
  state.cookies.push({ name: 'auth._token.prd', value: newer });
  assert.equal(readEsliteAuthToken(state), newer);
  assert.equal(readEsliteAuthToken(tokenState('false')), '');
});

test('重新啟動依本地 JWT 判讀到期，不因畫面曾登入就標為正常', async () => {
  const f = await fixture();
  try {
    await f.adapter.localSessionLoad;
    await fs.writeFile(f.adapter.sessionFile, JSON.stringify(tokenState(jwt(1))));
    f.adapter.loginState = 'idle'; await f.adapter._loadStoredTokenStatus();
    assert.equal(f.adapter.loginState, 'needs_login'); assert.equal(f.adapter.lastTokenExpiresAtMs, 1000);
  } finally { await f.close(); }
});

test('API 待命不因十分鐘到期失效，心跳不反覆清空已確認空車', async () => {
  const clears = [];
  const f = await fixture({ apiMaintenanceRunner: async (_file, opts) => { clears.push(opts.clearCart); return { ok: true, loggedIn: true, cartEmpty: opts.clearCart ? true : null }; } });
  try {
    await f.adapter.verifyStoredSession();
    f.adapter.apiReadyAtMs = Date.now() - 11 * 60000;
    assert.equal(f.adapter._apiReady(), true);
    await f.adapter.verifyStoredSession();
    assert.deepEqual(clears, [true, false]);
    f.adapter.apiTokenExpiresAtMs = Date.now() - 1;
    assert.equal(f.adapter._apiReady(), false);
  } finally { await f.close(); }
});

test('API-only 憑證失效只告警，不啟動背景瀏覽器', async () => {
  let browsers = 0, alerts = 0;
  const f = await fixture({ apiContextFactory: async () => { throw Object.assign(new Error('expired'), { purchaseStatus: 'needs_login' }); },
    sessionRecoveryRunner: async () => { browsers++; }, onSessionProblem: () => { alerts++; } });
  try { await f.adapter.verifyStoredSession(); await f.adapter.verifyStoredSession(); assert.equal(browsers, 0); assert.equal(alerts, 1); assert.equal(f.adapter.loginState, 'needs_login'); }
  finally { await f.close(); }
});

test('完成登入必须確認 token 有效和會員 API 身分，畫面登出按鈕不算證據', async () => {
  const f = await fixture(); let gets = 0;
  let stored = tokenState(jwt(1)); let status = 401;
  const page = { context: () => ({ storageState: async () => stored, request: { get: async () => { gets++; return response(status, status === 200 ? { id: 1 } : {}); } } }) };
  f.adapter.loginRequestFactory = { newContext: async () => ({ get: async () => { gets++; return response(status, status === 200 ? { id: 1 } : {}); }, dispose: async () => {} }) };
  try {
    await assert.rejects(f.adapter._validateBrowserLoginApi(page), /過期/); assert.equal(gets, 0);
    stored = tokenState(jwt(9999999999));
    await assert.rejects(f.adapter._validateBrowserLoginApi(page), /401/);
    status = 200; assert.equal(await f.adapter._validateBrowserLoginApi(page), true);
  } finally { await f.close(); }
});

test('API-only 沒有結帳範本立即停止，不能偷偷切成 UI 下單', async () => {
  const f = await fixture({ getCheckoutTemplate: () => null }); let browser = 0;
  f.adapter._purchaseUnlocked = async () => { browser++; };
  try { await assert.rejects(f.adapter.purchase(product, { action: 'checkout' }), (error) => error.purchaseStatus === 'needs_setup'); assert.equal(browser, 0); }
  finally { await f.close(); }
});

test('互動登入遇到 403 或連線逾時，保留視窗與憑證且不誤報登出', async () => {
  const f = await fixture(); let status = 403; let closed = 0; let saves = 0;
  const context = { newPage: async () => page, close: async () => { closed++; },
    storageState: async (opts) => { if (opts?.path) saves++; return tokenState(jwt(9999999999)); },
    request: { get: async () => { if (status === 'timeout') throw new Error('timeout'); return response(status, status === 200 ? { id: 1 } : {}); } } };
  const page = { context: () => context, isClosed: () => false, url: () => 'https://www.eslite.com/member', once: () => {} };
  f.adapter._context = async () => context; f.adapter._login = async () => true;
  f.adapter.loginRequestFactory = { newContext: async () => ({ get: context.request.get, dispose: async () => {} }) };
  try {
    assert.equal((await f.adapter.testLogin()).pending, true);
    assert.equal(f.adapter.loginState, 'unknown'); assert.equal(closed, 0);
    let result = await f.adapter.completeLogin();
    assert.equal(result.pending, true); assert.match(result.message, /403/);
    assert.equal(f.adapter.loginState, 'unknown'); assert.equal(saves, 0);
    status = 'timeout'; result = await f.adapter.completeLogin();
    assert.match(result.message, /連線失敗/); assert.equal(f.adapter.loginState, 'unknown');
    status = 401; await f.adapter.completeLogin(); assert.equal(f.adapter.loginState, 'needs_login');
    status = 200; result = await f.adapter.completeLogin();
    assert.equal(result.ok, true); assert.equal(f.adapter.loginState, 'ready'); assert.equal(saves, 1); assert.equal(closed, 1);
  } finally { await f.close(); }
});

test('誠品帳號列固定顯示登入檢查設定，不受設定收合影響', async () => {
  const { load } = await import('cheerio');
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const $ = load(source.slice(source.indexOf('<!doctype html>'), source.indexOf('</html>') + 7));
  for (const slot of ['A', 'B', 'C']) {
    const card = $(`#eslite-account-${slot}-card`);
    assert.equal(card.find('.funbox-account-head .eslite-login-action').length, 1);
    assert.equal(card.find('.funbox-account-head .eslite-check-action').length, 1);
    assert.equal(card.find('.eslite-account-body button').length, 2);
  }
  assert.match(source, /#eslite-account-list\{grid-template-columns:minmax\(0,1fr\)/);
});

test('自動登入先查會員 API，有效憑證不啟動瀏覽器，403 不觸發重登', async () => {
  let status = 200, launches = 0;
  const f = await fixture({ autoLoginEnabled: true, apiSessionVerifier: async () => ({ ok: status === 200, loggedIn: status === 200 ? true : null, status }),
    persistentContextLauncher: async () => { launches++; throw new Error('不得開瀏覽器'); } });
  try {
    assert.equal((await f.adapter.testLogin()).ok, true); assert.equal(launches, 0);
    status = 403; assert.equal((await f.adapter.testLogin()).ok, false);
    assert.equal(f.adapter.loginState, 'unknown'); assert.equal(launches, 0);
  } finally { await f.close(); }
});

test('會員 API 確認成功後清除先前人工驗證旗標，不把登入就緒誤當結帳就緒', async () => {
  const f = await fixture({ autoLoginEnabled: true,
    apiSessionVerifier: async () => ({ ok: true, loggedIn: true, status: 200 }) });
  try {
    await f.adapter.localSessionLoad;
    f.adapter.manualLoginRequired = true;
    f.adapter.loginState = 'needs_login';
    await f.adapter.verifyStoredSession({ loginOnly: true });
    assert.equal(f.adapter.loginState, 'ready');
    assert.equal(f.adapter.manualLoginRequired, false);
    assert.equal(f.adapter._apiReady(), false);
  } finally { await f.close(); }
});

test('自動登入即使 interactive 也只送一次表單，獨立會員 API 驗證後才保存', async () => {
  const f = await fixture({ autoLoginEnabled: true }); let clicks = 0, saves = 0, token = '';
  const context = { storageState: async (opts) => { if (opts?.path) saves++; return tokenState(token); },
    request: { get: async () => { throw new Error('不應使用瀏覽器綁定 request'); } } };
  const locator = { first() { return this; }, count: async () => 1, isVisible: async () => true,
    waitFor: async () => {}, fill: async () => {}, innerText: async () => '', click: async () => { clicks++; token = jwt(9999999999); } };
  const page = { context: () => context, goto: async () => {}, url: () => 'https://www.eslite.com/login', locator: () => locator, waitForFunction: async () => {} };
  f.adapter.loginRequestFactory = { newContext: async () => ({ get: async () => response(200, { id: 1 }), dispose: async () => {} }) };
  try { assert.equal(await f.adapter._login(page, context, { interactive: true }), true); assert.equal(clicks, 1); assert.equal(saves, 1); }
  finally { await f.close(); }
});

test('官方人機驗證只回報人工處理，不填密碼、不按登入', async () => {
  const f = await fixture({ autoLoginEnabled: true }); let fills = 0;
  const context = { storageState: async () => tokenState('') };
  const locator = { innerText: async () => 'Sorry, you have been blocked', fill: async () => { fills++; } };
  const page = { context: () => context, goto: async () => {}, locator: () => locator };
  try { await assert.rejects(f.adapter._login(page, context), (e) => e.purchaseStatus === 'human_required'); assert.equal(fills, 0); }
  finally { await f.close(); }
});

test('手動登入模式只預填，不自動送出帳密或保存未驗證 session', async () => {
  const f = await fixture({ autoLoginEnabled: true }); let clicks = 0, saves = 0, fills = 0;
  const context = { storageState: async opts => { if (opts?.path) saves++; return tokenState(''); } };
  const locator = { first() { return this; }, count: async () => 1, isVisible: async () => true,
    waitFor: async () => {}, fill: async () => { fills++; }, innerText: async () => '', click: async () => { clicks++; } };
  const page = { context: () => context, goto: async () => {}, url: () => 'https://www.eslite.com/login', locator: () => locator };
  try {
    f.adapter.manualLoginRequired = true; f.adapter.accountPreparationState = 'human_required';
    await assert.rejects(f.adapter._login(page, context, { interactive: true, manualOnly: true }), e => e.purchaseStatus === 'needs_login');
    assert.equal(fills, 2); assert.equal(clicks, 0); assert.equal(saves, 0);
    assert.equal(f.adapter.manualLoginRequired, false); assert.equal(f.adapter.accountPreparationState, 'retry_pending');
    assert.equal(f.adapter.sessionRecoveryState, 'interactive');
  } finally { await f.close(); }
});

test('手動入口不被背景冷卻擋住；忙碌時保留明確要求的專用視窗', async () => {
  let launches = 0, closes = 0, kept;
  const f = await fixture({ autoLoginEnabled: true });
  const context = { newPage: async () => ({}), close: async () => { closes++; } };
  f.adapter._loginContext = async headless => { assert.equal(headless, false); launches++; return context; };
  f.adapter.sessionRecoveryRunner = async () => assert.fail('manual entry must not start headless recovery');
  f.adapter.sessionRecoveryAfterMs = Date.now() + 900000; f.adapter.manualLoginRequired = true;
  f.adapter._login = async (_page, _context, options) => { assert.equal(options.manualOnly, true);
    throw Object.assign(new Error('系統忙碌'), { purchaseStatus: 'login_busy' }); };
  f.adapter._keepInteractiveLogin = async options => { kept = options; return { ok: false, pending: true }; };
  try {
    assert.equal((await f.adapter.testLogin({ manualOnly: true })).pending, true);
    assert.equal(launches, 1); assert.equal(closes, 0); assert.equal(kept.context, context);
    assert.equal(f.adapter.loginState, 'unknown'); assert.equal(f.adapter.manualLoginRequired, false);
    await assert.rejects(f.adapter.testLogin({ manualOnly: true, interactive: false }), e => e.purchaseStatus === 'needs_setup');
  } finally { await f.close(); }
});

test('人工登入捕获 session 後，先關閉視窗再啟動帳號資料準備', async () => {
  const f = await fixture(); const events = []; let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const context = { storageState: async () => { events.push('persist'); }, close: async () => { events.push('close'); } };
  const page = { url: () => 'https://www.eslite.com/member', once: () => {} };
  try {
    await f.adapter._keepInteractiveLogin({ context, page, label: 'mock', sessionFile: f.adapter.sessionFile,
      error: new Error('pending'), watchSameUrl: true, checkIntervalMs: 5, validate: async () => true,
      onValidated: () => { events.push('validated'); }, onAfterClose: () => { events.push('prepare'); finish(); } });
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('watcher did not validate')), 1000))]);
    assert.deepEqual(events, ['persist', 'validated', 'close', 'prepare']);
  } finally { await f.close(); }
});

test('失效才背景更新：更新不清車，且冷卻期不重複送帳密', async () => {
  let launches = 0, probes = 0;
  const f = await fixture({ autoLoginEnabled: true,
    apiSessionVerifier: async () => ({ ok: ++probes > 1, loggedIn: probes > 1 }),
    sessionRecoveryRunner: async () => { launches++; },
    apiMaintenanceRunner: async () => { throw new Error('登入更新不可清車'); } });
  try {
    assert.equal((await f.adapter.testLogin()).ok, true); assert.equal(launches, 1);
    await assert.rejects(f.adapter._recoverApiSession(), (e) => e.purchaseStatus === 'unknown'); assert.equal(launches, 1);
  } finally { await f.close(); }
});

test('心跳發現 401 後只做一次背景登入，遇人工驗證後不反覆重試', async () => {
  let launches = 0, alerts = 0;
  const f = await fixture({ autoLoginEnabled: true,
    apiContextFactory: async () => { throw Object.assign(new Error('expired'), { purchaseStatus: 'needs_login' }); },
    sessionRecoveryRunner: async () => { launches++; throw Object.assign(new Error('需人工驗證'), { purchaseStatus: 'human_required' }); },
    onSessionProblem: () => { alerts++; } });
  try {
    await f.adapter.verifyStoredSession(); assert.equal(f.adapter.manualLoginRequired, true); assert.equal(alerts, 1);
    f.adapter.sessionRecoveryAfterMs = 0; await f.adapter.verifyStoredSession(); assert.equal(launches, 1); assert.equal(alerts, 1);
  } finally { await f.close(); }
});

test('API-only 安全驗收不加車、不送單、不開網頁', async () => {
  let reads = 0;
  const f = await fixture({ apiMaintenanceRunner: async (_file, opts) => { assert.equal(opts.clearCart, false); reads++; return { ok: true, loggedIn: true }; } });
  f.adapter._purchaseUnlocked = async () => { throw new Error('不得開網頁'); };
  try { const result = await f.adapter.purchase(product, { verifyOnly: true, payment: 'seven_cod' }); assert.equal(result.status, 'api_verified'); assert.equal(reads, 1); }
  finally { await f.close(); }
});

test('超過六秒仍可在安全窗口取得訂單，一款一單須核對全車', async () => {
  let clock = 0; const calls = [];
  const api = { get: async () => { calls.push('cart'); return response(200, { cart: { cart_items: calls.includes('/api/v2/cart/items') ? [{ product_guid: product.id, qty: 1 }] : [] } }); },
    post: async (url) => { calls.push(url); if (url.includes('/cart/items')) { clock = 7000; return response(200, { product_guid: product.id, response_quantity: 1 }); } clock = 9500; return response(200, { order_id: 'MOCK-ORDER' }); } };
  const result = await purchaseEsliteViaApi({ product, settings: { action: 'checkout', quantity: 1, strictSingleProductOrder: true }, checkoutTemplate: template, apiContext: api, prevalidated: true, now: () => clock });
  assert.equal(result.status, 'ordered'); assert.equal(result.timings.targetMet, false); assert.equal(result.timings.deadlineMet, true);
  assert.deepEqual(calls, ['cart', '/api/v2/cart/items', 'cart', '/api/v1/orders/checkout']);
});

test('購物車殘留別款時絕不混單；安全窗口用完不送單', async () => {
  let submits = 0;
  let added=false;
  const api = { get: async () => response(200, { cart: { cart_items: added ? [{ product_guid: product.id, qty: 1 }, { product_guid: 'other', qty: 1 }] : [] } }),
    post: async (url) => { added=true;if (url.includes('checkout')) submits++; return response(200, { product_guid: product.id, response_quantity: 1 }); } };
  await assert.rejects(purchaseEsliteViaApi({ product, settings: { action: 'checkout', strictSingleProductOrder: true }, checkoutTemplate: template, apiContext: api, prevalidated: true }), /殘留商品/);
  assert.equal(submits, 0);
  let clock = 0;
  added=false;
  api.post = async () => { clock = 30001; return response(200, { product_guid: product.id, response_quantity: 1 }); };
  await assert.rejects(purchaseEsliteViaApi({ product, settings: { action: 'checkout' }, checkoutTemplate: template, apiContext: api, prevalidated: true, now: () => clock }), (e) => e.purchaseStatus === 'deadline_exceeded');
});

const monitoringFixture = () => new ShoppingSiteMonitor({ state: { data: {}, save: async () => {} }, getTargets: () => [], notify: async () => {}, esliteApiOnly: true });
test('公開監控 API 不帶購買 token 或 auth cookie，與私人會員檢查隔離', async () => {
  const f = await fixture(); let captured;
  const m = new ShoppingSiteMonitor({ state: { data: {} }, getTargets: () => [], notify: async () => {}, esliteApiOnly: true,
    esliteApiSessionFile: f.adapter.sessionFile, esliteRequestFactory: { newContext: async options => { captured = options; return { dispose: async () => {} }; } } });
  try { await m.ensureEsliteApiContext(); assert.equal(captured.extraHTTPHeaders.authorization, undefined); assert.ok(captured.storageState.cookies.every(x => !x.name.startsWith('auth.'))); }
  finally { await m.close(); await f.close(); }
});
test('策展 API 明確不存在才顯示 404，不開瀏覽器', async () => {
  const m = monitoringFixture(); m.newPage = async () => { throw new Error('不得開網頁'); };
  m.requestEslitePublicApi = async () => ({ ok: false, status: 404, json: async () => ({ message: 'Book Exhibit Not Found', code: '404' }) });
  try { const products = await m.loadEsliteExhibitProducts('https://www.eslite.com/exhibitions/CU202608-00061'); assert.equal(products.discoveryPage.isLive, false); assert.equal(products.discoveryPage.unavailableReason, 'page_not_found');
    m.requestEslitePublicApi = async () => ({ ok: false, status: 404, json: async () => ({ message: 'route missing' }) });
    await assert.rejects(m.loadEsliteExhibitProducts('https://www.eslite.com/exhibitions/CU202608-00061'), /HTTP 404/);
  } finally { await m.close(); }
});

test('API-only 搜尋缺少保存路線仍直接查官方 Holmes，不啟動搜尋頁', async () => {
  const m = monitoringFixture(); const requests = [];
  m.newPage = async () => { throw new Error('不得開網頁'); };
  m.requestEslitePublicApi = async (url) => { requests.push(new URL(url)); return { ok: true, status: 200, json: async () => ({ results: [], page_size: 20, total_size: 0 }) }; };
  try { await m.loadEsliteKeywordProducts({ id: 'mock', name: 'mock', enabled: true, keywords: ['beyblade'], discoveryUrls: [] });
    assert.equal(requests.length, 2); assert.equal(requests[0].host, 'holmes.eslite.com'); assert.equal(requests[0].searchParams.get('q'), 'beyblade');
  } finally { await m.close(); }
});

test('單品 API 404／格式變更只保留未知，不啟動商品頁', async () => {
  const m = monitoringFixture(); m.newPage = async () => { throw new Error('不得開網頁'); };
  m.requestEslitePurchaseStatus = async () => ({ ok: false, status: 404, dispose: async () => {} });
  const item = { ...product, url: `https://www.eslite.com/product/${product.id}`, available: null };
  try { const result = await m.verifyEsliteProduct(item); assert.equal(result.available, null); }
  finally { await m.close(); }
});

test('五款分成五張獨立訂單，A 卡住時 B／C 繼續完成其餘款式', async () => {
  const multi = new MultiAccountEslitePurchaseAdapter({ dataDir: os.tmpdir(), apiOnly: true, getAccounts: () => ['A', 'B', 'C'].map(slot => ({ slot, enabled: true, account: 'mock', password: 'mock' })) });
  let release; const gate = new Promise(resolve => { release = resolve; }); const done = [];
  for (const [slot, adapter] of Object.entries(multi.adapters)) {
    adapter._apiReady = () => true; adapter.loginState = 'ready';
    adapter.purchase = async (item) => { if (slot === 'A') await gate; done.push({ slot, id: item.id }); return { status: 'ordered', orderId: `MOCK-${item.id}` }; };
  }
  const tasks = Array.from({ length: 5 }, (_, i) => multi.purchase({ ...product, id: String(i + 1) }, { payment: 'seven_cod' }));
  try {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(done.length, 4); assert.ok(done.every(x => x.slot !== 'A'));
    release(); const results = await Promise.all(tasks); assert.equal(new Set(results.map(x => x.orderId)).size, 5);
  } finally { release(); await Promise.allSettled(tasks); await multi.close(); }
});
