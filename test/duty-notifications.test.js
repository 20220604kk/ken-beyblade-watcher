import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DailyDutyNotifier, dutyWindowStatus, formatDutyNotification
} from '../src/duty-notifications.js';

function atTaipei(iso) {
  return new Date(iso);
}

test('一般時段與跨午夜時段會取得正確值班日期', () => {
  assert.deepEqual(
    dutyWindowStatus(atTaipei('2026-07-21T01:30:00.000Z'), '09:00', '22:00'),
    { active: true, alwaysActive: false, sessionKey: '2026-07-21' }
  );
  assert.equal(
    dutyWindowStatus(atTaipei('2026-07-21T14:30:00.000Z'), '09:00', '22:00').active,
    false
  );
  assert.deepEqual(
    dutyWindowStatus(atTaipei('2026-07-21T14:30:00.000Z'), '22:00', '06:00'),
    { active: true, alwaysActive: false, sessionKey: '2026-07-21' }
  );
  assert.deepEqual(
    dutyWindowStatus(atTaipei('2026-07-21T20:30:00.000Z'), '22:00', '06:00'),
    { active: true, alwaysActive: false, sessionKey: '2026-07-21' }
  );
});

test('每日開始與結束只各推播一次，重啟後也不重複', async () => {
  const state = {};
  const messages = [];
  let saves = 0;
  const createNotifier = () => new DailyDutyNotifier({
    id: 'facebook',
    label: 'FB 粉專監控',
    state,
    getConfig: () => ({
      enabled: true,
      activeHours: { start: '09:00', end: '22:00' }
    }),
    notify: async (message) => messages.push(message),
    save: async () => { saves += 1; }
  });

  const notifier = createNotifier();
  assert.equal(await notifier.check(atTaipei('2026-07-21T01:00:00.000Z')), 'start');
  assert.equal(await notifier.check(atTaipei('2026-07-21T05:00:00.000Z')), null);
  assert.equal(await notifier.check(atTaipei('2026-07-21T14:00:00.000Z')), 'end');
  assert.equal(await notifier.check(atTaipei('2026-07-21T14:05:00.000Z')), null);

  const restarted = createNotifier();
  assert.equal(await restarted.check(atTaipei('2026-07-21T02:00:00.000Z')), null);
  assert.equal(messages.length, 2);
  assert.equal(saves, 2);
  assert.match(messages[0], /今日掃描開始/);
  assert.match(messages[1], /今日掃描結束/);
});

test('值班通知清楚顯示來源與掃描時段', () => {
  const text = formatDutyNotification({
    kind: 'start',
    label: 'Funbox 官網監控',
    start: '08:30',
    end: '23:00',
    now: atTaipei('2026-07-21T00:30:00.000Z')
  });
  assert.match(text, /^🟢 Funbox 官網監控｜今日掃描開始/);
  assert.match(text, /監控時段：08:30～23:00/);
});
