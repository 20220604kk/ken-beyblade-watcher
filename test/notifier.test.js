import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasNotificationConfig, normalizeNotificationMode, notificationChannelName, sendNotification
} from '../src/notifier.js';

test('通知模式可分別選擇 LINE、Discord 或同時通知', async () => {
  const previousFetch = global.fetch;
  const previousDiscord = process.env.DISCORD_WEBHOOK_URL;
  const previousLine = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const requests = [];
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/test-token';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'line-test-token';
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('discord.com')) {
      return new Response(JSON.stringify({ id: 'discord-message' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('', {
      status: 200,
      headers: { 'x-line-request-id': 'line-request' }
    });
  };
  try {
    assert.equal(notificationChannelName('line'), 'LINE');
    assert.equal(notificationChannelName('discord'), 'Discord');
    assert.equal(notificationChannelName('both'), 'Discord + LINE');
    assert.equal(hasNotificationConfig('both'), true);
    assert.equal(normalizeNotificationMode('unknown', 'discord'), 'discord');

    const result = await sendNotification('雙通道完整測試', {
      channelMode: 'both',
      discordPreview: 'Discord 手機摘要'
    });
    assert.equal(requests.length, 2);
    const discordPayload = JSON.parse(
      requests.find((request) => request.url.includes('discord.com')).options.body
    );
    const linePayload = JSON.parse(
      requests.find((request) => request.url.includes('api.line.me')).options.body
    );
    assert.match(discordPayload.content, /^Discord 手機摘要/);
    assert.match(linePayload.messages[0].text, /^雙通道完整測試/);
    assert.match(result, /Discord:discord-message/);
    assert.match(result, /LINE:line-request/);
  } finally {
    global.fetch = previousFetch;
    if (previousDiscord === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previousDiscord;
    if (previousLine === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = previousLine;
  }
});

test('私人操作通知不會誤送到公開 Discord Webhook', async () => {
  const previousFetch = global.fetch;
  const previousPublic = process.env.DISCORD_WEBHOOK_URL;
  const previousPrivate = process.env.DISCORD_PRIVATE_WEBHOOK_URL;
  const requests = [];
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/public-token';
  process.env.DISCORD_PRIVATE_WEBHOOK_URL = 'https://discord.com/api/webhooks/222/private-token';
  global.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ id: 'private-result' });
  };

  try {
    const result = await sendNotification('三組速填結果', {
      channelMode: 'discord',
      discordAudience: 'private'
    });
    assert.equal(result, 'private-result');
    assert.equal(requests.length, 1);
    assert.match(requests[0], /webhooks\/222\/private-token/);
    assert.doesNotMatch(requests[0], /public-token/);
  } finally {
    global.fetch = previousFetch;
    if (previousPublic === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previousPublic;
    if (previousPrivate === undefined) delete process.env.DISCORD_PRIVATE_WEBHOOK_URL;
    else process.env.DISCORD_PRIVATE_WEBHOOK_URL = previousPrivate;
  }
});

test('M.M小舖通知不會誤送到公開或私人 Discord Webhook', async () => {
  const previousFetch = global.fetch;
  const previousPublic = process.env.DISCORD_WEBHOOK_URL;
  const previousPrivate = process.env.DISCORD_PRIVATE_WEBHOOK_URL;
  const previousMmtoy = process.env.DISCORD_MMTOY_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/public-token';
  process.env.DISCORD_PRIVATE_WEBHOOK_URL = 'https://discord.com/api/webhooks/222/private-token';
  process.env.DISCORD_MMTOY_WEBHOOK_URL = 'https://discord.com/api/webhooks/333/mmtoy-token';
  let requestUrl = '';
  global.fetch = async (url) => {
    requestUrl = String(url);
    return Response.json({ id: 'mmtoy-result' });
  };

  try {
    const result = await sendNotification('M.M小舖新品', {
      channelMode: 'discord',
      discordAudience: 'mmtoy'
    });
    assert.equal(result, 'mmtoy-result');
    assert.match(requestUrl, /webhooks\/333\/mmtoy-token/);
    assert.doesNotMatch(requestUrl, /public-token|private-token/);
  } finally {
    global.fetch = previousFetch;
    if (previousPublic === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previousPublic;
    if (previousPrivate === undefined) delete process.env.DISCORD_PRIVATE_WEBHOOK_URL;
    else process.env.DISCORD_PRIVATE_WEBHOOK_URL = previousPrivate;
    if (previousMmtoy === undefined) delete process.env.DISCORD_MMTOY_WEBHOOK_URL;
    else process.env.DISCORD_MMTOY_WEBHOOK_URL = previousMmtoy;
  }
});

test('日本拍賣通知只會使用日拍 Webhook', async () => {
  const previousFetch = global.fetch;
  const previousPublic = process.env.DISCORD_WEBHOOK_URL;
  const previousPrivate = process.env.DISCORD_PRIVATE_WEBHOOK_URL;
  const previousJapan = process.env.DISCORD_JAPAN_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/public-token';
  process.env.DISCORD_PRIVATE_WEBHOOK_URL = 'https://discord.com/api/webhooks/222/private-token';
  process.env.DISCORD_JAPAN_WEBHOOK_URL = 'https://discord.com/api/webhooks/444/japan-token';
  let requestUrl = '';
  global.fetch = async (url) => {
    requestUrl = String(url);
    return Response.json({ id: 'japan-result' });
  };

  try {
    const result = await sendNotification('1999 UX-15 恢復販售', {
      channelMode: 'discord',
      discordAudience: 'japan'
    });
    assert.equal(result, 'japan-result');
    assert.match(requestUrl, /webhooks\/444\/japan-token/);
    assert.doesNotMatch(requestUrl, /public-token|private-token/);
  } finally {
    global.fetch = previousFetch;
    if (previousPublic === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previousPublic;
    if (previousPrivate === undefined) delete process.env.DISCORD_PRIVATE_WEBHOOK_URL;
    else process.env.DISCORD_PRIVATE_WEBHOOK_URL = previousPrivate;
    if (previousJapan === undefined) delete process.env.DISCORD_JAPAN_WEBHOOK_URL;
    else process.env.DISCORD_JAPAN_WEBHOOK_URL = previousJapan;
  }
});
