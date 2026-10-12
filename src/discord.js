const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
export const DISCORD_MESSAGE_SEPARATOR = '--------------------------------------------------';
export const DISCORD_AUDIENCES = new Set(['public', 'private', 'mmtoy', 'japan']);

function separatedContent(text, hasEmbeds) {
  const body = String(text || '').trim();
  if (!body) return undefined;
  if (hasEmbeds) return body.slice(0, 2000);
  const available = 2000 - DISCORD_MESSAGE_SEPARATOR.length - 1;
  return `${body.slice(0, available)}\n${DISCORD_MESSAGE_SEPARATOR}`;
}

function separatedEmbed(embed) {
  const description = String(embed?.description || '').trim();
  const available = 4096 - DISCORD_MESSAGE_SEPARATOR.length - 2;
  return {
    ...embed,
    description: description
      ? `${description.slice(0, available)}\n\n${DISCORD_MESSAGE_SEPARATOR}`
      : DISCORD_MESSAGE_SEPARATOR
  };
}

function normalizeAudience(value = 'public') {
  const audience = String(value || '').trim().toLowerCase();
  return DISCORD_AUDIENCES.has(audience) ? audience : 'public';
}

function webhookEnvironmentKey(audience = 'public') {
  const normalizedAudience = normalizeAudience(audience);
  if (normalizedAudience === 'private') return 'DISCORD_PRIVATE_WEBHOOK_URL';
  if (normalizedAudience === 'mmtoy') return 'DISCORD_MMTOY_WEBHOOK_URL';
  if (normalizedAudience === 'japan') return 'DISCORD_JAPAN_WEBHOOK_URL';
  return 'DISCORD_PUBLIC_WEBHOOK_URL';
}

function getWebhookUrl(audience = 'public') {
  const normalizedAudience = normalizeAudience(audience);
  const raw = normalizedAudience === 'private'
    ? process.env.DISCORD_PRIVATE_WEBHOOK_URL?.trim()
    : normalizedAudience === 'mmtoy'
      ? process.env.DISCORD_MMTOY_WEBHOOK_URL?.trim()
      : normalizedAudience === 'japan'
        ? process.env.DISCORD_JAPAN_WEBHOOK_URL?.trim()
      : (process.env.DISCORD_PUBLIC_WEBHOOK_URL?.trim() || process.env.DISCORD_WEBHOOK_URL?.trim());
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${webhookEnvironmentKey(normalizedAudience)} 不是有效網址`);
  }

  if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.has(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
    throw new Error(`${webhookEnvironmentKey(normalizedAudience)} 必須是 Discord 官方 Webhook 網址`);
  }
  return url;
}

export function hasDiscordWebhook(audience = 'public') {
  try {
    return Boolean(getWebhookUrl(audience));
  } catch {
    return false;
  }
}

function webhookDisplayName(audience, username) {
  const requested = String(username || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (requested) return requested;
  if (audience === 'mmtoy') return 'MM小舖獨立通知';
  if (audience === 'japan') return '日拍追蹤';
  return undefined;
}

export async function sendDiscordMessage(text, { embeds = [], discordAudience = 'public', username } = {}) {
  const audience = normalizeAudience(discordAudience);
  const webhook = getWebhookUrl(audience);
  if (!webhook) throw new Error(`尚未在 .env 設定 ${webhookEnvironmentKey(audience)}`);
  webhook.searchParams.set('wait', 'true');

  const payload = JSON.stringify({
    username: webhookDisplayName(audience, username),
    content: separatedContent(text, embeds.length > 0),
    embeds: embeds.slice(0, 10).map(separatedEmbed),
    allowed_mentions: { parse: [] }
  });
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(15000)
    });
    if (response.status !== 429 || attempt === 3) break;
    const rateLimit = await response.json().catch(() => ({}));
    const retryAfterMs = Math.max(50, Math.ceil(Number(rateLimit.retry_after ?? 1) * 1000));
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord Webhook ${response.status}: ${body.slice(0, 500)}`);
  }

  const message = await response.json().catch(() => ({}));
  return message.id || undefined;
}

export async function checkDiscordConnection(audience = 'public') {
  const normalizedAudience = normalizeAudience(audience);
  const webhook = getWebhookUrl(normalizedAudience);
  if (!webhook) throw new Error(`尚未設定 ${webhookEnvironmentKey(normalizedAudience)}`);
  const response = await fetch(webhook, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord Webhook ${response.status}: ${body.slice(0, 300)}`);
  }
  const info = await response.json();
  return {
    name: info.name || '',
    channelId: info.channel_id || '',
    guildId: info.guild_id || '',
    audience: normalizedAudience
  };
}
