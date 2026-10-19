import fs from 'node:fs/promises';
import { PurchaseLedger } from '../src/purchase-ledger.js';
import { normalizeDispatchSettings, purchasePolicy } from '../src/purchase-rules.js';
import { planAccountPurchase, sortPurchaseTasks, selectAccountBatch } from '../src/purchase-dispatcher.js';

const references = {
  funbox: new URL('../docs/restock-reference-for-ai/FUNBOX_2026-09-04_多品項補貨模擬基準.md', import.meta.url),
  eslite: new URL('../docs/restock-reference-for-ai/誠品_2026-10-08_策展補貨模擬基準.md', import.meta.url)
};
export async function loadHistoricalFixture(platform) {
  const text = await fs.readFile(references[platform], 'utf8');
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map(match => JSON.parse(match[1])).find(value => value.fixture_id);
  if (!block || block.network_mode !== 'offline_mock_only') throw Error('歷史基準缺少離線資料契約');
  return block;
}
export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
export const timingProfiles = {
  smooth: { name: '順暢', detectionLagMs: 0, clearMs: 300, addMs: 300, verifyMs: 300, otherMs: 400, submitMs: 600, confirmMs: 200 },
  late: { name: '慢 10 秒', detectionLagMs: 10000, clearMs: 300, addMs: 300, verifyMs: 300, otherMs: 400, submitMs: 600, confirmMs: 200 },
  congested: { name: '壅塞', detectionLagMs: 0, clearMs: 1500, addMs: 2000, verifyMs: 3000, otherMs: 3000, submitMs: 8000, confirmMs: 1000 }
};

// Dispatch/time/stock model, NOT a storefront emulator or replacement for adapter tests.
// Stock commits at checkout; adding does not reserve inventory. Every account shares stock.
export function replayRestock(fixture, { platform, profile = 'smooth', mode = 'single', seed = 1008,
  competition = true, soldOutAtMs = 120000, deadlineMs = 300000 } = {}) {
  const timing = timingProfiles[profile];
  if (!timing || !['single', 'batch', 'mixed'].includes(mode)) throw Error('未知重播參數');
  const random = seededRandom(seed), base = Date.parse('2026-10-08T05:32:07.155Z');
  const products = platform === 'funbox'
    ? fixture.products.filter(p => p.historical_candidate).map(p => ({ id: p.path.split('/').at(-1), title: p.name,
      fixtureId: p.id, quantity: 1, stock: /隨機強化組/.test(p.name) ? 9 : 3, price: 100 }))
    : fixture.candidates.map(p => ({ id: p.guid, title: p.name, fixtureId: p.id, quantity: 1, stock: p.stock, price: 100 }));
  const settings = { ...normalizeDispatchSettings({ accountModes: { A: mode === 'single' ? 'single' : 'batch',
    B: mode === 'batch' ? 'batch' : 'single', C: mode === 'batch' ? 'batch' : 'single' }, batchMaxItems: 5 }),
    buyMode: 'whitelist', buyKeywords: platform === 'funbox' ? ['CX-13', 'BX-50', 'UX-20', 'BX-00'] : ['UX-', 'BX-', 'CX-'],
    skipBuyKeywords: ['BX-10', 'BX-37', 'CX-02', 'CX-03'], priorityKeywords: platform === 'funbox' ? ['BX-50'] : ['強化組'], quantity: 1 };
  const ledger = new PurchaseLedger({}), used = Object.fromEntries(products.map(p => [p.id, 0]));
  const at = ms => new Date(base + ms).toISOString();
  const available = (p, ms) => Math.max(0, ms >= soldOutAtMs ? 0 : p.stock - used[p.id] - (competition ? p.stock === 1 ? ms >= 3000 ? 1 : 0 : Math.floor(ms / 10000) : 0));
  const accounts = ['A', 'B', 'C'].map(slot => ({ slot, identity: 'SIM-' + slot, readyMs: timing.detectionLagMs,
    queue: sortPurchaseTasks(products.map((p, i) => ({ platform, accountSlot: slot, accountIdentity: 'SIM-' + slot,
      product: p, discoveryOrder: i, rank: random() })), settings), jobs: [], excluded: [] }));
  // Eligibility test fixture, NOT a claim about historical A's actual purchases.
  if (platform === 'eslite') {
    const p = products.find(p => /UX-03/.test(p.title));
    ledger.recordOrder({ platform, identity: 'SIM-A', reference: 'SIM-HISTORY-A', at: at(-86400000), items: [{ id: p.id, quantity: 1 }] });
  }
  const orders = [], events = []; let serial = 0;
  const runnable = account => item => planAccountPurchase({ platform, product: { ...item.product, stock: available(item.product, account.readyMs) },
    settings, identity: account.identity, ledger, at: at(account.readyMs) }).eligible && available(item.product, account.readyMs) > 0;
  function launch(account) {
    while (account.queue.length && account.readyMs < deadlineMs && account.readyMs < soldOutAtMs) {
      const first = account.queue.shift();
      if (!runnable(account)(first)) { account.excluded.push({ id: first.product.id, reason: available(first.product, account.readyMs) ? 'account_rule' : 'stock_out' }); continue; }
      const members = selectAccountBatch(first, account.queue, settings, runnable(account));
      const chosen = new Set(members); account.queue = account.queue.filter(item => !chosen.has(item));
      const batch = settings.accountModes[account.slot] === 'batch';
      const buildLimit = batch ? Math.min(members.length, Math.ceil(settings.batchBuildMs / timing.addMs)) : 1;
      account.excluded.push(...members.slice(buildLimit).map(item => ({ id: item.product.id, reason: 'batch_build_deadline' })));
      const planned = members.slice(0, buildLimit).map(item => ({ ...item.product, quantity: planAccountPurchase({ platform, product: { ...item.product, stock: available(item.product, account.readyMs) },
        settings, identity: account.identity, ledger, at: at(account.readyMs) }).quantity }));
      const submitMs = account.readyMs + timing.clearMs + timing.addMs * planned.length + timing.verifyMs + timing.otherMs + timing.submitMs + (batch ? settings.batchCollectMs : 0);
      const taskId = `SIM-${platform}-${++serial}`;
      ledger.reserve(taskId, platform, account.identity, planned, at(account.readyMs));
      const job = { taskId, account: account.slot, startMs: account.readyMs, submitMs, planned,
        actions: ['01 清車確認', '02 核對任務', '03 加車', '04 核對整車', '紅利0／金額付款核對', '保存送單意圖', '送单', '查單確認'] };
      account.jobs.push(job); events.push({ account, job }); return;
    }
    if (account.queue.length) { account.excluded.push(...account.queue.map(item => ({ id: item.product.id, reason: 'deadline' }))); account.queue = []; }
  }
  for (const account of accounts) launch(account);
  while (events.length) {
    events.sort((a, b) => a.job.submitMs - b.job.submitMs || a.account.slot.localeCompare(b.account.slot));
    const { account, job } = events.shift();
    const submitted = job.submitMs < deadlineMs;
    const accepted = submitted ? job.planned.filter(p => available(p, job.submitMs) >= p.quantity) : [];
    job.result = accepted.length ? 'sim_ordered' : 'sim_rejected';
    job.checkoutCalls = submitted ? 1 : 0; job.confirmMs = job.submitMs + timing.confirmMs;
    job.skipped = job.planned.filter(p => !accepted.includes(p)).map(p => ({ id: p.id, reason: submitted ? 'stock_out' : 'deadline' }));
    if (accepted.length) {
      for (const p of accepted) used[p.id] += p.quantity;
      const order = { orderNumber: `SIM-${platform === 'funbox' ? 'F' : 'E'}-${orders.length + 1}`, account: account.slot,
        products: accepted, quantity: accepted.reduce((sum, p) => sum + p.quantity, 0), bonus: 0,
        amount: accepted.reduce((sum, p) => sum + p.price * p.quantity, 0) + 120, createdMs: job.submitMs, confirmedMs: job.confirmMs };
      orders.push(order);
      ledger.settle(job.taskId, { status: 'ordered', orderNumber: order.orderNumber, completedAt: at(job.submitMs), items: accepted });
    } else ledger.settle(job.taskId, { status: 'failed' });
    account.readyMs = job.confirmMs; launch(account);
  }
  return { evidence: 'synthetic_dispatch_stock_model_not_live', fixtureId: fixture.fixture_id, platform, profile, mode, seed,
    assumptions: { timings: timing, priceEach: 100, shippingEach: 120, stockBasis: platform === 'funbox' ? 'synthetic 3 regular / 9 random' : 'historical snapshot, not guaranteed inventory',
      competitors: competition ? 'rare item at +3s; other items lose 1 each +10s' : 'none', soldOutAtMs, deadlineMs, historicalActualSoldOutAt: fixture.actual_sold_out_at,
      tieBreak: 'same millisecond A before B before C; fixed simulation bias', fakePriorPurchase: platform === 'eslite' ? 'A UX-03' : null },
    sourceProducts: products, settings, orders, used, accounts: accounts.map(a => ({ account: a.slot,
      orderCount: orders.filter(o => o.account === a.slot).length, jobs: a.jobs, excluded: a.excluded })) };
}

export function assertReplayInvariants(result) {
  const refs = new Set(), daily = new Map();
  for (const order of result.orders) {
    if (!order.orderNumber.startsWith('SIM-') || refs.has(order.orderNumber)) throw Error('假單號缺失或重複'); refs.add(order.orderNumber);
    if (order.bonus !== 0 || order.amount > result.settings.batchMaxTotal) throw Error('紅利或含運上限錯誤');
    if (result.settings.accountModes[order.account] !== 'batch' && order.products.length !== 1) throw Error('單品模式混入第二款');
    if (order.quantity !== order.products.reduce((sum, p) => sum + p.quantity, 0)) throw Error('成立數量與整車不符');
    if (order.createdMs >= result.assumptions.deadlineMs || order.createdMs >= result.assumptions.soldOutAtMs) throw Error('截止後仍成立');
    const ids = new Set();
    for (const p of order.products) {
      if (ids.has(p.id) || !Number.isInteger(p.quantity) || p.quantity < 1) throw Error('混車或數量錯誤'); ids.add(p.id);
      const rule = purchasePolicy(result.platform, p, result.settings);
      if (!rule.eligible) throw Error('黑白名單排除產品竟成立');
      const key = order.account + ':' + p.id, qty = (daily.get(key) || 0) + p.quantity; daily.set(key, qty);
      if (qty > (rule.dailyLimit || 1)) throw Error('帳號限購超量');
      if (result.platform === 'eslite' && order.account === 'A' && /UX-03/.test(p.title)) throw Error('永久已購排除失敗');
    }
  }
  for (const p of result.sourceProducts) {
    const actual = result.orders.reduce((sum, o) => sum + o.products.filter(item => item.id === p.id).reduce((n, item) => n + item.quantity, 0), 0);
    if (result.used[p.id] !== actual || actual > p.stock) throw Error('三帳號複製庫存或記帳不符');
  }
  for (const account of result.accounts) {
    for (let i = 0; i < account.jobs.length; i++) {
      const job = account.jobs[i];
      if (i && job.startMs < account.jobs[i - 1].confirmMs) throw Error('同帳號未完成就開下一車');
      if (job.checkoutCalls > 1 || job.actions[0] !== '01 清車確認') throw Error('送單重複或未先清車');
      if (job.planned.length > result.settings.batchMaxItems) throw Error('合單超過款數');
    }
  }
  return true;
}
