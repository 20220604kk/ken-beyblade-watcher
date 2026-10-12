import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AmazonOrderHistory, amazonOrderTimings } from '../src/amazon-order-history.js';

async function historyForTest(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amazon-order-history-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const history = new AmazonOrderHistory(dir);
  await history.ready;
  return { history, dir };
}
const initial = () => ({ mode: 'hybrid', trigger: 'poll', scanStartedAt: '2026-09-22T01:00:00.000Z',
  snapshot: { asin: 'B0H4PPV8MR', code: 'UX-20', title: 'test', priceYen: 2701 }, msrpYen: 2700,
  steps: [{ name: 'refresh_start', at: '2026-09-22T01:00:00.000Z', elapsedMs: 0 }] });

test('訂單分檔保存：成功、通知失敗及步驟經過重啟仍可讀取，不保存結帳網址', async (t) => {
  const { history, dir } = await historyForTest(t);
  const record = await history.begin(initial());
  await history.step(record, { name: 'submit_order', at: '2026-09-22T01:00:05.000Z', elapsedMs: 5000, url: 'https://amazon.co.jp/secret?token=abc' });
  await history.finish(record, { status: 'ordered', orderId: 'TEST-ORDER' });
  await history.notification(record, { status: 'failed', at: new Date().toISOString(), error: 'HTTP 503 https://discord.com/api/webhooks/secret' });
  // A subsequent logging/callback failure may not downgrade an accepted order.
  await history.finish(record, { status: 'failed', error: 'later error' });
  const raw = await fs.readFile(path.join(history.directory, `${record.id}.json`), 'utf8');
  assert.doesNotMatch(raw, /secret|token=abc/);
  const loaded = new AmazonOrderHistory(dir);
  await loaded.ready;
  assert.equal(loaded.status().recent[0].status, 'ordered');
  assert.equal(loaded.status().recent[0].orderId, 'TEST-ORDER');
  assert.equal(loaded.status().recent[0].notification.status, 'failed');
  assert.equal(loaded.status().recent[0].timings.confirmedToNotificationMs, null);
  assert.equal(loaded.status().recent[0].steps.length, 2);
});

test('未完成流程重啟後標記中斷；原始檔與未知結果保留，不臆測成功', async (t) => {
  const { history, dir } = await historyForTest(t);
  const unfinished = await history.begin(initial());
  const unknown = await history.begin(initial());
  await history.finish(unknown, { status: 'submitted_unconfirmed', error: 'response lost' });
  const loaded = new AmazonOrderHistory(dir);
  await loaded.ready;
  assert.equal(loaded.status().recent.find(r => r.id === unfinished.id).status, 'interrupted');
  assert.equal(loaded.status().recent.find(r => r.id === unknown.id).status, 'submitted_unconfirmed');
  assert.equal(JSON.parse(await fs.readFile(path.join(history.directory, `${unfinished.id}.json`))).status, 'in_progress');
});

test('只載入最近二十筆但不刪除舊檔，損毀檔會警示而不阻擋其他紀錄', async (t) => {
  const { history, dir } = await historyForTest(t);
  for (let i = 0; i < 23; i++) await history.begin(initial());
  const newest = history.recent[0];
  await fs.writeFile(path.join(history.directory, `${newest.id}.json`), '{broken');
  const loaded = new AmazonOrderHistory(dir);
  await loaded.ready;
  assert.equal(loaded.status().total, 23);
  assert.equal(loaded.status().recent.length, 19);
  assert.match(loaded.status().error, /無法完整保存/);
  assert.equal((await fs.readdir(history.directory)).filter(n => n.endsWith('.json')).length, 23);
});

test('寫入失敗只回報保存警示，不拋錯造成重複下單', async (t) => {
  const { history } = await historyForTest(t);
  const blocker = path.join(history.directory, 'not-a-directory');
  await fs.writeFile(blocker, 'test');
  history.directory = blocker;
  const record = await history.begin(initial());
  await history.finish(record, { status: 'ordered', orderId: 'TEST' });
  assert.match(history.status().error, /無法完整保存/);
  assert.equal(history.status().recent[0].status, 'ordered');
});

test('各段耗時定義正確；缺少訊號、送單或失敗時不捏造數字', () => {
  const stamp = seconds => new Date(Date.UTC(2026, 8, 22, 1, 0, seconds)).toISOString();
  const record = { status: 'ordered', signalAt: stamp(0), finishedAt: stamp(10), notification: { status: 'sent', at: stamp(11) },
    steps: [['refresh_start',1],['product_evaluated',3],['buy_now_click',4],['submit_order',8]].map(([name, seconds]) => ({ name, at: stamp(seconds) })) };
  assert.deepEqual(amazonOrderTimings(record), { signalToRefreshMs: 1000, refreshToQualifiedMs: 2000,
    qualifiedToPurchaseMs: 1000, purchaseToSubmitMs: 4000, submitToConfirmedMs: 2000,
    refreshToConfirmedMs: 9000, confirmedToNotificationMs: 1000 });
  record.signalAt = null;
  record.status = 'failed';
  assert.equal(amazonOrderTimings(record).signalToRefreshMs, null);
  assert.equal(amazonOrderTimings(record).refreshToConfirmedMs, null);
  assert.equal(amazonOrderTimings({ steps: [] }).submitToConfirmedMs, null);
});
