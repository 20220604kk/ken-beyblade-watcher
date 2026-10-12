import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutoPurchaseCoordinator, MultiAccountFunboxPurchaseAdapter, normalizeAutoPurchaseConfig, updateAutoPurchaseSettings } from '../src/auto-purchase.js';
import { LocalCredentialStore } from '../src/credential-store.js';
import { funboxSheetRecords, funboxAccountTableHtml, funboxOrderTablesHtml } from '../src/funbox-purchase-ui.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ purchase, slots = ['A', 'B', 'C'], continuous = false, notify = async () => {} } = {}) {
  let time = Date.now(), monitored = true, random = 0;
  const calls = [], busy = new Set(), state = { data: {}, async save() {} };
  const config = { enabled: true, funbox: { enabled: true, buyKeywords: ['BEYBLADE'], skipBuyKeywords: [], priorityKeywords: [], accountPayments: { A: 'virtual_atm_home', B: 'virtual_atm_home', C: 'virtual_atm_home' } } };
  const children = Object.fromEntries(slots.map(slot => [slot, {}]));
  const adapter = { independentQueues: true, maxConcurrency: 3, adapters: children, accountPurchaseTails: new Map(),
    queueSlots: () => slots, accountIdentity: slot => 'identity-' + slot,
    queueBlockReason: slot => children[slot].purchaseHold ? '訂單待核對' : '',
    credentialsStatus: () => ({ ready: true }), runtimeStatus: () => ({ accounts: slots.map(slot => ({ slot, ...children[slot] })) }), close: async () => {},
    async purchase(product, settings) {
      const slot = settings.accountSlot;
      assert.equal(busy.has(slot), false); assert.equal(Array.isArray(product), false);
      busy.add(slot); calls.push({ slot, id: product.id, at: time });
      try { await settings.onAccountAssigned(slot); await settings.onStep({ label: 'API 加入購物車', state: 'success' });
        return purchase ? await purchase(product, slot, settings) : { status: 'ordered', orderNumber: 'mock-' + slot + '-' + product.id, quantity: 1, payment: 'virtual_atm_home', paymentUrl: 'https://shop.funbox.com.tw/orders/mock', accountSlot: slot };
      } finally { busy.delete(slot); }
    }
  };
  const coordinator = new AutoPurchaseCoordinator({ state, adapters: { funbox: adapter }, getConfig: () => config,
    continuousFunboxTasks: continuous, funboxTaskClock: () => time, funboxQueueRandom: () => (random++ * 0.37) % 1,
    isPlatformMonitoringEnabled: () => monitored, notifyPrivate: notify });
  const toy = (id, extra = {}) => ({ id, title: 'BEYBLADE X ' + id, url: 'https://shop.funbox.com.tw/products/' + id,
    available: true, stock: 50, variantId: 'variant-' + id, reason: 'restock', detectedAt: new Date(time).toISOString(), ...extra });
  return { coordinator, state, calls, adapter, config, toy, advance(ms) { time += ms; }, now: () => time, disable() { monitored = false; } };
}

test('Funbox five products: independent ABC queues, slow A never stalls B/C, one product per order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ purchase: async (product, slot) => { if (slot === 'A') await gate; return { status: 'ordered', orderNumber: slot + product.id }; } });
  try {
    assert.equal((await f.coordinator.enqueue('funbox', ['1', '2', '3', '4', '5'].map(id => f.toy(id)))).accepted, 15);
    for (let n = 0; n < 30; n++) await tick();
    assert.equal(f.calls.filter(call => call.slot === 'A').length, 1);
    assert.equal(f.calls.filter(call => call.slot === 'B').length, 5);
    assert.equal(f.calls.filter(call => call.slot === 'C').length, 5);
    release(); await f.coordinator.whenIdle(); assert.equal(f.calls.length, 15);
    assert.equal((await f.coordinator.enqueue('funbox', [f.toy('1')])).accepted, 0);
    assert.notDeepEqual(f.calls.filter(c => c.slot === 'A').map(c => c.id), f.calls.filter(c => c.slot === 'C').map(c => c.id));
  } finally { release(); await f.coordinator.close(); }
});

test('priority keywords dispatch same desired product to ABC first; blacklist still wins', async () => {
  const f = fixture(); f.config.funbox.priorityKeywords = ['BX-09', '強化組']; f.config.funbox.skipBuyKeywords = ['BX-37'];
  try {
    const products = [f.toy('1'), f.toy('2', { title: 'BEYBLADE 強化組 CX-08' }), f.toy('BX-09'), f.toy('BX-37'), f.toy('3', { title: 'not whitelisted' })];
    assert.equal((await f.coordinator.enqueue('funbox', products)).accepted, 9);
    await f.coordinator.whenIdle();
    for (const slot of ['A', 'B', 'C']) assert.deepEqual(f.calls.filter(call => call.slot === slot).map(call => call.id).slice(0, 2), ['bx-09', '2']);
    assert.equal(f.calls.some(call => call.id === 'bx-37' || call.id === '3'), false);
  } finally { await f.coordinator.close(); }
});

test('continuous Funbox busy failure requires cooldown AND new official observation, confirmed orders never repeat', async () => {
  let count = 0;
  const f = fixture({ continuous: true, slots: ['B'], purchase: async () => { if (++count === 1) { const error = new Error('connection timeout'); throw error; } return { status: 'ordered', orderNumber: 'mock-B' }; } });
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1')]); await f.coordinator.whenIdle(); assert.equal(count, 1);
    f.advance(6000); await f.coordinator._schedule(); assert.equal(count, 1);
    f.coordinator.observeFunboxInventory([f.toy('1')], f.now()); await f.coordinator.whenIdle(); assert.equal(count, 2);
    f.advance(6000); f.coordinator.observeFunboxInventory([f.toy('1')], f.now()); await f.coordinator.whenIdle(); assert.equal(count, 2);
  } finally { await f.coordinator.close(); }
});

test('Funbox stale baseline, expired observations, unavailable products and stopped monitor cannot initiate purchases', async () => {
  const f = fixture({ continuous: true });
  try {
    f.coordinator.observeFunboxInventory([f.toy('baseline')], f.now()); await tick(); assert.equal(f.calls.length, 0);
    assert.equal((await f.coordinator.enqueue('funbox', [f.toy('old', { detectedAt: new Date(f.now() - 31000).toISOString() }), f.toy('sold', { available: false })])).accepted, 0);
    f.disable(); assert.equal((await f.coordinator.enqueue('funbox', [f.toy('live')])).accepted, 0);
  } finally { await f.coordinator.close(); }
});

test('Funbox unknown submission holds only that account and never becomes a fake success', async () => {
  let attemptsA = 0;
  const f = fixture({ purchase: async (product, slot) => {
    if (slot === 'A') { attemptsA++; const error = new Error('submit timeout'); error.orderSubmitted = true; throw error; }
    return { status: 'ordered', orderNumber: slot + product.id };
  } });
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1'), f.toy('2')]);
    for (let n = 0; n < 25; n++) await tick();
    assert.equal(attemptsA, 1); assert.equal(f.calls.filter(c => c.slot === 'B').length, 2);
    assert.ok(f.adapter.adapters.A.purchaseHold);
    const record = Object.values(f.state.data.commerce.autoPurchase.records).find(r => r.accountSlot === 'A');
    assert.equal(record.status, 'submitted_unconfirmed');
    await assert.rejects(f.coordinator.reset('funbox', record.product.id), /尚未確認/);
    await assert.rejects(f.coordinator.resolveFunboxHold({ accountSlot: 'A', confirmedNoOrder: false }), /核對/);
    await f.coordinator.resolveFunboxHold({ accountSlot: 'A', confirmedNoOrder: true });
    assert.equal(f.adapter.adapters.A.purchaseHold, null);
  } finally { f.coordinator.queue = []; await f.coordinator.close(); }
});

test('ordered label without an actual Funbox order number is protected, not recorded as purchased', async () => {
  const f = fixture({ slots: ['A'], purchase: async () => ({ status: 'ordered', resultUrl: 'https://shop.funbox.com.tw/carts/not-an-order' }) });
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1')]); await f.coordinator.whenIdle();
    assert.equal(f.coordinator.getStatus().recent[0].status, 'submitted_unconfirmed');
    assert.equal(f.state.data.commerce.autoPurchase.funboxPurchased?.['identity-A']?.['1'], undefined);
  } finally { await f.coordinator.close(); }
});

test('Funbox legacy numeric records deduplicate by canonical URL for that account only', async () => {
  const f = fixture();
  f.state.data.commerce.autoPurchase.records['funbox:123:A'] = { platform: 'funbox', slot: 'A', product: f.toy('1', { id: '123' }), status: 'ordered', orderNumber: 'old' };
  try { assert.equal((await f.coordinator.enqueue('funbox', [f.toy('1')])).accepted, 2); await f.coordinator.whenIdle(); assert.deepEqual(f.calls.map(c => c.slot).sort(), ['B', 'C']); }
  finally { await f.coordinator.close(); }
});

test('private notifications do not delay the next order; retain order number, contents and checkout link', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const messages = [];
  const f = fixture({ slots: ['B'], notify: async text => { messages.push(text); await gate; } });
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1'), f.toy('2')]); for (let n = 0; n < 30; n++) await tick();
    assert.equal(f.calls.length, 2); assert.match(messages[0], /mock-B-1/); assert.match(messages[0], /購物車內容/); assert.match(messages[0], /結帳連結/);
    release(); await f.coordinator.whenIdle();
  } finally { release(); await f.coordinator.close(); }
});

test('Funbox D and AA accounts persist encrypted, reject duplicate identity, and keep separate payment/priority settings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'funbox-queue-credentials-'));
  try {
    const store = await new LocalCredentialStore(directory).load();
    await store.setFunboxAccount('D', { account: 'd@example.com', password: 'private-d' });
    await store.setFunboxAccount('AA', { account: 'aa@example.com', password: 'private-aa' });
    await assert.rejects(store.setFunboxAccount('E', { account: 'd@example.com', password: 'p' }), /帳號/);
    const loaded = await new LocalCredentialStore(directory).load(); assert.equal(loaded.getFunboxAccount('AA').password, 'private-aa');
    const encrypted = await fs.readFile(path.join(directory, 'private-purchase/credentials.enc.json'), 'utf8'); assert.doesNotMatch(encrypted, /private-d|d@example/);
    const config = updateAutoPurchaseSettings(normalizeAutoPurchaseConfig({ eslite: { priorityKeywords: ['unchanged'] } }), { platform: 'funbox', funboxPriorityKeywords: ['BX-09'], funboxAccountPayments: { D: 'virtual_atm_home', AA: 'seven_cod' } });
    assert.deepEqual(config.funbox.priorityKeywords, ['BX-09']); assert.equal(config.funbox.accountPayments.AA, 'seven_cod'); assert.deepEqual(config.eslite.priorityKeywords, ['unchanged']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Funbox spreadsheet preserves legacy combined orders, deduplicates orders, and filters independently', () => {
  const record = { platform: 'funbox', completedAt: '2026-10-09T01:00:00Z', accountResults: [{ slot: 'B', payment: 'virtual_atm_home', waves: [{ status: 'ordered', orderNumber: '123', products: [{ title: 'UX-16' }, { title: 'CX-08' }] }] }] };
  const selected = funboxSheetRecords({ recent: [record], funboxOrders: [record, { platform: 'eslite' }] }, { account: 'B', keyword: 'CX-08', status: 'ordered' });
  assert.equal(selected.rows.length, 1); assert.equal(selected.rows[0].item.product.title, 'UX-16 ＋ CX-08');
  assert.match(funboxAccountTableHtml, /funbox-sheet-account-C/); assert.match(funboxOrderTablesHtml, /renderFunboxTables/); assert.doesNotMatch(funboxOrderTablesHtml, /eslite-sheet-search|renderEsliteTables/);
});

test('production MultiAccount adapter targets only one account per task and supports D, capped at three concurrent carts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'funbox-real-adapter-mock-'));
  const accounts = ['A', 'B', 'C', 'D'].map(slot => ({ slot, account: slot + '@example.test', password: 'test', enabled: true }));
  const multi = new MultiAccountFunboxPurchaseAdapter({ dataDir: directory, getAccounts: () => accounts });
  const calls = []; let active = 0, peak = 0;
  for (const [slot, child] of Object.entries(multi.adapters)) child.purchase = async (product, settings) => {
    active++; peak = Math.max(active, peak); await tick(); active--;
    calls.push({ slot, id: product.id, payment: settings.payment }); return { status: 'ordered', orderNumber: slot + product.id, quantity: 1 };
  };
  const state = { data: {}, async save() {} };
  const coordinator = new AutoPurchaseCoordinator({ state, adapters: { funbox: multi }, notifyPrivate: async () => {},
    getConfig: () => ({ enabled: true, funbox: { enabled: true, buyKeywords: ['test'], skipBuyKeywords: [], accountPayments: { D: 'virtual_atm_home' } } }) });
  try {
    await coordinator.enqueue('funbox', ['1', '2'].map(id => ({ id, title: 'test ' + id, url: 'https://shop.funbox.com.tw/products/' + id })));
    await coordinator.whenIdle(); assert.equal(calls.length, 8); assert.ok(peak <= 3);
    assert.deepEqual(calls.filter(c => c.slot === 'D').map(c => c.id).sort(), ['1', '2']);
    assert.ok(calls.filter(c => c.slot === 'D').every(c => c.payment === 'virtual_atm_home'));
  } finally { await coordinator.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Funbox hold release invalidates old observation and persistence failure leaves the account protected', async () => {
  const f = fixture({ continuous: true, slots: ['A'], purchase: async () => { const error = new Error('submit timeout'); error.orderSubmitted = true; throw error; } });
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1')]); await f.coordinator.whenIdle();
    f.state.save = async () => { throw new Error('disk failure'); };
    await assert.rejects(f.coordinator.resolveFunboxHold({ accountSlot: 'A', confirmedNoOrder: true }), /disk failure/);
    assert.ok(f.adapter.adapters.A.purchaseHold);
    assert.equal(f.coordinator.getStatus().funboxOrders[0].status, 'submitted_unconfirmed');
    f.state.save = async () => {};
    await f.coordinator.resolveFunboxHold({ accountSlot: 'A', confirmedNoOrder: true });
    await f.coordinator._schedule(); assert.equal(f.calls.length, 1);
    f.advance(1); f.coordinator.observeFunboxInventory([f.toy('1')], f.now()); await f.coordinator.whenIdle(); assert.equal(f.calls.length, 2);
  } finally { await f.coordinator.close(); }
});

test('Funbox per-step permanent evidence drops request headers and credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'funbox-step-evidence-'));
  const f = fixture({ slots: ['A'] }); f.coordinator.funboxHistoryFile = path.join(directory, 'funbox-attempts.jsonl');
  try {
    await f.coordinator.enqueue('funbox', [f.toy('1')]); await f.coordinator.whenIdle(); await f.coordinator.funboxHistoryTail;
    const attempts = await fs.readFile(f.coordinator.funboxHistoryFile, 'utf8');
    const steps = await fs.readFile(path.join(directory, 'funbox-steps.jsonl'), 'utf8');
    assert.match(attempts, /mock-A-1/); assert.match(steps, /"accountSlot":"A"/); assert.match(steps, /API 加入購物車/);
    assert.doesNotMatch(attempts + steps, /authorization|cookie|password|Request headers/i);
  } finally { await f.coordinator.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Funbox and Eslite dynamic account tables cannot append rows into each other', async () => {
  const source = await fs.readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /querySelector\('#eslite-sheet-account-A'\)\.parentElement\.insertAdjacentHTML/);
  assert.match(source, /querySelector\('\.funbox-account-table tbody'\)\.insertAdjacentHTML/);
  assert.doesNotMatch(source, /querySelector\('\.eslite-account-table tbody'\)/);
});
