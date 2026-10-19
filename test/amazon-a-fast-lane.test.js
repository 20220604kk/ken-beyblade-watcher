import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { load } from 'cheerio';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';

function fixture(t) {
  const config = { enabled: true, mode: 'hybrid', fastLane: true, targetUrl: 'https://www.amazon.co.jp/dp/B0TEST0001' };
  const state = { data: {}, save: async () => {} };
  const history = { status: () => ({ recent: [], total: 0 }) };
  const monitor = new AmazonJpProductOrderMonitor({ dataDir: '.', state, getConfig: () => config, orderHistory: history });
  t.after(() => monitor.close());
  return { monitor, config, state };
}

test('A two-second schedule never overlaps an active check, preserves cooldown and pending transaction locks', async t => {
  const { monitor } = fixture(t); const scheduled = [];
  monitor.scheduleNext = delay => scheduled.push(delay);
  await monitor.start(); assert.equal(scheduled.at(-1), 2000);
  monitor.taskClock = Date.now(); monitor.rearm(); assert.ok(scheduled.at(-1) <= 2000);
  monitor.running = true; const before = scheduled.length; monitor.rearm(); assert.equal(scheduled.length, before);
  monitor.running = false; monitor.setBackoff(180000); monitor.rearm(); assert.ok(scheduled.at(-1) >= 179900);
  monitor.storage().apiTransaction = { phase: 'submitted' }; const count = scheduled.length;
  monitor.rearm(); assert.equal(scheduled.length, count);
  assert.equal(monitor.canSchedule(), false);
});

test('BC share the two-second cadence and locks, with staggered initial starts rather than an API burst', async t => {
  for (const [slot, initial] of [['B', 3650], ['C', 5300]]) {
    const { monitor } = fixture(t); monitor.slot = slot;
    const scheduled = []; monitor.scheduleNext = delay => scheduled.push(delay);
    await monitor.start(); assert.equal(scheduled.at(-1), initial);
    monitor.taskClock = Date.now(); monitor.rearm(); assert.ok(scheduled.at(-1) <= 2000);
    monitor.running = true; const count = scheduled.length; monitor.rearm(); assert.equal(scheduled.length, count);
    monitor.running = false; monitor.setBackoff(60_000); monitor.rearm(); assert.ok(scheduled.at(-1) >= 59_000);
    monitor.storage().apiTransaction = { phase: 'submitted' };
    assert.equal(monitor.canSchedule(), false);
  }
});

test('product name is bound to configured ASIN, can fall back to database, never reuses previous item', t => {
  const { monitor, config, state } = fixture(t);
  monitor.storage().lastSnapshot = { asin: 'B0TEST0001', title: 'Current CX-20', code: 'CX-20' };
  assert.equal(monitor.status().targetProduct.title, 'Current CX-20');
  config.targetUrl = 'https://www.amazon.co.jp/dp/B0TEST0002';
  assert.equal(monitor.status().targetProduct.title, '');
  state.data.commerce.amazonJp = { manualProducts: { B0TEST0002: { title: 'New UX-20' } } };
  assert.equal(monitor.status().targetProduct.title, 'New UX-20');
  config.targetUrl = ''; assert.equal(monitor.status().targetProduct.asin, '');
});

test('UI shows escaped product names, correct ASIN and cadence; stale names/prices are not displayed', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const renderer = source.match(/function renderAmazonProductOrder\(s\)\{[\s\S]*?\n\}/)[0];
  const fields = new Map();
  const container = { innerHTML: '' };
  const sandbox = { amazonProductOrderDirty: {}, fmt: String, Date, localStorage: { getItem: () => null },
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    document: { querySelector: key => key === '#amazon-product-order-slots' ? container : fields.get(key) || (fields.set(key, {}), fields.get(key)) } };
  vm.createContext(sandbox); vm.runInContext(`${renderer};this.render=renderAmazonProductOrder;`, sandbox);
  const a = { slot: 'A', enabled: true, mode: 'hybrid', fastLane: true, checkoutTransport: 'api', pollIntervalSeconds: 2,
    targetUrl: 'https://www.amazon.co.jp/dp/B0TEST0001', status: 'waiting_poll',
    targetProduct: { asin: 'B0TEST0001', title: 'CX-20 <img src=x onerror=bad>' },
    lastSnapshot: { asin: 'B0TEST0001', priceYen: 100, diagnostic: { quoteMs: 321 } } };
  sandbox.render({ japanAuctions: { amazonJpProductOrders: [a] } });
  let html = container.innerHTML;
  assert.match(html, /CX-20 &lt;img/); assert.equal(load(html)('img').length, 0);
  assert.match(html, /2 秒＋補貨訊號/); assert.match(html, /報價 321ms/);
  for (const slot of ['A','B','C']) {
    const card=load(html)('#amazon-product-order-card-'+slot);
    assert.match(card.find('button').first().attr('onclick'),new RegExp('openAmazonProductOrder.*'+slot));
    assert.deepEqual(card.find('button').map((_,el)=>load(el).text()).get(),['開啟','檢查','重設']);
    assert.equal(card.find('input[type=checkbox]').length,1);
    assert.match(card.find('input[type=checkbox]').parent().text(),/啟動/);
    assert.equal(card.find('select').length,0);
    assert.equal(card.find('tr.amazon-order-main').length,1);
    assert.equal(card.find('tr.amazon-order-main > td').length,6);
    assert.equal(card.find('tr.amazon-order-detail-row[hidden]').length,1);
    assert.equal(card.find('details.amazon-product-disclosure summary').length,1);
    assert.equal(card.find('input[type=url]').closest('tr').hasClass('amazon-order-detail-row'),true);
  }
  assert.equal(load(html)('table.amazon-order-sheet').length,1);
  const live=load(fields.get('#amazon-live-log-content').innerHTML);
  assert.equal(live('.amazon-live-log-column').length,3);
  assert.equal(live('button').length,0,'刷新 LOG 不會重建工具列按鈕');
  assert.equal(load(source.split('<script>')[0])('#amazon-product-order-clear-log').length,1);
  assert.equal(load(html)('.amazon-step-stream').length,0,'任務表不再藏第二份 LOG');
  a.purchaseSteps=[{step:'01',page:'商品頁面',action:'舊事件',status:'等待'},{step:'02',page:'安全結帳',action:'新事件',status:'成功'}];
  sandbox.render({japanAuctions:{amazonJpProductOrders:[a]}});
  const logText=load(fields.get('#amazon-live-log-content').innerHTML)('#amazon-live-log-A').text();
  assert.ok(logText.indexOf('新事件')<logText.indexOf('舊事件'));
  sandbox.amazonLiveLogMessage='已清空 ABC 即時 LOG';
  sandbox.render({japanAuctions:{amazonJpProductOrders:[a]}});
  assert.match(container.innerHTML,/已清空 ABC 即時 LOG/,'自動刷新不會洗掉清空完成提示');
  assert.ok(source.indexOf('id="amazon-product-order-live-logs"')<source.indexOf('id="amazon-product-order-slots"'));
  a.lastSnapshot.evaluation = 'not_purchasable';
  a.lastSnapshot.diagnostic.decision = 'retail_contract_incomplete';
  sandbox.render({ japanAuctions: { amazonJpProductOrders: [a] } });
  html = container.innerHTML;
  assert.match(html, /自營加車欄位不完整，非判定售罄/);
  a.targetUrl = 'https://www.amazon.co.jp/dp/B0TEST0002';
  sandbox.render({ japanAuctions: { amazonJpProductOrders: [a] } });
  html = container.innerHTML;
  assert.doesNotMatch(html, /CX-20|¥100|報價 321ms/);
  assert.match(html, /品名待辨識/); assert.match(html, /B0TEST0002/);
  sandbox.amazonProductOrderDirty.B=true;
  a.targetUrl='https://www.amazon.co.jp/dp/B0TEST0003';
  sandbox.render({japanAuctions:{amazonJpProductOrders:[a]}});
  assert.equal(container.innerHTML,html,'未儲存的欄位不被狀態刷新覆蓋');
});
