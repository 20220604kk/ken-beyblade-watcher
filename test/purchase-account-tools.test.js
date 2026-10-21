import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { AutoPurchaseCoordinator, EslitePurchaseAdapter, FunboxPurchaseAdapter, maintainEsliteApiSession } from '../src/auto-purchase.js';
import { createDashboard } from '../src/dashboard.js';
import { funboxAccountRowHtml } from '../src/funbox-purchase-ui.js';
import { esliteAccountRowHtml } from '../src/eslite-purchase-ui.js';

const response = body => ({ ok: () => true, status: () => 200, json: async () => body, dispose: async () => {} });
function coordinator(platform, adapter) {
  const multi = { adapters: { A: adapter }, accountPurchaseTails: platform === 'funbox' ? new Map() : undefined,
    busySlots: platform === 'eslite' ? new Set() : undefined, _syncAccounts() {} };
  return { adapters: { [platform]: multi }, _schedule: async () => {},
    accountAction: AutoPurchaseCoordinator.prototype.accountAction, clearAllAccountCarts: AutoPurchaseCoordinator.prototype.clearAllAccountCarts };
}
const tool = (c, platform, action = 'clear-cart', accountSlot = 'A') => AutoPurchaseCoordinator.prototype.accountAction.call(c, { platform, accountSlot, action });
const idle = extra => ({ credentialsStatus: () => ({ ready: true }), activePurchaseHold: () => null, ...extra });

test('FUNBOX clear-all skips the personally assigned special account without opening or clearing it',async()=>{
  let mutations=0;const c=coordinator('funbox',idle({_acquireWarmWorker:async()=>{mutations++;}}));
  c._storage=()=>({externalAccountReservations:{A:{taskKind:'funbox_app_redemption'}}});
  await assert.rejects(tool(c,'funbox','open-browser'),/特別任務/);
  const result=await tool(c,'funbox','clear-all-carts',null);
  assert.equal(result.skipped,1);assert.equal(mutations,0);
});

test('dashboard account tools require local same-origin POST and return action feedback', async () => {
  const seen = [];
  const server = createDashboard({ port: 0, log: () => {}, getStatus: () => ({}), onPurchaseAccountAction: async body => {
    seen.push(body); return { ok: true, message: 'mock completed' };
  } });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const body = JSON.stringify({ platform: 'eslite', action: 'clear-all-carts' });
    const post = (headers, payload = body) => fetch(origin + '/auto-purchase/account-action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ Origin: 'https://untrusted.invalid' })).status, 403);
    const result = await post({ Origin: origin }); assert.equal(result.status, 200);
    assert.equal((await result.json()).message, 'mock completed');
    assert.equal((await post({ Origin: origin }, JSON.stringify({ platform: 'eslite', accountSlot: 'E', action: 'clear-cart' }))).status, 400);
    assert.deepEqual(seen, [JSON.parse(body)]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('one clear-all covers configured A through N, skips protected slots, and reports partial failure honestly', async () => {
  let release;
  const a = idle({ maintainSession: async () => { await new Promise(r => release = r); return { ok: true, removed: 2 }; } });
  const c = coordinator('eslite', a);
  c.adapters.eslite.adapters.B = idle({ activePurchaseHold: () => ({ productId: 'unknown' }), maintainSession: () => assert.fail('held cart') });
  c.adapters.eslite.adapters.C = idle({ maintainSession: async () => { throw new Error('mock timeout'); } });
  c.adapters.eslite.adapters.N = idle({ maintainSession: async () => ({ ok: true, removed: 0 }) });
  c.adapters.eslite.adapters.X = { credentialsStatus: () => ({ ready: false }) };
  const resultPromise = tool(c, 'eslite', 'clear-all-carts', null);
  assert.equal(c.adapters.eslite.busySlots.has('A'), true);
  release(); const result = await resultPromise;
  assert.equal(result.ok, false); assert.equal(result.cleared, 2); assert.equal(result.skipped, 1); assert.equal(result.failed, 1); assert.equal(result.removed, 2);
  assert.deepEqual(result.results.map(item => [item.accountSlot, item.status]), [['A','cleared'], ['B','skipped'], ['C','failed'], ['N','cleared']]);
  assert.match(result.message, /2\/4.*B：.*C：/); assert.equal(c.adapters.eslite.busySlots.size, 0);
  await assert.rejects(c.clearAllAccountCarts('other'), /不支援/);
});

test('phone numbers are native links, not additional action buttons; dynamic accounts also get them', () => {
  for (const [platform, render] of [['eslite', esliteAccountRowHtml], ['funbox', funboxAccountRowHtml]]) {
    const html = render('N');
    assert.match(html, new RegExp(`id="${platform}-sheet-browser-N" class="account-browser-link" href=`));
    assert.match(html, /event.preventDefault\(\);purchaseAccountAction\(this,.*open-browser/);
    assert.doesNotMatch(html, /清空購物車|>開啟瀏覽器<|data-account-tool/);
  }
});

test('Eslite manual clear reserves only this account, verifies result, releases on success', async () => {
  let finish;
  const a = idle({ maintainSession: async options => { assert.equal(options.clearCart, true); await new Promise(r => finish = r); return { ok: true, removed: 2 }; } });
  const c = coordinator('eslite', a), first = tool(c, 'eslite');
  assert.equal(c.adapters.eslite.busySlots.has('A'), true);
  await assert.rejects(tool(c, 'eslite'), /正在執行/);
  finish(); assert.equal((await first).removed, 2);
  assert.equal(c.adapters.eslite.busySlots.size, 0);
});

for (const platform of ['eslite', 'funbox']) {
  test(`${platform} rejects invalid, busy, held and browser-owned cart before mutation`, async () => {
    let mutations = 0;
    const a = idle({ maintainSession: async () => { mutations++; }, _acquireWarmWorker: async () => { mutations++; } });
    const c = coordinator(platform, a);
    await assert.rejects(tool(c, platform, 'clear-cart', '../A'), /不正確/);
    a.accountBusy = 1; await assert.rejects(tool(c, platform), /正在執行/); a.accountBusy = 0;
    a.activePurchaseHold = () => ({ productId: 'unknown' }); await assert.rejects(tool(c, platform), /禁止清車/);
    a.activePurchaseHold = () => null; a.accountBrowser = {}; await assert.rejects(tool(c, platform), /禁止清車/);
    assert.equal(mutations, 0);
  });
}

test('manual clear failure releases lock but blocks purchase until a successful manual clear', async () => {
  const a = idle({ maintainSession: async () => ({ ok: false, error: 'timeout' }) }), c = coordinator('eslite', a);
  await assert.rejects(tool(c, 'eslite'), /timeout/);
  assert.equal(a.cartActionUncertain, true); assert.equal(c.adapters.eslite.busySlots.size, 0);
  a.maintainSession = async () => ({ ok: true, removed: 0 }); await tool(c, 'eslite');
  assert.equal(a.cartActionUncertain, false);
});

test('Eslite manual clear uses official DELETE and must reread empty, normal maintenance never deletes', async () => {
  let items = [{ cart_item_id: 11 }], deletes = 0;
  const api = { get: async url => response(url.includes('/member?') ? { id: 1 } : { cart: { cart_items: items } }),
    delete: async () => { deletes++; items = []; return response({}); } };
  await maintainEsliteApiSession('unused', { apiContext: api }); assert.equal(deletes, 0);
  const result = await maintainEsliteApiSession('unused', { apiContext: api, clearCart: true });
  assert.equal(result.removed, 1); assert.equal(deletes, 1); assert.equal(result.cartEmpty, true);
  items = [{ cart_item_id: 12 }]; api.delete = async () => response({});
  await assert.rejects(maintainEsliteApiSession('unused', { apiContext: api, clearCart: true }), /尚未確認空車/);
});

test('FUNBOX manual clear is API-only and uses its account worker', async () => {
  const calls = [], token = 'a'.repeat(32), cart = 'https://shop.funbox.com.tw/carts/' + token;
  let cleared = false;
  const api = { get: async url => {
    calls.push(url);
    if (url.endsWith('/cart')) return { status: () => 302, headers: () => ({ location: cleared ? '/account/index' : cart }), text: async () => '', dispose: async () => {} };
    return { status: () => 200, headers: () => ({}), text: async () => cleared ? '<a href="/account/logout">logout</a>'
      : '<meta name="csrf-token" content="mock"><script>window.lineItems=[{"variant_id":1,"type":"normal","quantity":1}];</script>', dispose: async () => {} };
  }, post: async url => { calls.push(url); cleared = true; return { ok: () => true, status: () => 200, text: async () => '{}', dispose: async () => {} }; } };
  let released = false;
  const a = idle({ _acquireWarmWorker: async options => { assert.equal(options.apiOnly, true); return { context: { request: api } }; },
    _ensureWarmWorkerLogin: async () => {}, _releaseWarmWorker: async () => { released = true; } });
  const c = coordinator('funbox', a), result = await tool(c, 'funbox');
  assert.equal(result.removed, 1); assert.equal(released, true); assert.equal(c.adapters.funbox.accountPurchaseTails.size, 0);
  assert.equal(calls.filter(url => url.endsWith('/update_line_item')).length, 1);
});

test('browser opens same-slot saved state separately, reuses window and resumes on close', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-browser-'));
  let launches = 0, fronts = 0, resumed = 0, newContextOptions, goto;
  const browser = new EventEmitter(), page = new EventEmitter();
  browser.newContext = async opts => { newContextOptions = opts; return { newPage: async () => page }; };
  browser.close = async () => browser.emit('disconnected');
  page.isClosed = () => false; page.bringToFront = async () => fronts++;
  page.goto = async url => { goto = url; };
  const a = new FunboxPurchaseAdapter({ dataDir: dir, accountSlot: 'D', getCredentials: () => ({ account: 'mock', password: 'mock' }),
    browserLauncher: async opts => { launches++; assert.equal(opts.headless, false); return browser; } });
  try {
    await fs.mkdir(path.dirname(a.sessionFile), { recursive: true }); await fs.writeFile(a.sessionFile, '{}');
    await a.openAccountBrowser(() => resumed++); await a.openAccountBrowser();
    assert.equal(launches, 1); assert.equal(fronts, 1); assert.equal(newContextOptions.storageState, a.sessionFile);
    assert.equal(goto, 'https://shop.funbox.com.tw/account'); assert.equal(a.runtimeStatus().accountBrowserOpen, true);
    page.emit('close'); await Promise.resolve(); assert.equal(a.accountBrowser, null); assert.equal(resumed, 1);
  } finally { await a.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('both adapters reject purchases while their browsing window owns the cart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-browser-lock-'));
  for (const Constructor of [FunboxPurchaseAdapter, EslitePurchaseAdapter]) {
    const a = new Constructor({ dataDir: dir, getCredentials: () => ({ account: 'mock', password: 'mock' }) });
    try { a.accountBrowser = { browser: { close: async () => {} } }; await assert.rejects(a.purchase({ id: 'p' }, {}), /瀏覽器使用中/); }
    finally { await a.close(); }
  }
  await fs.rm(dir, { recursive: true, force: true });
});
