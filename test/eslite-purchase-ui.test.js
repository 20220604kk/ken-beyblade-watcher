import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { esliteTableCss, esliteAccountTableHtml, esliteOrderTablesHtml, esliteTableClient, esliteSheetTime,
  esliteSheetOutcome, esliteSheetRecords, esliteSheetOrderRowsHtml, renderEsliteTables,
  renderEsliteAccountSheet, esliteAccountReadiness } from '../src/eslite-purchase-ui.js';

const record = (extra = {}) => ({ platform: 'eslite', accountSlot: 'A', taskId: 'test-1',
  product: { id: 'one', title: '測試 UX-03' }, status: 'ordered', orderId: 'TEST-001',
  startedAt: '2026-10-08T05:32:16Z', payment: 'virtual_atm_home', quantity: 1, ...extra });

test('登入操作回饋標註帳號，避免其他帳號舊冷卻訊息混淆', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function testAutoPurchaseLogin('), source.indexOf('async function completeAutoPurchaseLogin('));
  const state = {}, calls = [];
  const sandbox = { document: { querySelector: () => state }, refresh: async () => {},
    api: async (route, body) => { calls.push({ route, body }); return { message: '手動視窗已開啟' }; } };
  vm.createContext(sandbox); vm.runInContext(code + ';this.login=testAutoPurchaseLogin;', sandbox);
  for (const slot of ['B', 'C', 'D', 'E']) {
    await sandbox.login('eslite', slot); assert.equal(state.textContent, '誠品帳號 ' + slot + '｜手動視窗已開啟');
    assert.equal(calls.at(-1).body.accountSlot, slot);
  }
});

test('manual recovery gate stays visible even when its old boolean flag is stale', () => {
  assert.equal(esliteAccountReadiness({}, { ready: true }, { manualLoginRequired: false,
    sessionRecoveryState: 'manual_required', heartbeatEnabled: true }).text, '需人工驗證');
});

test('three fixed account rows and labeled local filters; no duplicate IDs', () => {
  const $ = cheerio.load(esliteAccountTableHtml + esliteOrderTablesHtml);
  assert.equal($('.eslite-account-table tbody tr').length, 3);
  assert.deepEqual($('#eslite-sheet-account-filter option').map((_, el) => $(el).text()).get(), ['全部', 'A', 'B', 'C']);
  const ids = $('[id]').map((_, el) => $(el).attr('id')).get();
  assert.equal(new Set(ids).size, ids.length);
  for (const slot of ['A', 'B', 'C']) {
    assert.equal($(`#eslite-sheet-actions-${slot} button`).length, 4);
    assert.equal($(`#eslite-sheet-identity-${slot} a.account-browser-link`).length, 1);
    assert.match($(`#eslite-sheet-browser-${slot}`).attr('onclick'), /open-browser/);
    assert.equal($(`#eslite-sheet-actions-${slot} [data-account-tool]`).length, 0);
    assert.equal($(`#eslite-sheet-actions-${slot} button[aria-label="手動登入"]`).text(), '手動');
    assert.equal($(`#eslite-sheet-settings-${slot}`).attr('aria-controls'), `eslite-account-${slot}-card`);
  }
});

test('account actions use compact labels in one line, retaining original handlers and accessible names', () => {
  const $ = cheerio.load(esliteAccountTableHtml);
  const buttons = $('#eslite-sheet-actions-A button');
  assert.deepEqual(buttons.map((_, el) => $(el).text()).get(), ['登入', '手動', '檢查', '設定']);
  assert.equal(buttons.eq(1).attr('onclick'), "testAutoPurchaseLogin('eslite','A',true)");
  assert.equal(buttons.eq(1).attr('aria-label'), '手動登入');
  assert.match(esliteTableCss, /eslite-account-table \.eslite-actions\{flex-wrap:nowrap/);
  assert.match(esliteTableCss, /height:26px/);
  assert.equal($('.eslite-account-table col').last().attr('style'), 'width:25%');
  assert.match(esliteTableCss, /eslite-account-table\{min-width:0;width:100%/);
});

test('order creation is not payment; unknown results never become success', () => {
  assert.equal(esliteSheetOutcome(record()).text, '訂單成立');
  assert.equal(esliteSheetOutcome(record({ paymentStatus: 'payment_paid' })).text, '已付款');
  assert.equal(esliteSheetOutcome(record({ status: 'submitted_unconfirmed' })).group, 'unknown');
  assert.equal(esliteSheetOutcome(record({ orderId: null })).group, 'unknown');
  assert.equal(esliteSheetOutcome(record({ status: 'failed' })).group, 'failed');
  assert.equal(esliteSheetOutcome(record({ status: 'payment_failed' })).group, 'ordered');
});

test('records dedupe in-progress snapshot and preserve account separation', () => {
  const a = record({ status: 'processing' });
  const b = record({ accountSlot: 'B', taskId: 'test-2', startedAt: '2026-10-08T05:32:17Z' });
  const result = esliteSheetRecords({ inProgress: [a], recent: [a, b, record({ platform: 'funbox', taskId: 'test-3' })] });
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map(row => row.item.accountSlot), ['B', 'A']);
});

test('keyword, account and result filters compose without mutating source', () => {
  const status = { recent: [record(), record({ accountSlot: 'B', taskId: 'test-2', status: 'failed' })] };
  assert.equal(esliteSheetRecords(status, { keyword: 'ux-03', account: 'A', status: 'ordered' }).rows.length, 1);
  assert.equal(esliteSheetRecords(status, { keyword: 'test-001', account: 'B', status: 'failed' }).rows.length, 1);
  assert.equal(esliteSheetRecords(status, { keyword: 'CX-99' }).rows.length, 0);
  assert.equal(status.recent.length, 2);
});

test('one compact row per order; step detail is opt-in', () => {
  const rows = esliteSheetRecords({ recent: [record()] }).rows;
  let $ = cheerio.load('<table><tbody>' + esliteSheetOrderRowsHtml(rows) + '</tbody></table>');
  assert.equal($('tbody tr').length, 1);
  assert.equal($('button').attr('aria-expanded'), 'false');
  $ = cheerio.load('<table><tbody>' + esliteSheetOrderRowsHtml(rows, new Set(['test-1'])) + '</tbody></table>');
  assert.equal($('tbody tr').length, 2);
  assert.match($('.eslite-step-log').text(), /舊紀錄沒有逐步日誌/);
});

test('unrecorded quantity, amount and ATM details are never fabricated', () => {
  const rows = esliteSheetRecords({ recent: [record({ quantity: undefined })] }).rows;
  const $ = cheerio.load('<table><tbody>' + esliteSheetOrderRowsHtml(rows) + '</tbody></table>');
  assert.equal($('td').eq(3).text(), '—');
  assert.match($('td').eq(5).text(), /轉帳資訊未記錄/);
  assert.doesNotMatch($('td').eq(5).text(), /013|NT\$/);
});

test('step logs show numbered plain-language actions, results, and honest missing detail', () => {
  const item = record({steps:[
    {label:'紅利折抵已歸零',reason:'官方確認 0 點；下一步核對付款方式',state:'success',httpStatus:200,elapsedMs:1200},
    {label:'向官方送出訂單',reason:'第 1/3 次；等待官方回覆',state:'start',attempt:1,elapsedMs:1300},
    {label:'API 舊紀錄',state:'success',httpStatus:200,elapsedMs:1400}
  ]});
  const html=esliteSheetOrderRowsHtml(esliteSheetRecords({recent:[item]}).rows,new Set(['test-1']));
  const $=cheerio.load('<table>'+html+'</table>');
  assert.match($.text(),/執行動作與確認結果/);
  assert.match($.text(),/01｜紅利折抵已歸零/);
  assert.match($.text(),/結果／處理方式：官方確認 0 點/);
  assert.match($.text(),/02｜向官方送出訂單/);
  assert.match($.text(),/執行內容：第 1\/3 次/);
  assert.match($.text(),/不能只憑回應碼判定成功/);
});

test('escape products, error and step content; disallow unsafe order links', () => {
  const item = record({ product: { title: '<img src=x onerror=alert(1)>' }, resultUrl: 'javascript:alert(1)',
    error: '<script>alert(1)</script>', steps: [{ label: '<b>送出</b>', reason: '<iframe>', state: 'failed', elapsedMs: 2500 }] });
  const html = esliteSheetOrderRowsHtml(esliteSheetRecords({ recent: [item] }).rows, new Set(['test-1']));
  const $ = cheerio.load('<table><tbody>' + html + '</tbody></table>');
  assert.equal($('img,script,iframe,b,a').length, 0);
  assert.match($('.eslite-step-log').text(), /<b>送出<\/b>/);
  assert.match($('.eslite-step-log').text(), /\+2\.50s/);
});

test('official HTTPS order link and actual payment fields remain accessible', () => {
  const html = esliteSheetOrderRowsHtml(esliteSheetRecords({ recent: [record({ resultUrl: 'https://www.eslite.com/orders/TEST-001', amount: 345, paymentDeadline: '2026-10-09T05:59:59Z' })] }).rows);
  const $ = cheerio.load('<table>' + html + '</table>');
  assert.equal($('a').attr('rel'), 'noopener noreferrer');
  assert.match($.text(), /NT\$345.*期限/);
});

test('Taipei timestamps are deterministic and invalid timestamps stay unknown', () => {
  assert.match(esliteSheetTime('2026-10-08T05:32:16Z'), /13:32:16/);
  assert.equal(esliteSheetTime('bad'), '—');
  assert.equal(esliteSheetTime(null), '—');
});

test('client compiles standalone and presentation helpers contain no network calls', () => {
  assert.doesNotThrow(() => new vm.Script(esliteTableClient));
  assert.doesNotMatch(esliteTableClient, /\bfetch\s*\(|\bapi\s*\(|XMLHttpRequest/);
});

function fakeDocument() {
  const nodes = new Map();
  return { nodes, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', append() {}, setAttribute() {}, querySelectorAll() { return []; } });
    return nodes.get(id);
  } };
}

test('queue rendering keeps each account order and distinguishes executing, held and empty', () => {
  const doc = fakeDocument();
  const context = vm.createContext({ document: doc, Intl, Date, Set });
  vm.runInContext(esliteTableClient, context);
  context.input = { queue: [
    { platform: 'eslite', accountSlot: 'A', title: 'A-2', priorityKeyword: 'BX-09', expiresAt: new Date(Date.now() + 20000).toISOString() },
    { platform: 'eslite', accountSlot: 'B', title: 'B-1', blockedReason: '待核對訂單' },
    { platform: 'eslite', accountSlot: 'A', title: 'A-3' },
    { platform: 'funbox', accountSlot: 'C', title: '不得混入' }],
  inProgress: [record({ product: { title: 'A-1' }, status: 'processing', steps: [{ label: '送出訂單' }] })] };
  vm.runInContext('renderEsliteTables(input)', context);
  const html = doc.nodes.get('eslite-sheet-queue').innerHTML;
  assert.ok(html.indexOf('A-1') < html.indexOf('A-2') && html.indexOf('A-2') < html.indexOf('A-3'));
  assert.match(html, /送出訂單/);
  assert.match(html, /優先：BX-09/);
  assert.match(html, /待核對訂單/);
  assert.doesNotMatch(html, /不得混入/);
  vm.runInContext('renderEsliteTables({})', context);
  assert.match(doc.nodes.get('eslite-sheet-queue').innerHTML, /目前沒有待購商品/);
});

test('account table makes missing checkout template visible despite valid login', () => {
  const doc = fakeDocument();
  const context = vm.createContext({ document: doc, Intl, Date, Set });
  vm.runInContext(esliteTableClient, context);
  vm.runInContext("renderEsliteAccountSheet({eslite:{accountPayments:{B:'virtual_atm_home'}}},'B',{ready:true,account:'09***53'},{loginState:'ready',apiReady:false,checkoutTemplateReady:false,purchasedProductCount:1},true)", context);
  assert.equal(doc.nodes.get('eslite-sheet-login-B').textContent, '已登入');
  assert.equal(doc.nodes.get('eslite-sheet-api-B').textContent, '待準備結帳資料 · 單品');
  assert.equal(doc.nodes.get('eslite-sheet-payment-B').textContent, '宅配 ATM');
});

test('continuous event and cooldown are visible without fake order success', () => {
  const doc = fakeDocument();
  const context = vm.createContext({ document: doc, Intl, Date, Set });
  vm.runInContext(esliteTableClient, context);
  context.input = { esliteRestockEvent: { active: true, productCount: 5 }, esliteWaitingTasks: [
    { accountSlot: 'B', title: 'UX-03', blockedReason: '重試冷卻中', retryAt: new Date(Date.now() + 5000).toISOString() },
    { accountSlot: 'C', title: 'BX-09', blockedReason: '等待最新 API 觀測' }] };
  vm.runInContext('renderEsliteTables(input)', context);
  assert.equal(doc.nodes.get('eslite-sheet-event-state').textContent, '持續補任務 · 5 款');
  assert.match(doc.nodes.get('eslite-sheet-queue').innerHTML, /重試冷卻中.*等待最新 API 觀測/);
  assert.match(doc.nodes.get('eslite-sheet-orders').innerHTML, /沒有符合條件的紀錄/);
  vm.runInContext('renderEsliteTables({})', context);
  assert.equal(doc.nodes.get('eslite-sheet-event-state').textContent, '等待補貨訊號');
});
