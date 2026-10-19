import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHistoricalFixture, replayRestock, assertReplayInvariants } from '../scripts/commerce-restock-replay.mjs';
const fixtures = { funbox: await loadHistoricalFixture('funbox'), eslite: await loadHistoricalFixture('eslite') };

test('歷史基準保留未知：FUNBOX八款四候選；誠品十五觀測十一候選、B一張已核驗', () => {
  assert.equal(fixtures.funbox.products.length, 8);
  assert.equal(fixtures.funbox.products.filter(p => p.historical_candidate).length, 4);
  assert.equal(fixtures.funbox.historical_confirmed_order_count, 0);
  assert.equal(fixtures.eslite.identified_observations, 15); assert.equal(fixtures.eslite.candidates.length, 11);
  assert.deepEqual(fixtures.eslite.historical_confirmed_orders, { A: 0, B: 1, C: 0 });
  for (const f of Object.values(fixtures)) { assert.equal(f.actual_release_at, null); assert.equal(f.actual_sold_out_at, null); }
  assert.equal(fixtures.eslite.first_task_replies.B.checkout_start_ms, 5101);
  assert.equal(fixtures.eslite.first_task_replies.B.official_created_at, '13:32:16');
});
for (const platform of ['funbox', 'eslite']) for (const profile of ['smooth', 'late', 'congested']) for (const mode of ['single', 'batch', 'mixed']) {
  test(`共享庫存策略模型 ${platform}／${profile}／${mode}：序列、名單、額度、封箱與截止`, () => {
    const result = replayRestock(fixtures[platform], { platform, profile, mode });
    assert.equal(assertReplayInvariants(result), true);
    const again = replayRestock(fixtures[platform], { platform, profile, mode });
    assert.deepEqual(result, again, '相同種子必須可重播');
    assert.equal(result.accounts[0].jobs[0].planned[0].fixtureId, platform === 'funbox' ? 'F06' : 'E02');
  });
}
test('慢十秒只延後我方偵測，不跟著延後競品或售罄時鐘', () => {
  for (const platform of ['funbox', 'eslite']) {
    const a = replayRestock(fixtures[platform], { platform }), b = replayRestock(fixtures[platform], { platform, profile: 'late' });
    assert.equal(b.accounts[0].jobs[0].startMs - a.accounts[0].jobs[0].startMs, 10000);
    assert.equal(b.assumptions.soldOutAtMs, a.assumptions.soldOutAtMs);
    assert.ok(b.orders.reduce((s, o) => s + o.quantity, 0) <= a.orders.reduce((s, o) => s + o.quantity, 0));
  }
});
test('測試本身負向校驗：把庫存、紅利、重複单、同帳號重疊破壞後必須抓到', () => {
  const original = replayRestock(fixtures.funbox, { platform: 'funbox', competition: false });
  const corruptions = [
    r => { r.orders[0].bonus = 1; },
    r => { r.orders.push(structuredClone(r.orders[0])); },
    r => { r.used[r.sourceProducts[0].id] = 100000; },
    r => { r.accounts[0].jobs[1].startMs = 0; }
  ];
  for (const mutate of corruptions) { const copy = structuredClone(original); mutate(copy); assert.throws(() => assertReplayInvariants(copy)); }
});
test('交叉規則：50個種子 × 兩平台 × 單品/合單，所有庫存與帳號不變量成立', () => {
  for (let seed = 1; seed <= 50; seed++) for (const platform of ['funbox', 'eslite']) for (const mode of ['single', 'batch'])
    assert.equal(assertReplayInvariants(replayRestock(fixtures[platform], { platform, mode, seed, profile: seed % 3 === 0 ? 'congested' : seed % 3 === 1 ? 'smooth' : 'late' })), true);
});
