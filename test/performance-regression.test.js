import test from 'node:test';
import assert from 'node:assert/strict';
import { readAndReleaseResponse } from '../src/api-response.js';
import { ShoppingSiteMonitor } from '../src/shopping-sites.js';
import { dashboardStatusForView, dashboardOverview } from '../src/dashboard-status.js';
import { monitoringResourceDecision } from '../src/monitoring-resources.js';

test('concurrent monitoring targets share one browser launch and recover after a failed launch', async () => {
  let launches = 0;
  const browser = { isConnected: () => true };
  const monitor = new ShoppingSiteMonitor({ state: { data: {} }, getTargets: () => [], browserLauncher: async () => {
    launches += 1;
    if (launches === 1) throw new Error('launch failed');
    return browser;
  } });
  const failed = await Promise.allSettled([monitor.ensureBrowser(), monitor.ensureBrowser()]);
  assert.ok(failed.every(result => result.status === 'rejected'));
  assert.equal(launches, 1);
  const ready = await Promise.all([monitor.ensureBrowser(), monitor.ensureBrowser(), monitor.ensureBrowser()]);
  assert.ok(ready.every(result => result === browser));
  assert.equal(launches, 2);
});

test('purchase API bodies are released after reading, including malformed responses', async () => {
  let disposed = 0;
  const response = { status: () => 409, text: async () => 'inventory conflict', dispose: async () => { disposed += 1; } };
  assert.equal(await readAndReleaseResponse(response), 'inventory conflict');
  assert.equal(disposed, 1);
  assert.equal(response.status(), 409);
  await assert.rejects(readAndReleaseResponse({ json: async () => { throw new Error('bad JSON'); }, dispose: async () => { disposed += 1; } }, 'json'), /bad JSON/);
  assert.equal(disposed, 2);
});

test('lightweight dashboard preserves scan state and excludes unrelated logs and account records', () => {
  const status = {
    logs: ['private log'], shoppingSiteLogs: { eslite: ['details'] },
    autoPurchase: { credentials: { secret: 'not-for-overview' } },
    systemPause: { active: true, pausedAt: '2026-09-21T03:01:00Z' },
    funbox: { enabled: true, scanning: true, intervalSeconds: 10, lastScan: { completedAt: '2026-09-21T03:00:00Z' } },
    japanAuctions: { amazonJp: { enabled: false }, targets: [] },
    notifications: { availability: { discordJapan: true } }
  };
  const before = JSON.stringify(status);
  const overview = dashboardStatusForView(status, 'overview');
  assert.equal(overview.overview.sources.find(source => source.id === 'funbox').seconds, 10);
  assert.deepEqual(overview.systemPause, status.systemPause);
  assert.equal(overview.logs, undefined);
  assert.equal(overview.autoPurchase, undefined);
  assert.doesNotMatch(JSON.stringify(overview), /private log|not-for-overview/);
  const shopping = dashboardStatusForView(status, 'shopping', { logs: true });
  assert.deepEqual(shopping.shoppingSiteLogs, status.shoppingSiteLogs);
  assert.equal(shopping.logs, undefined);
  assert.equal(JSON.stringify(status), before);
  assert.equal(dashboardStatusForView(status, null), status);
});

test('overview distinguishes paused sources from current failures and stale data', () => {
  const s = { japanAuctions: { amazonJp: { enabled: false } }, shoppingSites: { enabled: true, intervalSeconds: 10, targets: [
    { id: 'paused', enabled: false, lastError: 'old error' },
    { id: 'broken', enabled: true, withinActiveHours: true, lastError: '503' },
    { id: 'stale', enabled: true, withinActiveHours: true, lastScanAt: '2026-09-21T03:00:00Z' }
  ] } };
  const sources = dashboardOverview(s, Date.parse('2026-09-21T03:10:00Z')).sources;
  assert.equal(sources.find(x => x.id === 'paused').state, 'paused');
  assert.equal(sources.find(x => x.id === 'paused').error, '');
  assert.equal(sources.find(x => x.id === 'broken').state, 'error');
  assert.equal(sources.find(x => x.id === 'stale').state, 'stale');
});

test('overview distinguishes ordinary Amazon five-second checks from actual checkout', () => {
  const base = { shoppingSites: { targets: [] }, japanAuctions: { amazonJp: { enabled: false }, targets: [] } };
  const checking = dashboardOverview({ ...base, japanAuctions: { ...base.japanAuctions, amazonJpProductOrders: [
    { slot: 'A', enabled: true, mode: 'hybrid', status: 'waiting_poll', phase: 'checking', running: true }
  ] } }).orders.at(-1);
  assert.equal(checking.state, '五秒巡檢');
  const ordering = dashboardOverview({ ...base, japanAuctions: { ...base.japanAuctions, amazonJpProductOrders: [
    { slot: 'A', enabled: true, mode: 'hybrid', status: 'ordering', phase: 'ordering', running: true }
  ] } }).orders.at(-1);
  assert.equal(ordering.state, '下單中');
});

test('monitor asset policy retains inventory API, site scripts, styles and verification', () => {
  for (const [type,url] of [
    ['fetch','https://holmes.eslite.com/v1/search'], ['xhr','https://www.amazon.co.jp/gp/aod/ajax'],
    ['script','https://challenges.cloudflare.com/turnstile/v0/api.js'], ['stylesheet','https://www.eslite.com/app.css'],
    ['document','https://www.1999.co.jp/list/2613/7/1?soldout=0']
  ]) assert.equal(monitoringResourceDecision(type,url), 'allow');
  assert.equal(monitoringResourceDecision('image','https://www.amazon.co.jp/image.jpg'), 'asset');
  assert.equal(monitoringResourceDecision('script','https://stats.g.doubleclick.net/ad'), 'telemetry');
  assert.equal(monitoringResourceDecision('fetch','https://www.eslite.com/?next=doubleclick.net/ad'), 'allow');
});
