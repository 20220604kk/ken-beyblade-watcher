import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EdionBrowserBridge, normalizeEdionProducts } from '../src/edion-browser-bridge.js';
import { JapanAuctionMonitor } from '../src/japan-auctions.js';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const target = { id: 'edion', sourceType: 'edion', siteName: 'EDION', name: '愛電王', transport: 'chrome-bridge', enabled: true,
  url: 'https://www.edion.com/item_list.html?keyword=beyblade+x' };
const product = { url: 'https://www.edion.com/detail.html?p_cd=00086148887', title: 'BEYBLADE X CX-13', stock: 77, available: true, price: '¥2,200' };
function fixture() {
  let now = Date.parse('2026-10-08T00:00:00Z'); let enabled = true;
  const state = { data: {}, save: async () => {} }; const alerts = []; const ingest = [];
  const monitor = { ingestBrowserProducts: async (...args) => { ingest.push(args); return { checkedProducts: args[1].length }; } };
  const bridge = new EdionBrowserBridge({ dataDir: '/tmp/data', state, monitor, getTargets: () => [target], enabled: () => enabled,
    intervalSeconds: () => 20, now: () => now, notify: async text => alerts.push(text) });
  const plan = () => { now += 30_000; return bridge.plans()[0]; };
  const report = (plan, health = 'ready', items = [product]) => bridge.ingest({ id: target.id, scanId: plan.scanId, observation: { url: target.url, health, items } });
  return { state, alerts, ingest, bridge, plan, report, advance: ms => { now += ms; }, pause: () => { enabled = false; } };
}
test('愛電王配對綁定擴充來源，錯誤 token 與重配後舊 token 都拒絕', async () => {
  const f = fixture(); const { token } = await f.bridge.pair();
  assert.throws(() => f.bridge.authenticate({ headers: { origin, authorization: 'Bearer wrong' } }), /配對無效/);
  f.bridge.authenticate({ headers: { origin, authorization: 'Bearer ' + token } });
  assert.equal(f.bridge.status().connected, true);
  assert.throws(() => f.bridge.authenticate({ headers: { origin: 'chrome-extension://' + 'b'.repeat(32), authorization: 'Bearer ' + token } }), /配對無效/);
  assert.equal(JSON.stringify(f.bridge.status()).includes(token), false);
  await f.bridge.pair();
  assert.throws(() => f.bridge.authenticate({ headers: { origin, authorization: 'Bearer ' + token } }), /配對無效/);
});
test('愛電王觀測不會無限延長下次重整時間，正常最低 60 秒', async () => {
  const f = fixture(); const first = f.plan(); assert.equal(first.action, 'reload'); await f.report(first);
  const nextReload = f.bridge.root().runtime.edion.nextReloadAt;
  const observe = f.plan(); assert.equal(observe.action, 'observe'); await f.report(observe);
  assert.equal(f.bridge.root().runtime.edion.nextReloadAt, nextReload);
  const reload = f.plan(); assert.equal(reload.action, 'reload');
});
test('人工驗證不重整、跨重啟同次只提醒一次，實際商品恢复後自動恢復', async () => {
  const f = fixture(); await f.report(f.plan(), 'verification_required', []);
  assert.equal(f.alerts.length, 1);
  const observe = f.plan(); assert.equal(observe.action, 'observe'); await f.report(observe, 'verification_required', []);
  assert.equal(f.alerts.length, 1); assert.equal(f.ingest.length, 0);
  // A new service instance uses the same persisted episode rather than sending again.
  const reboot = fixture(); reboot.state.data = structuredClone(f.state.data);
  reboot.advance(120_000); await reboot.report(reboot.plan(), 'verification_required', []);
  assert.equal(reboot.alerts.length, 0);
  await f.report(f.plan()); assert.equal(f.bridge.root().runtime.edion.health, 'ready');
  assert.equal(f.bridge.root().runtime.edion.verificationEpisode, null);
  assert.equal(f.ingest.length, 1);
  await f.report(f.plan(), 'verification_required', []); assert.equal(f.alerts.length, 2);
});
test('提醒送出結果不明不會造成同次阻擋反覆推播', async () => {
  const f = fixture(); let sends = 0;
  f.bridge.notify = async () => { sends++; throw new Error('timeout'); };
  await f.report(f.plan(), 'verification_required', []);
  await f.report(f.plan(), 'verification_required', []);
  assert.equal(sends, 1); assert.equal(f.bridge.root().runtime.edion.alertStatus, 'failed_or_uncertain');
});
test('停用後不發計畫、已取得的結果也不更新基線', async () => {
  const f = fixture(); const plan = f.plan(); f.pause();
  assert.deepEqual(f.bridge.plans(), []); assert.equal(f.bridge.status('edion').state, 'paused');
  assert.deepEqual(await f.report(plan), { ignored: true }); assert.equal(f.ingest.length, 0);
});
test('未讀到商品、錯誤網址與偽造回報不會顯示監控恢復', async () => {
  const f = fixture(); const plan = f.plan();
  await assert.rejects(f.report(plan, 'ready', []), /未讀到完整商品/);
  assert.equal(f.bridge.root().runtime.edion, undefined);
  const next = f.plan();
  await assert.rejects(f.bridge.ingest({ id: target.id, scanId: next.scanId, observation: { url: 'https://evil.test/', health: 'ready', items: [product] } }), /非愛電王/);
  await assert.rejects(f.report({ scanId: 'fake' }), /未經排程/);
  assert.equal(f.ingest.length, 0);
});
test('商品欄位嚴格正規化，不接收 Cookie、外站網址或重複編號', () => {
  const clean = normalizeEdionProducts([{ ...product, cookies: 'SECRET', token: 'SECRET', html: 'SECRET', imageUrl: 'javascript:evil()' }])[0];
  assert.equal(JSON.stringify(clean).includes('SECRET'), false); assert.equal(clean.imageUrl, '');
  assert.throws(() => normalizeEdionProducts([{ ...product, url: 'https://evil.test/detail.html?p_cd=123456' }]), /非愛電王/);
  assert.throws(() => normalizeEdionProducts([product, product]), /編號或連結異常/);
  assert.equal(normalizeEdionProducts([{ ...product, stock: null, available: null }])[0].available, undefined);
});
test('連接器斷線與過期觀測不會繼續显示正常', async () => {
  const f = fixture(); const { token } = await f.bridge.pair();
  f.bridge.authenticate({ headers: { origin, authorization: 'Bearer ' + token } });
  await f.report(f.plan()); assert.equal(f.bridge.status('edion').state, 'ready');
  f.advance(100_000); assert.equal(f.bridge.status('edion').state, 'disconnected');
});
test('愛電王 Chrome 模式禁止呼叫背景瀏覽器，仍沿用既有基線與去重', async () => {
  const state = { data: { commerce: { japanAuctions: { targets: { edion: { initialized: true, lastRawProductCount: 1,
    products: { '00086148887': { ...product, id: '00086148887', available: false } } } }, recentNotificationsSeededAt: 'done' } } }, save: async () => {} };
  let sent = 0;
  const monitor = new JapanAuctionMonitor({ dataDir: '', state, getTargets: () => [target], notify: async () => { sent++; } });
  monitor.load = async () => { throw new Error('must not open browser'); };
  assert.equal((await monitor.scanTarget(target)).skipped, true);
  assert.equal((await monitor.ingestBrowserProducts(target, normalizeEdionProducts([product]))).restocked, 1);
  await monitor.ingestBrowserProducts(target, normalizeEdionProducts([product])); assert.equal(sent, 1);
  // Partial DOM cards and unknown availability preserve known products, never invent sold-out.
  await monitor.ingestBrowserProducts(target, normalizeEdionProducts([{ ...product, stock: null, available: null }]));
  assert.equal(monitor.status(target).products['00086148887'].available, true);
  const other = { ...product, url: 'https://www.edion.com/detail.html?p_cd=00085029323', title: 'BEYBLADE X BX-10', available: false };
  await monitor.ingestBrowserProducts(target, normalizeEdionProducts([other]));
  await monitor.ingestBrowserProducts(target, normalizeEdionProducts([other]));
  assert.equal(monitor.status(target).products['00086148887'].available, true);
});
test('本機 HTTP 路由拒絕跨站配對，擴充回報需 token，CORS 不使用萬用來源', async () => {
  const f = fixture();
  const server = http.createServer((req, res) => void f.bridge.handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const request = (endpoint, source, token) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: '{}' });
    assert.equal((await request('/edion-browser/pair', 'https://evil.test')).status, 400);
    const paired = await (await request('/edion-browser/pair', base)).json(); assert.match(paired.token, /^[a-f0-9]{64}$/);
    assert.equal((await request('/edion-browser/bridge/poll', origin)).status, 400);
    const response = await request('/edion-browser/bridge/poll', origin, paired.token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal((await response.json()).targets.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
