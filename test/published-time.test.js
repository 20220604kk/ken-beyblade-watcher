import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPostNotification } from '../src/line.js';
import { StateStore } from '../src/state.js';

function createPost(overrides = {}) {
  return {
    pageName: 'FunBox-環球桃園A19',
    pageUrl: 'https://www.facebook.com/profile.php?id=100083960592067',
    postUrl: 'https://www.facebook.com/permalink.php?story_fbid=test&id=100083960592067',
    matchedKeywords: ['戰鬥陀螺', '抽選', '報名'],
    formUrls: ['https://example.com/form'],
    detectedAt: '2026-07-15T04:05:31.000Z',
    ...overrides
  };
}

test('LINE 通知優先顯示 Facebook 精準發布時間，而不是首次偵測時間', () => {
  const message = formatPostNotification(createPost({
    publishedAt: '2026-07-15T04:00:00.000Z'
  }));

  assert.match(message, /時間：2026\/07\/15 12:00/);
  assert.doesNotMatch(message, /時間：2026\/07\/15 12:05/);
});

test('舊資料沒有 publishedAt 時仍以 detectedAt 顯示時間', () => {
  const message = formatPostNotification(createPost());

  assert.match(message, /時間：2026\/07\/15 12:05/);
});

test('貼文狀態可分別保存發布、首次偵測與成功通知時間，後續掃描不會清除', () => {
  const state = new StateStore('unused-for-unit-test');
  const publishedAt = '2026-07-15T04:00:00.000Z';
  const firstDetectedAt = '2026-07-15T04:05:31.000Z';
  const notifiedAt = '2026-07-15T04:05:33.000Z';

  state.mark('post-1', { publishedAt, firstDetectedAt });
  state.mark('post-1', { notifiedAt, lineRequestId: 'line-request-123' });
  state.mark('post-1', { pageName: 'FunBox-環球桃園A19', relevant: true });

  assert.equal(state.data.seen['post-1'].publishedAt, publishedAt);
  assert.equal(state.data.seen['post-1'].firstDetectedAt, firstDetectedAt);
  assert.equal(state.data.seen['post-1'].notifiedAt, notifiedAt);
  assert.equal(state.data.seen['post-1'].lineRequestId, 'line-request-123');
});
