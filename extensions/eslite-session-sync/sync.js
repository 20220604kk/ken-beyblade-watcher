export async function syncEsliteSession({ chrome, fetch, now = Date.now }) {
  const settings = await chrome.storage.local.get(['slot', 'token', 'enabled', 'fingerprint', 'retryAt']);
  if (!settings.enabled || !settings.token || !settings.slot || now() < (settings.retryAt || 0)) return;
  const allowed = ['auth._token.prd', 'auth._refresh_token.prd', 'auth.strategy'];
  const cookies = (await chrome.cookies.getAll({ url: 'https://www.eslite.com/' }))
    .filter(c => allowed.includes(c.name) && ['eslite.com', '.eslite.com', 'www.eslite.com', '.www.eslite.com'].includes(c.domain))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expirationDate || -1,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: { strict: 'Strict', lax: 'Lax', no_restriction: 'None' }[c.sameSite] || 'Lax' }));
  const auth = cookies.find(c => c.name === 'auth._token.prd'); if (!auth) return;
  // Persist only a fingerprint, never an extra copy of the website Token.
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settings.slot + auth.value))))
    .map(n => n.toString(16).padStart(2, '0')).join('');
  if (fingerprint === settings.fingerprint) return;
  try {
    const response = await fetch('http://127.0.0.1:3210/eslite-browser/import', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.token },
      body: JSON.stringify({ accountSlot: settings.slot, storageState: { cookies, origins: [] } }), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('not confirmed');
    await chrome.storage.local.set({ fingerprint, lastSyncAt: new Date(now()).toISOString(), expiresAt: result.expiresAt, lastError: '', retryAt: 0 });
  } catch {
    await chrome.storage.local.set({ lastError: '未同步：請核對前端登入與選定帳號是否相同；60 秒後再查', retryAt: now() + 60000 });
  }
}
