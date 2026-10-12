import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facebookDiscordPreview, facebookPostEmbed, formatPostNotification, sendLineMessage
} from '../src/line.js';

test('貼文通知包含店家、關鍵字、表單與原文連結', () => {
  const message = formatPostNotification({
    pageName: '測試店家',
    pageUrl: 'https://www.facebook.com/test',
    postUrl: 'https://www.facebook.com/test/posts/123',
    matchedKeywords: ['戰鬥陀螺', '抽選'],
    formUrls: ['https://example.com/form'],
    text: '測試貼文摘要',
    detectedAt: '2026-07-14T04:53:00.000Z'
  });
  assert.match(message, /測試店家/);
  assert.match(message, /關鍵字：戰鬥陀螺、抽選/);
  assert.match(message, /時間：2026\/07\/14 12:53/);
  assert.match(message, /戰鬥陀螺、抽選/);
  assert.match(message, /https:\/\/example\.com\/form/);
  assert.match(message, /posts\/123/);
  assert.doesNotMatch(message, /貼文摘要/);
  assert.doesNotMatch(message, /測試貼文摘要/);
});

test('FB Discord 手機摘要第一行直接顯示來源與店家', () => {
  const post = {
    pageName: '方爸測試',
    pageUrl: 'https://www.facebook.com/test',
    postUrl: 'https://www.facebook.com/test/posts/123',
    matchedKeywords: ['戰鬥陀螺', '抽選', '報名'],
    formUrls: ['https://example.com/form'],
    detectedAt: '2026-07-14T04:53:00.000Z'
  };
  assert.equal(
    facebookDiscordPreview(post),
    '🚨 FB 販售情報｜方爸測試\n命中：戰鬥陀螺、抽選、報名'
  );
  const embed = facebookPostEmbed(post);
  assert.equal(embed.title, '🚨 FB 販售情報｜方爸測試');
  assert.match(embed.description, /📝 表單/);
  assert.match(embed.description, /查看原始貼文/);
});

test('LINE 推播成功時回傳 x-line-request-id', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: { 'x-line-request-id': 'line-request-123' }
  });

  try {
    assert.equal(await sendLineMessage('測試通知'), 'line-request-123');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
  }
});

test('LINE 回應未提供 request id 時回傳 undefined', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  globalThis.fetch = async () => new Response(null, { status: 200 });

  try {
    assert.equal(await sendLineMessage('測試通知'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
  }
});
