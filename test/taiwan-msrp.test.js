import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateTaiwanMsrpCandidate,
  extractBeybladeModels,
  taiwanMsrpCatalog,
  taiwanMsrpEntries
} from '../src/taiwan-msrp.js';

test('台灣原價基準合併人工表與完整陀螺頁補遺', () => {
  assert.equal(taiwanMsrpCatalog.summary.manualEntries, 64);
  assert.ok(taiwanMsrpCatalog.summary.totalEntries >= 79);
  assert.equal(taiwanMsrpEntries('BX-50').some((entry) => entry.msrpTwd === 350), true);
  assert.equal(taiwanMsrpEntries('UX-20').some((entry) => entry.msrpTwd === 595), true);
  assert.equal(taiwanMsrpEntries('UX-21').some((entry) => entry.msrpTwd === 895), true);
});

test('型號抽取支援 BX、UX、CX 與 BXG', () => {
  assert.deepEqual(
    extractBeybladeModels('BEYBLADE X UX-21 與 BXG-04'),
    ['UX-21', 'BXG-04']
  );
});

test('原價與九折促銷價可通過價格基線', () => {
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: 'BEYBLADE X UX-21 惡魔冥界改造組', price: 895 }).reason,
    'exact_msrp'
  );
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: 'BEYBLADE X UX-21 惡魔冥界改造組', price: 805 }).reason,
    'official_price_promotion'
  );
});

test('海外版、溢價、多型號與 BX-00 模糊版本不會只靠價格放行', () => {
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: '美版 BEYBLADE X UX-21', price: 895 }).reason,
    'import_version'
  );
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: 'BEYBLADE X UX-21', price: 1299 }).reason,
    'price_mismatch'
  );
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: 'UX-20 + UX-21 套組', price: 1490 }).reason,
    'multiple_models'
  );
  assert.equal(
    evaluateTaiwanMsrpCandidate({ title: 'BX-00 復刻商品', price: 350 }).reason,
    'ambiguous_model_version'
  );
});
