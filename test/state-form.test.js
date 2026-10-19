import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameWithRetry, StateStore } from '../src/state.js';

test('升級時把歷史表單標為已看過，避免重啟後誤送舊表單', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-state-'));
  const formUrl = 'https://forms.gle/legacy-form';
  try {
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
      seen: {
        old: {
          pageName: '台茂',
          firstSeen: '2026-07-15T04:00:00.000Z',
          formUrls: [formUrl]
        }
      },
      initializedPages: {}
    }), 'utf8');
    const state = new StateStore(directory);
    await state.load();

    assert.equal(state.data.forms[formUrl].status, 'legacy_seen');
    assert.equal(state.canAttemptForm(formUrl), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('新表單可被原子占用，完成後不會由另一通道重複處理', () => {
  const state = new StateStore('unused');
  const formUrl = 'https://forms.gle/new-form';

  assert.equal(state.claimForm(formUrl, { pageName: '台茂' }), true);
  assert.equal(state.claimForm(formUrl, { pageName: '台茂' }), false);
  state.completeForm(formUrl, { status: 'submitted', submitted: true });
  assert.equal(state.canAttemptForm(formUrl), false);
});

test('Windows 暫時鎖住狀態檔時會自動重試改名', async () => {
  let attempts = 0;
  await renameWithRetry('state.tmp', 'state.json', {
    rename: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('locked');
        error.code = 'EPERM';
        throw error;
      }
    },
    waitFor: async () => {}
  });
  assert.equal(attempts, 3);
});

test('前一次儲存失敗不會讓後續儲存佇列永久失效', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-state-recover-'));
  const state = new StateStore(directory);
  state.saveQueue = Promise.reject(new Error('previous failure'));
  state.data.seen.recovered = { lastSeen: new Date().toISOString() };
  await state.save();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.ok(saved.seen.recovered);
});

test('同一短時間內的狀態儲存會合併成一次精簡寫入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beyblade-state-coalesce-'));
  try {
    const state = new StateStore(directory, { saveDelayMs: 5 });
    state.data.seen.one = { lastSeen: new Date().toISOString() };
    await Promise.all([state.save(), state.save(), state.save(), state.save()]);

    const raw = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    assert.equal(JSON.parse(raw).seen.one.lastSeen, state.data.seen.one.lastSeen);
    assert.equal(state.getSaveStats().requested, 4);
    assert.equal(state.getSaveStats().writes, 1);
    assert.equal(state.getSaveStats().coalesced, 3);
    assert.doesNotMatch(raw, /\n\s{2}"seen"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
