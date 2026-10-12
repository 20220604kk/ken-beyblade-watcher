import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discordMonitoringActive,
  discordStatusChannelName,
  saleBoardPayload,
  syncDiscordSaleBoard,
  syncDiscordStatusChannel
} from '../src/discord-automation.js';

test('Discord 狀態頻道於 09:00～18:00 顯示運作中', () => {
  assert.equal(discordMonitoringActive(new Date('2026-07-31T01:00:00.000Z')), true);
  assert.equal(discordMonitoringActive(new Date('2026-07-31T10:00:00.000Z')), false);
  assert.equal(discordStatusChannelName(true), '🟢・監控運作中');
  assert.equal(discordStatusChannelName(false), '🔴・監控休息');
});

test('momo 待售看板包含圖片、價格與可能庫存', () => {
  const payload = saleBoardPayload([{
    enabled: true,
    siteName: 'momo購物網',
    name: 'BEYBLADE X UX-20',
    url: 'https://www.momoshop.com.tw/product/15462751',
    saleStartAt: '2026-08-02T16:00:00.000Z',
    imageUrl: 'https://example.com/ux20.webp',
    price: '$595',
    stock: null
  }], new Date('2026-07-31T00:00:00.000Z'));
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].thumbnail.url, 'https://example.com/ux20.webp');
  assert.match(payload.embeds[0].description, /\$595/);
  assert.match(payload.embeds[0].description, /（可能）庫存 待確認/);
});

test('momo 待售看板只建立一次，後續資料相同不洗版', async () => {
  const original = process.env.DISCORD_SALE_BOARD_WEBHOOK_URL;
  const originalFetch = global.fetch;
  process.env.DISCORD_SALE_BOARD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: 'message-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const state = {
    data: {},
    saves: 0,
    async save() { this.saves += 1; }
  };
  const reminders = [{
    enabled: true,
    siteName: 'momo購物網',
    name: 'UX-20',
    url: 'https://www.momoshop.com.tw/product/15462751',
    saleStartAt: '2026-08-02T16:00:00.000Z',
    price: '$595'
  }];
  try {
    const now = new Date('2026-07-31T00:00:00.000Z');
    await syncDiscordSaleBoard({ state, reminders, now });
    await syncDiscordSaleBoard({ state, reminders, now });
    assert.equal(calls.length, 1);
    assert.equal(state.saves, 1);
  } finally {
    global.fetch = originalFetch;
    if (original === undefined) delete process.env.DISCORD_SALE_BOARD_WEBHOOK_URL;
    else process.env.DISCORD_SALE_BOARD_WEBHOOK_URL = original;
  }
});

test('Discord Bot 會依時段切換監控狀態頻道名稱', async () => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  const originalChannel = process.env.DISCORD_STATUS_CHANNEL_ID;
  const originalFetch = global.fetch;
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.DISCORD_STATUS_CHANNEL_ID = '123456789';
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ name: '🔴・監控休息' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await syncDiscordStatusChannel({
      now: new Date('2026-07-31T10:00:00.000Z')
    });
    assert.equal(result.name, '🔴・監控休息');
    assert.equal(request.options.method, 'PATCH');
    assert.equal(JSON.parse(request.options.body).name, '🔴・監控休息');
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
    if (originalChannel === undefined) delete process.env.DISCORD_STATUS_CHANNEL_ID;
    else process.env.DISCORD_STATUS_CHANNEL_ID = originalChannel;
  }
});
