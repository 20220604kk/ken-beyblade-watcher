import test from 'node:test';
import assert from 'node:assert/strict';
import { logDestinationFor, taipeiDateKey } from '../src/file-log-router.js';

test('購物網站 LOG 依來源分類', () => {
  assert.deepEqual(logDestinationFor('誠品戰鬥陀螺關鍵字探索：讀取 5 件商品。', 'shopping'), {
    section: '購物網站', label: '誠品線上'
  });
  assert.deepEqual(logDestinationFor('momo 戰鬥陀螺限量發售 掃描完成', 'shopping'), {
    section: '購物網站', label: 'momo購物網'
  });
  assert.deepEqual(logDestinationFor('蝦皮 FUNBOX 旗艦館讀取完成', 'shopping'), {
    section: '購物網站', label: '蝦皮-FUNBOX'
  });
});

test('Funbox 與日本網站各自保存', () => {
  assert.deepEqual(logDestinationFor('Funbox 官網掃描完成', 'funbox'), {
    section: 'Funbox官網', label: '監控'
  });
  assert.deepEqual(logDestinationFor('1999.co.jp 掃描完成', 'japan'), {
    section: '日本網站', label: '1999'
  });
});

test('日期固定使用台北時區', () => {
  assert.equal(taipeiDateKey(new Date('2026-09-05T16:30:00Z')), '2026-09-06');
});
