import { checkDiscordConnection, hasDiscordWebhook, sendDiscordMessage } from './discord.js';
import { checkLineConnection, hasLineToken, sendLineMessage } from './line.js';
import { recordNotificationDuration } from './notification-metrics.js';

export const NOTIFICATION_MODES = new Set(['auto', 'line', 'discord', 'both']);

export function normalizeNotificationMode(value, fallback = 'auto') {
  const mode = String(value || '').trim().toLowerCase();
  return NOTIFICATION_MODES.has(mode) ? mode : fallback;
}

function selectedChannels(mode = 'auto', discordAudience = 'public') {
  const normalized = normalizeNotificationMode(mode);
  if (normalized === 'line') return ['line'];
  if (normalized === 'discord') return ['discord'];
  if (normalized === 'both') return ['discord', 'line'];
  if (hasDiscordWebhook(discordAudience)) return ['discord'];
  if (hasLineToken()) return ['line'];
  return [];
}

export function notificationAvailability() {
  return {
    discord: hasDiscordWebhook('public'),
    discordPublic: hasDiscordWebhook('public'),
    discordPrivate: hasDiscordWebhook('private'),
    discordMmtoy: hasDiscordWebhook('mmtoy'),
    discordJapan: hasDiscordWebhook('japan'),
    line: hasLineToken()
  };
}

export function notificationChannelName(mode = 'auto', { discordAudience = 'public' } = {}) {
  const channels = selectedChannels(mode, discordAudience);
  if (channels.length === 2) return 'Discord + LINE';
  if (channels[0] === 'discord') return 'Discord';
  if (channels[0] === 'line') return 'LINE';
  return '未設定';
}

export function hasNotificationConfig(mode = 'auto', { discordAudience = 'public' } = {}) {
  const channels = selectedChannels(mode, discordAudience);
  if (!channels.length) return false;
  return channels.every((channel) => channel === 'discord' ? hasDiscordWebhook(discordAudience) : hasLineToken());
}

export async function checkNotificationConnection(mode = 'auto', { discordAudience = 'public' } = {}) {
  const channels = selectedChannels(mode, discordAudience);
  if (!channels.length) throw new Error('尚未設定通知通道');
  const details = [];
  for (const channel of channels) {
    if (channel === 'discord') {
      const info = await checkDiscordConnection(discordAudience);
      details.push(info.name || info.channelId || 'Discord Webhook');
    } else {
      const info = await checkLineConnection();
      details.push(info.displayName || info.basicId || 'LINE 官方帳號');
    }
  }
  return {
    channel: notificationChannelName(mode, { discordAudience }),
    displayName: details.join(' + ')
  };
}

export async function sendNotification(text, options = {}) {
  const mode = normalizeNotificationMode(options.channelMode);
  const discordAudience = ['private', 'mmtoy', 'japan'].includes(options.discordAudience)
    ? options.discordAudience
    : 'public';
  const channels = selectedChannels(mode, discordAudience);
  if (!channels.length) throw new Error('尚未設定通知通道');
  if (channels.includes('discord') && !hasDiscordWebhook(discordAudience)) {
    const key = discordAudience === 'private'
      ? 'DISCORD_PRIVATE_WEBHOOK_URL'
      : discordAudience === 'mmtoy'
        ? 'DISCORD_MMTOY_WEBHOOK_URL'
        : discordAudience === 'japan'
          ? 'DISCORD_JAPAN_WEBHOOK_URL'
          : 'DISCORD_PUBLIC_WEBHOOK_URL';
    throw new Error(`目前選擇 Discord，但尚未設定 ${key}`);
  }
  if (channels.includes('line') && !hasLineToken()) {
    throw new Error('目前選擇 LINE，但尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
  }

  const startedAt = performance.now();
  let results;
  try {
    results = await Promise.all(channels.map(async (channel) => ({
    channel,
    id: channel === 'discord'
      ? await sendDiscordMessage(options.discordPreview || text, { ...options, discordAudience })
      : await sendLineMessage(text)
    })));
    recordNotificationDuration(performance.now() - startedAt, true);
  } catch (error) {
    recordNotificationDuration(performance.now() - startedAt, false);
    throw error;
  }
  if (results.length === 1) return results[0].id;
  return results.map((result) => `${result.channel === 'discord' ? 'Discord' : 'LINE'}:${result.id || 'ok'}`).join(' | ');
}
