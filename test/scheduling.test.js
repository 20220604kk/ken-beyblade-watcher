import assert from 'node:assert/strict';
import test from 'node:test';

import { fixedCadenceRemainingMs, optionalDelayMs } from '../src/scheduling.js';

test('日本排程正常完成的 null 等待值必須維持設定間隔，不得轉成連續掃描', () => {
  for (const value of [null, undefined, '', NaN, 'invalid', -1]) {
    assert.equal(optionalDelayMs(value, 20_000), 20_000);
  }
  assert.equal(optionalDelayMs(0, 20_000), 0);
  assert.equal(optionalDelayMs(900_000, 20_000), 900_000);
});

test('固定節拍會扣除本輪掃描耗時，不把逾時疊加到下一輪', () => {
  assert.equal(fixedCadenceRemainingMs(10_000, 1_000, 4_000), 7_000);
  assert.equal(fixedCadenceRemainingMs(10_000, 1_000, 12_000), 0);
});

test('固定節拍遇到無效時間時退回完整間隔', () => {
  assert.equal(fixedCadenceRemainingMs(10_000, Number.NaN, 4_000), 10_000);
});
