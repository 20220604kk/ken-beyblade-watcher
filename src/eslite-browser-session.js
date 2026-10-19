// Same-account, first-party session import. No login, cart mutation or checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTH_NAMES = new Set(['auth._token.prd', 'auth._refresh_token.prd', 'auth.strategy', 'auth._strategy',
  'auth._token_expiration.prd', 'auth._refresh_token_expiration.prd']);
const DOMAINS = new Set(['eslite.com', 'www.eslite.com', 'athena.eslite.com']);
const ORIGIN = 'https://www.eslite.com';
const problem = message => Object.assign(new Error(message), { purchaseStatus: 'needs_login' });

export function esliteBrowserTokenExpiry(value) {
  try {
    const raw = decodeURIComponent(String(value || '')).replace(/^Bearer\s+/i, '');
    const exp = Number(JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString()).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch { return 0; }
}

export function normalizeEsliteBrowserSession(input, now = Date.now()) {
  if (!input || !Array.isArray(input.cookies) || !Array.isArray(input.origins)) throw problem('登入資料格式不完整，未覆寫既有登入');
  if (JSON.stringify(input).length > 60000) throw problem('登入資料過大，未覆寫既有登入');
  const cookies = input.cookies.filter(c => AUTH_NAMES.has(c?.name)
    && DOMAINS.has(String(c.domain || '').replace(/^\./, ''))).map(c => {
    if (typeof c.value !== 'string' || c.value.length > 16000 || /[\r\n]/.test(c.value)) throw problem('登入 Cookie 格式無效');
    return { name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: Number.isFinite(c.expires) ? c.expires : -1, httpOnly: Boolean(c.httpOnly), secure: true,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax' };
  });
  const storage = input.origins.filter(o => o?.origin === ORIGIN).flatMap(o => o.localStorage || [])
    .filter(e => AUTH_NAMES.has(e?.name)).map(e => {
      if (typeof e.value !== 'string' || e.value.length > 16000) throw problem('登入儲存資料格式無效');
      return { name: e.name, value: e.value };
    });
  const tokens = [...cookies, ...storage].filter(e => e.name === 'auth._token.prd')
    .map(e => ({ value: e.value, expiresAtMs: esliteBrowserTokenExpiry(e.value) })).sort((a, b) => b.expiresAtMs - a.expiresAtMs);
  const token = tokens[0];
  if (!token?.expiresAtMs || token.expiresAtMs <= now + 60000) throw problem('普通 Chrome 的登入憑證已過期或即將到期，未覆寫既有登入');
  // Normalize the site's own token into its official localStorage key as well.
  // This does not extend expiry or mint a new credential.
  const localStorage = storage.filter(e => e.name !== 'auth._token.prd');
  localStorage.push({ name: 'auth._token.prd', value: decodeURIComponent(token.value) });
  return { state: { cookies, origins: [{ origin: ORIGIN, localStorage }] }, expiresAtMs: token.expiresAtMs };
}

export async function saveEsliteBrowserSession(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.import.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
