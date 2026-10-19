// Only first-party authentication state. Never clear anti-bot/trust cookies,
// all localStorage, a browser profile, cart state, or saved checkout templates.
export const ESLITE_AUTH_KEYS = ['auth._token.prd', 'auth._refresh_token.prd', 'auth.strategy', 'auth._strategy',
  'auth._token_expiration.prd', 'auth._refresh_token_expiration.prd'];
const authKeys = new Set(ESLITE_AUTH_KEYS);
const domains = new Set(['eslite.com', 'www.eslite.com', 'athena.eslite.com']);

function tokenExpiry(value) {
  try {
    const raw=decodeURIComponent(String(value || '')).replace(/^Bearer\s+/i,'');
    const seconds=Number(JSON.parse(Buffer.from(raw.split('.')[1],'base64url').toString('utf8')).exp);
    return Number.isFinite(seconds)&&seconds>0?seconds*1000:0;
  } catch {return 0;}
}

// Runs once, at the official origin, before its application scripts. Re-check
// the actual stored token there: a fresh token must never be erased merely
// because the saved session file was old or the first blank tab had no token.
export function clearExpiredEsliteLocalAuthOnce({names,marker}) {
  if(location.origin!=='https://www.eslite.com'||sessionStorage.getItem(marker)!==null)return;
  sessionStorage.setItem(marker,'0');
  let expiry=0;
  try {
    const raw=decodeURIComponent(localStorage.getItem('auth._token.prd')||'').replace(/^Bearer\s+/i,'');
    expiry=Number(JSON.parse(atob(raw.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp)*1000;
  }catch{return;}
  if(!Number.isFinite(expiry)||expiry<=0||expiry>Date.now())return;
  let removed=0;
  for(const name of names){if(localStorage.getItem(name)!==null){localStorage.removeItem(name);removed++;}}
  sessionStorage.setItem(marker,String(removed));
}

export async function prepareExpiredEsliteAuthBeforeNavigation({page,context,marker,now=Date.now()}) {
  if(!marker||typeof marker!=='string')throw new Error('缺少本次登入清理識別，不清除');
  if(page.url()!=='about:blank'&&new URL(page.url()).origin!=='https://www.eslite.com')throw new Error('非誠品登入頁或空白頁，不準備登入清理');
  const state=await context.storageState({indexedDB:true});
  const ownCookies=(state.cookies||[]).filter(cookie=>domains.has(String(cookie.domain||'').replace(/^\./,'')));
  const access=ownCookies.filter(cookie=>cookie.name==='auth._token.prd');
  const local=(state.origins||[]).filter(origin=>origin.origin==='https://www.eslite.com').flatMap(origin=>origin.localStorage||[]).filter(entry=>entry.name==='auth._token.prd');
  if([...access,...local].some(entry=>tokenExpiry(entry.value)>now))return{cookies:0,localCleanupArmed:false,preservedValidToken:true};
  // Only scopes with their own provably expired access token lose auth cookies.
  // Missing/malformed tokens or a different site's cookies are not proof.
  const expiredScopes=new Set(access.filter(cookie=>tokenExpiry(cookie.value)>0&&tokenExpiry(cookie.value)<=now).map(cookie=>cookie.domain+'\n'+(cookie.path||'/')));
  const stale=ownCookies.filter(cookie=>authKeys.has(cookie.name)&&expiredScopes.has(cookie.domain+'\n'+(cookie.path||'/')));
  for(const cookie of stale)await context.clearCookies({name:cookie.name,domain:cookie.domain,path:cookie.path||'/'});
  const localCleanupArmed=typeof page.addInitScript==='function';
  if(localCleanupArmed)await page.addInitScript(clearExpiredEsliteLocalAuthOnce,{names:ESLITE_AUTH_KEYS,marker});
  return{cookies:stale.length,localCleanupArmed,preservedValidToken:false};
}

export async function clearInvalidEsliteAuth({ page, context, confirmedInvalid = false }) {
  if (!confirmedInvalid) throw new Error('尚未確認登入憑證失效，不清除');
  if (new URL(page.url()).origin !== 'https://www.eslite.com') throw new Error('非誠品官網，不清除登入資料');
  const state = await context.storageState({ indexedDB: true });
  const cookies = (state.cookies || []).filter(c => authKeys.has(c.name) && domains.has(String(c.domain || '').replace(/^\./, '')));
  const entries = (state.origins || []).filter(o => o.origin === 'https://www.eslite.com')
    .flatMap(o => o.localStorage || []).filter(e => authKeys.has(e.name));
  for (const cookie of cookies) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path || '/' });
  if (entries.length) await page.evaluate(names => {
    if (location.origin !== 'https://www.eslite.com') throw new Error('誠品登入頁已離開，停止清理');
    for (const name of names) localStorage.removeItem(name);
  }, ESLITE_AUTH_KEYS);
  return { cookies: cookies.length, entries: entries.length };
}

// Import once per tab; never re-install an old token after official login,
// logout, or another navigation. The marker contains no credentials.
export function seedEsliteAuthOnce({ origin, entries, marker }) {
  if (location.origin !== origin || sessionStorage.getItem(marker)) return;
  sessionStorage.setItem(marker, '1');
  const expiry = value => {
    try { return Number(JSON.parse(atob(String(value || '').replace(/^Bearer\s+/i, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp) || 0; }
    catch { return 0; }
  };
  const currentExpiry = expiry(localStorage.getItem('auth._token.prd'));
  const incomingExpiry = expiry(entries.find(item => item.name === 'auth._token.prd')?.value);
  if (currentExpiry >= incomingExpiry || incomingExpiry * 1000 <= Date.now()) return;
  for (const item of entries) localStorage.setItem(item.name, item.value);
}
