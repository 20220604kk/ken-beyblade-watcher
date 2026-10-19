import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeEsliteBrowserSession, esliteBrowserTokenExpiry } from '../src/eslite-browser-session.js';
import { EslitePurchaseAdapter } from '../src/auto-purchase.js';
import { createDashboard } from '../src/dashboard.js';

const jwt = exp => 'Bearer e30.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.fixture';
const expiry = () => Math.floor(Date.now() / 1000) + 86400;
const state = (exp = expiry()) => ({ cookies: [{ name: 'auth._token.prd', value: encodeURIComponent(jwt(exp)),
  domain: '.eslite.com', path: '/', secure: true, httpOnly: false, expires: exp, sameSite: 'Lax' }], origins: [] });
const reply = (status, body) => ({ status: () => status, ok: () => status === 200, json: async () => body, dispose: async () => {} });
async function fixture(t, { wrongAccount = false, unavailable = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eslite-browser-import-'));
  const sessionFile = path.join(dir, 'session.json');
  const old = JSON.stringify(state(1)); await fs.writeFile(sessionFile, old);
  const calls = [];
  const requestFactory = { async newContext() { return { async get(url) {
    calls.push(url);
    if (unavailable) return reply(503, {});
    return reply(200, url.includes('member_detail') ? { id: 'fixture-member', name: 'Fixture', account: wrongAccount ? 'other' : 'fixture-account' }
      : { id: 'fixture-member' });
  }, async dispose() {} }; } };
  const adapter = new EslitePurchaseAdapter({ dataDir: dir, sessionFile, apiOnly: true, autoLoginEnabled: true,
    loginRequestFactory: requestFactory, getCredentials: () => ({ account: 'fixture-account', password: 'fixture-password' }) });
  await adapter.localSessionLoad;
  t.after(async () => { await adapter.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, adapter, calls, old, sessionFile, requestFactory };
}

test('import allowlists first-party auth only; JWT expiry is unchanged, not extended', () => {
  const input = state();
  input.cookies.push({ name: 'auth._token.prd', value: 'foreign', domain: '.evil.test' },
    { name: 'tracking', value: 'unrelated', domain: '.eslite.com' });
  input.origins.push({ origin: 'https://www.amazon.co.jp', localStorage: [{ name: 'auth._token.prd', value: 'foreign' }] });
  const result = normalizeEsliteBrowserSession(input);
  assert.equal(result.state.cookies.length, 1); assert.equal(result.state.origins.length, 1);
  assert.equal(result.expiresAtMs, esliteBrowserTokenExpiry(input.cookies[0].value));
  assert.doesNotMatch(JSON.stringify(result.state), /unrelated|evil|amazon|foreign/);
  assert.throws(() => normalizeEsliteBrowserSession(state(1)), /過期/);
  assert.throws(() => normalizeEsliteBrowserSession({ cookies: [], origins: [] }), /憑證/);
});

test('same-account import checks member and member_detail, replaces file atomically, no cart/login writes', async t => {
  const f = await fixture(t); let closed = 0;
  f.adapter.interactiveLogin = { context: { async close() { closed++; } } };
  const result = await f.adapter.importBrowserSession(state());
  assert.equal(result.ok, true); assert.equal(f.adapter.loginState, 'ready'); assert.equal(closed, 1);
  assert.equal(f.adapter.interactiveLogin, null);
  assert.deepEqual(f.calls.map(p => p.split('?')[0]), ['/api/v2/member', '/api/v2/member_detail']);
  const saved = JSON.parse(await fs.readFile(f.sessionFile, 'utf8'));
  assert.ok(esliteBrowserTokenExpiry(saved.cookies[0].value) > Date.now());
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.adapter.runtimeStatus()), /Bearer|fixture-password|\.fixture/);
  assert.equal((await fs.readdir(f.dir)).some(n => n.endsWith('.tmp')), false);
  const reload = new EslitePurchaseAdapter({ dataDir: f.dir, sessionFile: f.sessionFile, apiOnly: true });
  await reload.localSessionLoad;
  assert.equal(reload.lastBrowserSessionImportedAt, f.adapter.lastBrowserSessionImportedAt); await reload.close();
});

test('wrong account, network failure, active order and busy account never overwrite session', async t => {
  for (const options of [{ wrongAccount: true }, { unavailable: true }, {}]) {
    const f = await fixture(t, options);
    if (!Object.keys(options).length) f.adapter.purchaseHold = { taskId: 'fixture-hold' };
    await assert.rejects(f.adapter.importBrowserSession(state()));
    assert.equal(await fs.readFile(f.sessionFile, 'utf8'), f.old);
    assert.equal(f.adapter.lastBrowserSessionImportedAt, '');
    f.adapter.purchaseHold = null;
  }
});

test('loopback import route rejects foreign Origin or missing marker, validates slot, returns no secret', async t => {
  let imports = 0;
  const server = createDashboard({ port: 0, getStatus: () => ({}), log() {},
    onImportEsliteBrowserSession: async body => { imports++; assert.equal(body.accountSlot, 'B'); return { ok: true, message: '同步成功' }; } });
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (headers, slot = 'B') => fetch(origin + '/auto-purchase/eslite/browser-session', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ accountSlot: slot, storageState: state() }) });
  assert.equal((await send({ Origin: 'https://www.eslite.com', 'x-local-session-import': '1' })).status, 403);
  assert.equal((await send({ Origin: origin })).status, 403);
  assert.equal((await send({ Origin: origin, 'x-local-session-import': '1' }, '../A')).status, 400);
  const result = await send({ Origin: origin, 'x-local-session-import': '1' });
  assert.equal(result.status, 200); assert.equal(imports, 1);
  assert.doesNotMatch(await result.text(), /Bearer|token|Cookie/);
});

test('proactive recovery without a newer expiry cannot falsely claim renewal', async t => {
  const f = await fixture(t); await fs.writeFile(f.sessionFile, JSON.stringify(state()));
  f.adapter.sessionRecoveryRunner = async () => {};
  f.adapter.apiSessionVerifier = async () => ({ ok: true, loggedIn: true });
  const oldExpiry = esliteBrowserTokenExpiry(state().cookies[0].value);
  await assert.rejects(f.adapter._recoverApiSession({ renewAfterExpiryMs: oldExpiry }), /未提供較新/);
});

test('near-expiry failure keeps valid API and verification flag; not one-second retries', async t => {
  const f = await fixture(t);
  const originalExpiry = Date.now() + 5 * 60000;
  f.adapter.lastTokenExpiresAtMs = originalExpiry;
  f.adapter.loginState = 'ready'; f.adapter.apiCartKnownEmpty = true;
  f.adapter.apiContextFactory = async () => ({ api: { async dispose() {} }, expiresAtMs: originalExpiry });
  // _ensureApiContext normally rereads local expiry, so use a same-scope stub.
  f.adapter._ensureApiContext = async () => ({});
  f.adapter.apiMaintenanceRunner = async () => ({ ok: true, loggedIn: true, cartEmpty: true });
  let attempts = 0;
  f.adapter.sessionRecoveryRunner = async () => { attempts++; f.adapter.lastTokenExpiresAtMs = 0;
    throw Object.assign(new Error('verification'), { purchaseStatus: 'human_required' }); };
  await f.adapter.verifyStoredSession();
  assert.equal(f.adapter.loginState, 'ready'); assert.equal(f.adapter.lastTokenExpiresAtMs, originalExpiry);
  assert.equal(f.adapter.manualLoginRequired, true); assert.equal(attempts, 1);
  await f.adapter.verifyStoredSession(); assert.equal(attempts, 1); assert.equal(f.adapter.manualLoginRequired, true);
  f.adapter.sessionHeartbeatEnabled = true; f.adapter._scheduleHeartbeat();
  assert.ok(Date.parse(f.adapter.nextVerifyAt) - Date.now() >= 59000);
});

test('proactive frontend probe never clicks logout or submits an unchanged working session', async t => {
  const f = await fixture(t); let stored = state();
  const exp = esliteBrowserTokenExpiry(stored.cookies[0].value);
  const ctx = { storageState: async () => stored };
  const body = { innerText: async () => '' };
  const page = { context: () => ctx, async goto() {}, locator: s => s === 'body' ? body : { count: async () => 0, nth() { return this; }, click: async () => assert.fail('no clicks') } };
  await assert.rejects(f.adapter._login(page, ctx, { renewAfterExpiryMs: exp }), /不登出/);
});

test('recovery pause survives restart using saved expiry; newer credentials clear old pause', async t => {
  const f = await fixture(t);
  const exp = expiry(); await fs.writeFile(f.sessionFile, JSON.stringify(state(exp)));
  f.adapter.lastTokenExpiresAtMs = 0; // Failed browser probe must not unbind the pause.
  f.adapter.manualLoginRequired = true;
  f.adapter.sessionRecoveryAfterMs = Date.now() + 60000;
  await f.adapter._persistLoginRecovery();
  const load = async () => {
    const a = new EslitePurchaseAdapter({ dataDir: f.dir, sessionFile: f.sessionFile, apiOnly: true });
    await a.localSessionLoad; return a;
  };
  const restored = await load();
  assert.equal(restored.manualLoginRequired, true);
  assert.equal(restored.sessionRecoveryState, 'manual_required'); await restored.close();
  await fs.writeFile(f.sessionFile, JSON.stringify(state(exp + 3600)));
  const renewed = await load(); assert.equal(renewed.manualLoginRequired, false); await renewed.close();
});
