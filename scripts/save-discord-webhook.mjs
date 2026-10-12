import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');
const value = String(process.env.DISCORD_WEBHOOK_URL || '').trim();

let url;
try {
  url = new URL(value);
} catch {
  throw new Error('剪貼簿不是有效的 Discord Webhook 網址');
}

if (
  url.protocol !== 'https:'
  || !['discord.com', 'discordapp.com'].includes(url.hostname)
  || !url.pathname.startsWith('/api/webhooks/')
) {
  throw new Error('剪貼簿不是 Discord 官方 Webhook 網址');
}

let current = '';
try {
  current = await fs.readFile(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const nextLine = `DISCORD_WEBHOOK_URL=${value}`;
const next = /^DISCORD_WEBHOOK_URL=.*$/m.test(current)
  ? current.replace(/^DISCORD_WEBHOOK_URL=.*$/m, nextLine)
  : `${nextLine}\n${current}`;

await fs.writeFile(envPath, next.replace(/\r?\n/g, '\n'), 'utf8');
console.log('Discord Webhook 已安全儲存。');
