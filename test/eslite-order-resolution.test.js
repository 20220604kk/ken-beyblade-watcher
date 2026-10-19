import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AutoPurchaseCoordinator } from '../src/auto-purchase.js';
import { esliteSheetOutcome, esliteSheetRecords, esliteSheetOrderRowsHtml } from '../src/eslite-purchase-ui.js';

const held = (taskId, id = taskId) => ({ platform: 'eslite', taskId, accountSlot: 'E', accountIdentity: 'identity-E',
  status: 'submitted_unconfirmed', product: { id, title: '測試 ' + id }, quantity: 1, startedAt: '2026-10-15T02:38:23Z', steps: [] });
function fixture(records, { orders = [], complete = true, failSave = false } = {}) {
  const storage = { records: Object.fromEntries(records.map(r => [r.taskId, r])), recent: structuredClone(records) };
  const state = { data: { commerce: { autoPurchase: storage } }, save: async () => { if (failSave) throw Error('mock disk failure'); } };
  let queries = 0;
  const adapter = { accountBusy: 0, purchaseHold: { productId: records[0]?.product.id },
    _withAccountLock: async fn => { adapter.accountBusy++; try { return await fn(); } finally { adapter.accountBusy--; } },
    _ensureApiContext: async () => ({}), _resetApiReadiness() {},
    apiOrderReader: async () => { queries++; return { orders, complete }; } };
  const multi = { adapters: { E: adapter }, busySlots: new Set(), accountIdentity: () => 'identity-E',
    credentialsStatus: () => ({}), runtimeStatus: () => ({}), close: async () => {} };
  const coordinator = new AutoPurchaseCoordinator({ state, adapters: { eslite: multi }, getConfig: () => ({}), notifyPrivate: async () => {} });
  for (const r of records) { coordinator._ledger().reserve(r.taskId, 'eslite', 'identity-E', [{ id: r.product.id, quantity: 1 }], r.startedAt); coordinator._ledger().settle(r.taskId, r); }
  return { coordinator, storage, adapter, multi, queries: () => queries };
}

for (const complete of [true, false]) test(`查無吻合（complete=${complete}）只更新查詢證據，保護和額度保留`, async () => {
  const r = held('one'), f = fixture([r], { complete });
  try {
    const result = await f.coordinator.reconcileEsliteAccount({ accountSlot: 'E' });
    assert.equal(f.queries(), 1); assert.equal(result.resolved, 0); assert.equal(result.pending, 1);
    assert.equal(r.status, 'submitted_unconfirmed'); assert.equal(r.orderCheck.result, 'not_found');
    assert.equal(f.storage.recent[0].orderCheck.result, 'not_found'); assert.ok(f.adapter.purchaseHold);
    assert.equal(f.coordinator._ledger().data.reservations.one.status, 'held');
    assert.equal(esliteSheetOutcome(r).group, 'unknown'); assert.match(result.message, /確認未成立/);
  } finally { await f.coordinator.close(); }
});

test('單筆人工確認同步主紀錄、recent 與額度；其他待核對任務仍保護', async () => {
  const a = held('one'), b = held('two'), f = fixture([a, b]);
  try {
    const result = await f.coordinator.resolveEsliteHold({ accountSlot: 'E', taskId: 'one', confirmedNoOrder: true });
    assert.equal(result.resolved, 1); assert.equal(a.status, 'manually_confirmed_no_order');
    assert.equal(f.storage.recent.find(r => r.taskId === 'one').status, a.status);
    assert.equal(a.resolutionSource, 'user_confirmed_no_order'); assert.ok(a.resolvedAt); assert.equal(a.steps.at(-1).label, '人工確認訂單未成立');
    assert.equal(b.status, 'submitted_unconfirmed'); assert.equal(f.adapter.purchaseHold.productId, 'two');
    assert.equal(f.coordinator._ledger().data.reservations.one, undefined); assert.ok(f.coordinator._ledger().data.reservations.two);
    assert.equal(f.queries(), 0); assert.match(result.message, /未清車、未重送/);
    await f.coordinator.resolveEsliteHold({ accountSlot: 'E', taskIds: ['two'], confirmedNoOrder: true });
    assert.equal(f.adapter.purchaseHold, null); assert.equal(Object.keys(f.coordinator._ledger().data.reservations).length, 0);
  } finally { await f.coordinator.close(); }
});

test('舊畫面／缺任務 ID／帳號已換，不能誤解除另一筆未知訂單', async () => {
  const r = held('current'), f = fixture([r]);
  try {
    await assert.rejects(f.coordinator.resolveEsliteHold({ accountSlot: 'E', confirmedNoOrder: true }), /那筆任務/);
    await assert.rejects(f.coordinator.resolveEsliteHold({ accountSlot: 'E', taskId: 'old', confirmedNoOrder: true }), /已更新/);
    f.multi.accountIdentity = () => 'different';
    await assert.rejects(f.coordinator.resolveEsliteHold({ accountSlot: 'E', taskId: 'current', confirmedNoOrder: true }), /帳號已更換/);
    assert.equal(r.status, 'submitted_unconfirmed'); assert.ok(f.adapter.purchaseHold); assert.equal(f.multi.busySlots.size, 0);
  } finally { await f.coordinator.close(); }
});

test('保存失敗完整回復主紀錄、副本、步驟與保留額度', async () => {
  const r = held('one'), f = fixture([r], { failSave: true }), original = structuredClone(r);
  try {
    await assert.rejects(f.coordinator.resolveEsliteHold({ accountSlot: 'E', taskId: 'one', confirmedNoOrder: true }), /disk/);
    assert.deepEqual(r, original); assert.deepEqual(f.storage.recent[0], original);
    assert.ok(f.coordinator._ledger().data.reservations.one); assert.ok(f.adapter.purchaseHold);
    assert.equal(f.multi.busySlots.size, 0);
  } finally { await f.coordinator.close(); }
});

test('查單失敗有行內證據，不解除、不假稱查無訂單', async () => {
  const r = held('one'), f = fixture([r]);
  f.adapter.apiOrderReader = async () => { throw Error('mock official timeout'); };
  try {
    await assert.rejects(f.coordinator.reconcileEsliteAccount({ accountSlot: 'E' }), /timeout/);
    assert.equal(r.orderCheck.result, 'error'); assert.equal(f.storage.recent[0].orderCheck.result, 'error');
    assert.equal(esliteSheetOutcome(r).text, '查單失敗／待核對'); assert.ok(f.adapter.purchaseHold);
  } finally { await f.coordinator.close(); }
});

test('控制台以主紀錄取代過時副本，人工確認顯示中文，按鈕只指向本筆', () => {
  const stale = held('one'), confirmed = { ...stale, status: 'manually_confirmed_no_order' };
  const row = esliteSheetRecords({ recent: [stale], esliteOrders: [confirmed] }).rows[0];
  assert.equal(row.item.status, confirmed.status); assert.equal(esliteSheetOutcome(row.item).text, '人工確認未成立');
  assert.doesNotMatch(esliteSheetOrderRowsHtml([row]), /data-eslite-no-order/);
  assert.match(esliteSheetOrderRowsHtml([{ key: 'one', item: stale }]), /data-eslite-no-order="one" data-eslite-account="E"/);
});

test('查單按鈕有查詢中／結果／錯誤回饋，不再寫到遠處的全域結果框', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const code = source.match(/^function setEsliteQueryFeedback\(.*$/m)[0] + '\n' + source.match(/^async function queryEsliteOrders\(.*$/m)[0];
  const nodes = { '#eslite-query-orders-E': { dataset: {}, disabled: false, textContent: '查單' },
    '#eslite-query-result-E': { textContent: '' }, '#auto-purchase-eslite-state': { textContent: '' } };
  let finish, calls = 0;
  const context = vm.createContext({ document: { querySelector: id => nodes[id] }, refresh: async () => {},
    api: async () => { calls++; await new Promise(resolve => finish = resolve); return { message: '本次查無吻合，請人工確認' }; } });
  vm.runInContext(code, context);
  const result = vm.runInContext("queryEsliteOrders('E')", context);
  assert.equal(nodes['#eslite-query-orders-E'].textContent, '查詢中'); assert.match(nodes['#eslite-query-result-E'].textContent, /正在查詢/);
  await vm.runInContext("queryEsliteOrders('E')", context); assert.equal(calls, 1);
  finish(); await result;
  assert.match(nodes['#eslite-query-result-E'].textContent, /本次查無吻合/); assert.equal(nodes['#eslite-query-orders-E'].textContent, '查單');
});
