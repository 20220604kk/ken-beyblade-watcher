import test from 'node:test';
import assert from 'node:assert/strict';
import { funboxScanStatus } from '../src/funbox-scan-status.js';

const now = Date.parse('2026-10-24T16:00:10+08:00');
const base = { funbox: { enabled: true, withinActiveHours: true, scanning: false,
  nextScanAt: '2026-10-24T16:00:12+08:00', lastScan: { completedAt: '2026-10-24T16:00:08+08:00', checked: 4, skipped: 5 } } };
test('正常與正在執行的掃描各自顯示實際開始、完成及下次時間', () => {
  assert.match(funboxScanStatus(base, now), /掃描正常.*16:00:08.*16:00:12.*追蹤 4 件/);
  assert.match(funboxScanStatus({ funbox: { ...base.funbox, scanning: true, scanStartedAt: '2026-10-24T16:00:09+08:00' } }, now), /掃描中.*16:00:09.*16:00:08/);
});
test('整輪失敗不可用舊成功紀錄冒充目前正常；登入錯誤不冒充掃描錯誤', () => {
  assert.match(funboxScanStatus({ funbox: { ...base.funbox, lastScanError: '所有來源逾時', lastAttemptAt: '2026-10-24T16:00:10+08:00' } }, now), /讀取異常.*所有來源逾時/);
  assert.match(funboxScanStatus({ ...base, autoPurchase: { runtime: { funbox: { accounts: [{ loginState: 'error' }] } } } }, now), /掃描正常/);
  assert.match(funboxScanStatus(base, now + 60000), /完成紀錄過久/);
});
test('部分來源、暫停與時段外狀態不顯示為掃描正常', () => {
  assert.match(funboxScanStatus({ funbox: { ...base.funbox, lastScan: { ...base.funbox.lastScan, errors: ['搜尋逾時'] } } }, now), /部分來源失敗/);
  assert.match(funboxScanStatus({ ...base, systemPause: { active: true } }, now), /已暫停/);
  assert.match(funboxScanStatus({ funbox: { ...base.funbox, enabled: false } }, now), /已停止/);
  assert.match(funboxScanStatus({ funbox: { ...base.funbox, withinActiveHours: false } }, now), /等待監控時段/);
});
