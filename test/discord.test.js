import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDiscordConnection, DISCORD_MESSAGE_SEPARATOR, sendDiscordMessage
} from '../src/discord.js';

test('Discord Webhook 送出訊息並回傳訊息 ID', async () => {
  const originalFetch = global.fetch;
  const originalWebhook = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ id: 'discord-message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const id = await sendDiscordMessage('測試', {
      embeds: [{ title: '新品' }]
    });
    assert.equal(id, 'discord-message-1');
    assert.match(request.url, /wait=true/);
    const body = JSON.parse(request.options.body);
    assert.equal(body.content, '測試');
    assert.equal(body.embeds[0].title, '新品');
    assert.equal(body.embeds[0].description, DISCORD_MESSAGE_SEPARATOR);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.username, undefined);
  } finally {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  }
});

test('Discord 純文字通知只在最底部加入分隔線', async () => {
  const originalFetch = global.fetch;
  const originalWebhook = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ id: 'discord-message-2' });
  };

  try {
    await sendDiscordMessage('陀螺通知監控儀表');
    assert.equal(
      payload.content,
      `陀螺通知監控儀表\n${DISCORD_MESSAGE_SEPARATOR}`
    );
    assert.doesNotMatch(payload.content, /^-/);
  } finally {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  }
});

test('Discord 連線檢查不會送出訊息', async () => {
  const originalFetch = global.fetch;
  const originalWebhook = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
  global.fetch = async (_url, options = {}) => {
    assert.equal(options.method, undefined);
    return new Response(JSON.stringify({ name: '陀螺通知', channel_id: '456' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    assert.deepEqual(await checkDiscordConnection(), {
      name: '陀螺通知',
      channelId: '456',
      guildId: '',
      audience: 'public'
    });
  } finally {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  }
});

test('私人 Discord 通知只會使用私人 Webhook', async () => {
  const originalFetch = global.fetch;
  const originalPrivateWebhook = process.env.DISCORD_PRIVATE_WEBHOOK_URL;
  process.env.DISCORD_PRIVATE_WEBHOOK_URL = 'https://discord.com/api/webhooks/789/private-token';
  let requestUrl = '';
  global.fetch = async (url) => {
    requestUrl = String(url);
    return Response.json({ id: 'private-message' });
  };

  try {
    const id = await sendDiscordMessage('私人速填結果', { discordAudience: 'private' });
    assert.equal(id, 'private-message');
    assert.match(requestUrl, /webhooks\/789\/private-token/);
  } finally {
    global.fetch = originalFetch;
    if (originalPrivateWebhook === undefined) delete process.env.DISCORD_PRIVATE_WEBHOOK_URL;
    else process.env.DISCORD_PRIVATE_WEBHOOK_URL = originalPrivateWebhook;
  }
});

test('M.M小舖 Discord 通知只會使用獨立 Webhook', async () => {
  const originalFetch = global.fetch;
  const originalWebhook = process.env.DISCORD_MMTOY_WEBHOOK_URL;
  process.env.DISCORD_MMTOY_WEBHOOK_URL = 'https://discord.com/api/webhooks/990/mmtoy-token';
  let requestUrl = '';
  let payload;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    payload = JSON.parse(options.body);
    return Response.json({ id: 'mmtoy-message' });
  };

  try {
    const id = await sendDiscordMessage('M.M小舖補貨', { discordAudience: 'mmtoy' });
    assert.equal(id, 'mmtoy-message');
    assert.match(requestUrl, /webhooks\/990\/mmtoy-token/);
    assert.equal(payload.username, 'MM小舖獨立通知');
  } finally {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_MMTOY_WEBHOOK_URL;
    else process.env.DISCORD_MMTOY_WEBHOOK_URL = originalWebhook;
  }
});

test('Discord Webhook 遇到 429 會等待後重送', async () => {
  const originalFetch = global.fetch;
  const originalWebhook = process.env.DISCORD_MMTOY_WEBHOOK_URL;
  process.env.DISCORD_MMTOY_WEBHOOK_URL = 'https://discord.com/api/webhooks/990/mmtoy-token';
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return Response.json({ retry_after: 0 }, { status: 429 });
    }
    return Response.json({ id: 'retry-success' });
  };

  try {
    const id = await sendDiscordMessage('大量補貨', { discordAudience: 'mmtoy' });
    assert.equal(id, 'retry-success');
    assert.equal(attempts, 2);
  } finally {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_MMTOY_WEBHOOK_URL;
    else process.env.DISCORD_MMTOY_WEBHOOK_URL = originalWebhook;
  }
});
