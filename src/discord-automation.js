import { createHash } from 'node:crypto';

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com']);
const STATUS_ACTIVE_NAME = '🟢・監控運作中';
const STATUS_REST_NAME = '🔴・監控休息';

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function webhookUrl(name) {
  const raw = envValue(name);
  if (!raw) return null;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== 'https:'
    || !DISCORD_HOSTS.has(parsed.hostname)
    || !parsed.pathname.startsWith('/api/webhooks/')
  ) {
    throw new Error(`${name} 不是有效的 Discord Webhook 網址`);
  }
  return parsed;
}

function taipeiParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function minutesOfDay(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function discordMonitoringActive(now = new Date(), start = '09:00', end = '18:00') {
  const current = taipeiParts(now);
  const currentMinutes = current.hour * 60 + current.minute;
  const startMinutes = minutesOfDay(start) ?? 9 * 60;
  const endMinutes = minutesOfDay(end) ?? 18 * 60;
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function discordStatusChannelName(active) {
  return active ? STATUS_ACTIVE_NAME : STATUS_REST_NAME;
}

function formatTaipei(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value)).replace(/\s+/g, ' ');
}

function possibleStock(reminder) {
  const value = reminder?.stock;
  if (value === null || value === undefined || value === '') return '待確認';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString('zh-TW') : '待確認';
}

export function saleBoardPayload(reminders, now = new Date()) {
  const current = now.getTime();
  const pending = reminders
    .filter((reminder) =>
      reminder.enabled !== false
      && /momo/i.test(`${reminder.siteName || ''} ${reminder.url || ''}`)
      && Number.isFinite(Date.parse(reminder.saleStartAt))
      && Date.parse(reminder.saleStartAt) > current
    )
    .sort((left, right) => Date.parse(left.saleStartAt) - Date.parse(right.saleStartAt))
    .slice(0, 10);

  if (!pending.length) {
    return {
      content: '目前沒有等待開賣的 momo 商品。',
      embeds: [],
      allowed_mentions: { parse: [] }
    };
  }

  return {
    content: `🛒 **momo 待售商品**｜共 ${pending.length} 項｜依開賣時間排序`,
    embeds: pending.map((reminder) => {
      const embed = {
        title: reminder.name || '未命名商品',
        url: reminder.url,
        color: 0xff6b00,
        description: [
          `⏰ **${formatTaipei(reminder.saleStartAt)} 開賣**`,
          `💰 **${reminder.price || '價格待公布'}**`,
          `📦 **（可能）庫存 ${possibleStock(reminder)}**`,
          '',
          `[前往 momo 賣場](${reminder.url})`
        ].join('\n'),
        footer: { text: '陀螺通知監控儀表｜資料以賣場當下顯示為準' }
      };
      if (reminder.imageUrl) embed.thumbnail = { url: reminder.imageUrl };
      return embed;
    }),
    allowed_mentions: { parse: [] }
  };
}

function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function webhookRequest(url, method, payload) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord Webhook ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.status === 204 ? {} : response.json().catch(() => ({}));
}

export async function syncDiscordSaleBoard({ state, reminders, now = new Date() }) {
  const hook = webhookUrl('DISCORD_SALE_BOARD_WEBHOOK_URL');
  if (!hook) return { configured: false, changed: false };

  state.data.discordAutomation ||= {};
  const record = state.data.discordAutomation.saleBoard ||= {};
  const payload = saleBoardPayload(reminders, now);
  const hash = payloadHash(payload);
  if (record.hash === hash && record.messageId) {
    return { configured: true, changed: false, messageId: record.messageId };
  }

  let message;
  if (record.messageId) {
    const editUrl = new URL(hook);
    editUrl.pathname = `${editUrl.pathname}/messages/${record.messageId}`;
    message = await webhookRequest(editUrl, 'PATCH', payload);
  } else {
    const createUrl = new URL(hook);
    createUrl.searchParams.set('wait', 'true');
    message = await webhookRequest(createUrl, 'POST', payload);
  }

  record.messageId = message.id || record.messageId;
  record.hash = hash;
  record.updatedAt = now.toISOString();
  await state.save();
  return { configured: true, changed: true, messageId: record.messageId };
}

export async function syncDiscordStatusChannel({
  now = new Date(),
  activeStart = '09:00',
  activeEnd = '18:00'
} = {}) {
  const botToken = envValue('DISCORD_BOT_TOKEN');
  const channelId = envValue('DISCORD_STATUS_CHANNEL_ID');
  if (!botToken || !channelId) return { configured: false, changed: false };

  const active = discordMonitoringActive(now, activeStart, activeEnd);
  const name = discordStatusChannelName(active);
  const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord 頻道狀態更新 ${response.status}: ${body.slice(0, 300)}`);
  }
  const channel = await response.json();
  return { configured: true, changed: channel.name === name, active, name };
}

