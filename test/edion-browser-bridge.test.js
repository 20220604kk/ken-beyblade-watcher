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

test('新增愛電王90項分類頁沿用背景連接器，保留原搜尋頁暫停設定', async () => {
  const category = { ...target, id: 'japan-edion-beyblade-category-90',
    url: 'https://www.edion.com/item_list.html?c_cd=001039022001&c_def=1&d_sort=1&d_type=panel&d_num=90' };
  const received = [];
  const bridge = new EdionBrowserBridge({ dataDir: '.', state: { data: {}, save: async () => {} },
    monitor: { ingestBrowserProducts: async (...args) => { received.push(args); return { checkedProducts: 1 }; } },
    getTargets: () => [{ ...target, enabled: false }, category], enabled: () => true, intervalSeconds: () => 20 });
  const plans = bridge.plans(2);
  assert.equal(plans.length, 1); assert.equal(plans[0].id, category.id);
  assert.equal(plans[0].action, 'fetch');
  assert.equal(new URL(plans[0].url).searchParams.get('d_num'), '90');
  assert.equal(new URL(plans[0].url).searchParams.get('c_cd'), '001039022001');
  await bridge.ingest({ id: category.id, scanId: plans[0].scanId,
    observation: { url: category.url, fetched: true, health: 'ready', httpStatus: 200, items: [product] } });
  assert.equal(received.length, 1); assert.equal(received[0][0].id, category.id);
  assert.equal(bridge.plans(2).length, 0);
});
function fixture() {
  let now = Date.parse('2026-10-08T00:00:00Z'); let enabled = true;
  const state = { data: {}, save: async () => {} }; const alerts = []; const ingest = [];
  const monitor = { ingestBrowserProducts: async (...args) => { ingest.push(args); return { checkedProducts: args[1].length }; } };
  const bridge = new EdionBrowserBridge({ dataDir: '/tmp/data', state, monitor, getTargets: () => [target], enabled: () => enabled,
    intervalSeconds: () => 20, now: () => now, notify: async text => alerts.push(text) });
  const plan = () => { now = Math.max(now + 30_000, Date.parse(bridge.root().runtime.edion?.nextReloadAt || '') || 0); return bridge.plans()[0]; };
  const report = (plan, health = 'ready', items = [product]) => bridge.ingest({ id: target.id, scanId: plan.scanId, observation: { url: target.url, health, items, fetched: true, httpStatus: health === 'ready' ? 200 : 403 } });
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
test('背景讀取後至少等待 300 秒；舊連接器不得拿快取 DOM 更新庫存', async () => {
  const f = fixture(); const first = f.plan(); assert.equal(first.action, 'fetch'); await f.report(first);
  const nextReload = f.bridge.root().runtime.edion.nextReloadAt;
  f.advance(30000); assert.deepEqual(f.bridge.plans(), []);
  assert.equal(f.bridge.root().runtime.edion.nextReloadAt, nextReload);
  f.advance(300000); const reload = f.plan(); assert.equal(reload.action, 'fetch');
  assert.deepEqual(f.bridge.plans(0), []);
});
test('受限不要求人工操作，冷卻跨重啟保留，背景成功才恢復', async () => {
  const f = fixture(); await f.report(f.plan(), 'verification_required', []);
  assert.equal(f.alerts.length, 0);
  f.advance(30000); assert.deepEqual(f.bridge.plans(), []);
  const retry = f.plan(); assert.equal(retry.action, 'fetch'); await f.report(retry, 'verification_required', []);
  assert.equal(f.alerts.length, 0); assert.equal(f.ingest.length, 0);
  // A new service instance uses the same persisted episode rather than sending again.
  const reboot = fixture(); reboot.state.data = structuredClone(f.state.data);
  reboot.advance(120_000); assert.deepEqual(reboot.bridge.plans(), []);
  assert.equal(reboot.alerts.length, 0);
  await f.report(f.plan()); assert.equal(f.bridge.root().runtime.edion.health, 'ready');
  assert.equal(f.bridge.root().runtime.edion.verificationEpisode, null);
  assert.equal(f.ingest.length, 1);
  await f.report(f.plan(), 'verification_required', []); assert.equal(f.alerts.length, 0);
});
test('官方要求驗證不再觸發任何人工提醒通知', async () => {
  const f = fixture(); let sends = 0;
  f.bridge.notify = async () => { sends++; throw new Error('timeout'); };
  await f.report(f.plan(), 'verification_required', []);
  await f.report(f.plan(), 'verification_required', []);
  assert.equal(sends, 0); assert.equal(f.bridge.root().runtime.edion.alertStatus, 'disabled_no_manual_prompt');
});

test('驗證恢復後至少 15 分鐘才查詢，反覆阻擋退到 30 分鐘；觀測不假冒新掃描', async () => {
  const f=fixture();await f.report(f.plan(),'verification_required',[]);
  await f.report(f.plan());
  let runtime=f.bridge.root().runtime.edion;
  assert.equal(Date.parse(runtime.nextReloadAt)-Date.parse(runtime.checkedAt),900000);
  await f.report(f.plan(),'verification_required',[]);await f.report(f.plan());
  runtime=f.bridge.root().runtime.edion;
  assert.equal(Date.parse(runtime.nextReloadAt)-Date.parse(runtime.checkedAt),1800000);
  assert.equal(f.bridge.status('edion').intervalSeconds,1800);
});

test('舊版人工驗證狀態遷移不清基線、不提前查詢，舊 DOM 失敗不冒充背景 GET 次數', () => {
  const f = fixture();
  const deadline = '2026-10-08T00:15:00Z';
  f.state.data.commerce = {
    edionBrowser: { runtime: { edion: { health: 'verification_required', failureCount: 18,
      error: '請人工驗證', nextReloadAt: deadline, alertStatus: 'sent' } } },
    japanAuctions: { targets: { edion: { lastError: '請人工驗證', products: { preserved: true } } } },
  };
  assert.deepEqual(f.bridge.plans(2), []);
  const runtime = f.bridge.status('edion');
  assert.equal(runtime.failureCount, 0);
  assert.equal(runtime.nextReloadAt, deadline);
  assert.equal(runtime.lastDataAt, undefined);
  assert.match(runtime.error, /不需手動操作/);
  assert.deepEqual(f.state.data.commerce.japanAuctions.targets.edion.products, { preserved: true });
  assert.equal(f.alerts.length, 0);
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

test('blocked retry respects 15/30/60-minute bounds and Retry-After; stale DOM never updates baseline', async()=>{
  const f=fixture();const first=f.plan();
  await assert.rejects(f.bridge.ingest({id:'edion',scanId:first.scanId,observation:{url:target.url,health:'ready',items:[product]}}),/背景讀取證據/);
  const plan=f.plan();await f.bridge.ingest({id:'edion',scanId:plan.scanId,observation:{url:target.url,health:'verification_required',fetched:true,items:[],httpStatus:429,retryAfterSeconds:7200}});
  const r=f.bridge.root().runtime.edion;
  assert.equal(Date.parse(r.nextReloadAt)-Date.parse(r.checkedAt),7200000);
  assert.equal(f.ingest.length,0);assert.equal(r.lastDataAt,undefined);
  f.advance(600000);assert.deepEqual(f.bridge.plans(),[]);
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
    const request = (endpoint, source, token) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: '{"protocol":2}' });
    assert.equal((await request('/edion-browser/pair', 'https://evil.test')).status, 400);
    const paired = await (await request('/edion-browser/pair', base)).json(); assert.match(paired.token, /^[a-f0-9]{64}$/);
    assert.equal((await request('/edion-browser/bridge/poll', origin)).status, 400);
    const response = await request('/edion-browser/bridge/poll', origin, paired.token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal((await response.json()).targets.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
