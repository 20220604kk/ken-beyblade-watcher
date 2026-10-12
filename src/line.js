const ENDPOINT = 'https://api.line.me/v2/bot/message/broadcast';

export function hasLineToken() {
  return Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim());
}

export async function sendLineMessage(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('尚未在 .env 設定 LINE_CHANNEL_ACCESS_TOKEN');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [{ type: 'text', text: text.slice(0, 4900) }],
      notificationDisabled: false
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE API ${response.status}: ${body.slice(0, 500)}`);
  }

  const requestId = response.headers.get('x-line-request-id')?.trim();
  return requestId || undefined;
}

export async function checkLineConnection() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
  const response = await fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE API ${response.status}: ${body.slice(0, 300)}`);
  }
  const info = await response.json();
  return { displayName: info.displayName || '', basicId: info.basicId || '' };
}

export function formatTaipeiTime(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function compactText(value, maxLength = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function facebookDiscordPreview(post, { test = false } = {}) {
  const pageName = compactText(post.pageName || 'Facebook 店家', 42);
  const keywords = compactText(post.matchedKeywords?.join('、') || '表單連結', 70);
  return [
    `${test ? '🧪 FB 通知測試' : '🚨 FB 販售情報'}｜${pageName}`,
    `命中：${keywords}`
  ].join('\n');
}

export function formatPostNotification(post) {
  const message = [
    '🚨 戰鬥陀螺販售情報',
    `店家：${post.pageName}`,
    `關鍵字：${post.matchedKeywords.join('、') || '表單連結'}`,
    `時間：${formatTaipeiTime(post.publishedAt || post.detectedAt)}`
  ];
  if (post.formUrls.length) {
    message.push('', '📝 立即開啟表單', post.formUrls[0]);
  }
  message.push('', 'Facebook 原文', post.postUrl || post.pageUrl);
  return message.join('\n');
}

export function facebookPostEmbed(post, { test = false } = {}) {
  const postUrl = post.postUrl || post.pageUrl;
  const pageName = compactText(post.pageName || 'Facebook 店家', 80);
  const lines = [
    `**命中關鍵字：** ${post.matchedKeywords.join('、') || '表單連結'}`,
    `**貼文時間：** ${formatTaipeiTime(post.publishedAt || post.detectedAt)}`,
    ''
  ];
  if (post.formUrls.length) lines.push(`**📝 表單：** [立即開啟表單](${post.formUrls[0]})`);
  if (postUrl) lines.push(`**Facebook：** [查看原始貼文](${postUrl})`);
  return {
    author: { name: '陀螺通知監控儀表・Facebook' },
    title: `${test ? '🧪 FB 通知測試' : '🚨 FB 販售情報'}｜${pageName}`,
    url: postUrl || undefined,
    color: 0x1877f2,
    description: lines.join('\n'),
    footer: { text: test ? 'FB 通知測試・不是真實販售' : 'Facebook 販售情報即時通知' },
    timestamp: new Date().toISOString()
  };
}
